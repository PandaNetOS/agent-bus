/**
 * tools/stress.mjs — bus.ps1 写压测（不丢不重）
 *
 *   node tools/stress.mjs                      默认 10 进程 × 30 条 = 300 条
 *   node tools/stress.mjs --procs 10 --per 30  显式指定
 *   node tools/stress.mjs --root D:\test\x     换压测目录（默认 D:\test\bus-stress）
 *
 * 验的是写入原语的四条失败路径，不是 happy path：
 *   1. 自动 seq 并发：N 个 powershell 进程同时写，seq 必须 1..N*per 连续唯一，
 *      每条文本恰好一次（不丢不重），日志无坏行（没有撕裂写）
 *   2. 幂等 seq 并发：N 个进程抢同一个 seq，只能落一条，其余丢弃并告警，
 *      审计日志 .bus-dropped.jsonl 条数对得上
 *   3. seq 跳空被拒、max+1 显式 seq 正常写入
 *   4. 已被越过的 seq（日志空洞）→ 丢弃告警
 *   5. 残留锁自愈：持有者已死的 .bus.lock 不该让后来者干等 10 秒超时
 *
 * 全程用独立 runtime，绝不碰生产日志。每个 worker 是一个真正的
 * powershell.exe 进程，在进程内循环写 per 条 —— 这样既有跨进程并发，
 * 又不用付 N*per 次进程启动的钱。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const BUS = path.join(REPO, 'bus.ps1');
const PS = process.env.BUS_POWERSHELL || 'powershell.exe';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PROCS = Number(argOf('procs', 10));
const PER = Number(argOf('per', 30));
const ROOT = path.resolve(argOf('root', 'D:\\test\\bus-stress'));
const ROOM = path.join(ROOT, 'room.jsonl');
const DROPS = path.join(ROOT, '.bus-dropped.jsonl');
const LOCK = path.join(ROOT, '.bus.lock');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

// ---------------- 环境 ----------------
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// worker 落到压测目录里，不进仓库；PS 5.1 需要 BOM + CRLF（README 已知坑 4）
const WORKER = path.join(ROOT, 'worker.ps1');
const WORKER_SRC = `param(
  [int]$Worker,
  [int]$Count,
  [string]$Root,
  [string]$Bus,
  [int]$Seq = 0
)
$ErrorActionPreference = 'Stop'
$me = 'p{0:d2}' -f $Worker
for ($i = 1; $i -le $Count; $i++) {
  $text = 'w{0:d2}-{1:d3}' -f $Worker, $i
  if ($Seq -gt 0) {
    & $Bus post -From $me -Text $text -Root $Root -Seq $Seq
  } else {
    & $Bus post -From $me -Text $text -Root $Root
  }
}
`;
fs.writeFileSync(WORKER, '\ufeff' + WORKER_SRC.replace(/\n/g, '\r\n'), 'utf8');

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, out, err: err + e.message }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const runBus = (args) => run(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BUS, ...args]);

const runWorker = (worker, count, seq = 0, root = ROOT) => run(PS, [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WORKER,
  '-Worker', String(worker), '-Count', String(count), '-Root', root, '-Bus', BUS, '-Seq', String(seq),
]);

function readRoom(file = ROOM) {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = raw.split('\n').filter((l) => l.trim());
  const msgs = [], bad = [];
  for (const line of lines) {
    try { msgs.push(JSON.parse(line)); } catch { bad.push(line); }
  }
  return { raw, lines, msgs, bad };
}

const countLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).length : 0);

// seq 必须从 1 开始、连续、唯一，并且按文件顺序严格 +1
function checkSeq(name, msgs, expectedCount) {
  const seqs = msgs.map((m) => m.seq);
  const uniq = new Set(seqs);
  const sorted = [...seqs].sort((a, b) => a - b);
  const contiguous = sorted.length === expectedCount
    && sorted.every((s, i) => s === i + 1)
    && uniq.size === sorted.length;
  const ordered = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
  ok(`${name}：seq 唯一连续（1..${expectedCount}）`, contiguous,
    `count=${seqs.length} uniq=${uniq.size} first=${sorted[0]} last=${sorted[sorted.length - 1]}`);
  ok(`${name}：文件顺序里 seq 严格 +1`, ordered);
}

// ---------------- 1. 自动 seq 并发 ----------------
section(`1. 自动 seq 并发写：${PROCS} 进程 × ${PER} 条 = ${PROCS * PER} 条`);
{
  const t0 = Date.now();
  const runs = await Promise.all(Array.from({ length: PROCS }, (_, i) => runWorker(i, PER)));
  const ms = Date.now() - t0;

  const bad = runs.filter((r) => r.code !== 0);
  ok(`${PROCS} 个进程全部正常退出`, bad.length === 0,
    bad.map((r) => `p${r.worker} code=${r.code} ${(r.err || r.out).slice(0, 200)}`).join(' | '));

  const { msgs, bad: badLines } = readRoom();
  ok(`写入 ${PROCS * PER} 条（不丢）`, msgs.length === PROCS * PER, `实际 ${msgs.length}`);
  ok('无坏行 / 无撕裂写', badLines.length === 0, `${badLines.length} 行解析失败`);
  checkSeq('并发写', msgs, PROCS * PER);

  const counts = new Map();
  for (const m of msgs) counts.set(m.text, (counts.get(m.text) || 0) + 1);
  const expected = new Set();
  for (let w = 0; w < PROCS; w++) {
    for (let i = 1; i <= PER; i++) expected.add(`w${String(w).padStart(2, '0')}-${String(i).padStart(3, '0')}`);
  }
  const missing = [...expected].filter((t) => !counts.has(t));
  const dup = [...counts].filter(([, n]) => n > 1);
  ok('每条文本恰好落一次（不重）', missing.length === 0 && dup.length === 0,
    `missing=${missing.length} dup=${dup.length}${dup.length ? ' e.g. ' + JSON.stringify(dup.slice(0, 3)) : ''}`);

  const perWorker = new Map();
  for (const m of msgs) perWorker.set(m.from, (perWorker.get(m.from) || 0) + 1);
  ok(`每个进程 ${PER} 条`, perWorker.size === PROCS && [...perWorker.values()].every((n) => n === PER),
    [...perWorker].map(([k, v]) => `${k}=${v}`).join(' '));

  console.log(`  · 耗时 ${ms}ms（${Math.round((PROCS * PER * 1000) / Math.max(ms, 1))} 条/秒）`);
}

// ---------------- 2. 幂等 seq 并发抢同一个 seq ----------------
section('2. 幂等 seq 并发：所有进程抢同一个 seq，只能落一条');
{
  const base = readRoom().msgs.length;
  const target = base + 1;
  const attempts = 3;
  const dropsBefore = countLines(DROPS);

  const runs = await Promise.all(Array.from({ length: PROCS }, (_, i) => runWorker(100 + i, attempts, target)));
  const bad = runs.filter((r) => r.code !== 0);
  ok(`${PROCS} 个进程全部正常退出（重试不报错）`, bad.length === 0,
    bad.map((r) => `p${r.worker} code=${r.code} ${(r.err || r.out).slice(0, 200)}`).join(' | '));

  const { msgs } = readRoom();
  ok('日志只多出 1 条', msgs.length === base + 1, `base=${base} now=${msgs.length}`);
  ok(`落盘的就是 seq #${target}`, msgs[msgs.length - 1].seq === target, `实际 #${msgs[msgs.length - 1].seq}`);
  checkSeq('幂等写', msgs, target);

  const delta = countLines(DROPS) - dropsBefore;
  ok(`其余 ${PROCS * attempts - 1} 次全部丢弃并记账`, delta === PROCS * attempts - 1,
    `attempts=${PROCS * attempts} dropped=${delta}`);

  const dropRecs = fs.readFileSync(DROPS, 'utf8').split('\n').filter((l) => l.trim()).slice(dropsBefore).map((l) => JSON.parse(l));
  ok('丢弃原因全部是 duplicate', dropRecs.length === delta && dropRecs.every((r) => r.reason === 'duplicate'),
    [...new Set(dropRecs.map((r) => r.reason))].join(','));

  const warned = runs.some((r) => /重复 seq/.test(r.out + r.err));
  ok('stderr/stdout 有告警文本', warned);
}

// ---------------- 3. 跳空拒绝 / max+1 显式写入 ----------------
section('3. seq 跳空拒绝、max+1 显式 seq 正常写入');
{
  const base = readRoom().msgs.length;
  const gap = await runBus(['post', '-From', 'gap', '-Text', 'gap', '-Seq', String(base + 2), '-Root', ROOT]);
  ok('跳空 seq 被拒绝（退出码非 0）', gap.code !== 0, `code=${gap.code}`);
  ok('拒绝后日志没有变化', readRoom().msgs.length === base, `now=${readRoom().msgs.length}`);
  ok('拒绝原因写明跳空', /跳空/.test(gap.out + gap.err), (gap.err || gap.out).slice(0, 160));

  const next = await runBus(['post', '-From', 'next', '-Text', 'next-by-seq', '-Seq', String(base + 1), '-Root', ROOT]);
  const after = readRoom();
  ok('max+1 显式 seq 写入成功', next.code === 0 && after.msgs.length === base + 1 && after.msgs[base].seq === base + 1,
    `code=${next.code} n=${after.msgs.length}`);
  checkSeq('显式 seq', after.msgs, base + 1);
}

// ---------------- 4. 已被越过的 seq（日志空洞） ----------------
section('4. 日志有空洞时，写洞里的 seq → 丢弃告警');
{
  const hole = path.join(ROOT, 'hole');
  fs.mkdirSync(hole, { recursive: true });
  const mk = (seq, text) => JSON.stringify({
    seq, ts: new Date().toISOString(), from: 'seed', kind: 'msg', to: '', task: 0,
    text, thread: '', reply_to: 0, mentions: '', hop: 0, via: 'human',
  });
  fs.writeFileSync(path.join(hole, 'room.jsonl'), mk(1, 'a') + '\n' + mk(3, 'c') + '\n', 'utf8');

  const r = await runBus(['post', '-From', 'h', '-Text', 'into-hole', '-Seq', '2', '-Root', hole]);
  ok('退出码 0（幂等丢弃不算失败）', r.code === 0, `code=${r.code}`);
  ok('空洞 seq 没有被写进去', readRoom(path.join(hole, 'room.jsonl')).msgs.length === 2);
  ok('告警写明「已被越过」', /已被越过/.test(r.out + r.err), (r.out + r.err).slice(0, 160));
}

// ---------------- 5. 残留锁自愈 ----------------
section('5. 残留锁自愈：持有者已死不该干等超时');
{
  const deadPid = 999999;
  fs.writeFileSync(LOCK, JSON.stringify({ pid: deadPid, token: 'deadbeef', host: 'x', since: new Date().toISOString() }), 'utf8');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(LOCK, old, old);

  const before = readRoom().msgs.length;
  const t0 = Date.now();
  const r = await runBus(['post', '-From', 'heal', '-Text', 'after-stale-lock', '-Root', ROOT]);
  const ms = Date.now() - t0;
  ok('写入成功', r.code === 0 && readRoom().msgs.length === before + 1, `code=${r.code}`);
  ok('自愈耗时 < 5s（不是干等 10s 锁超时）', ms < 5000, `${ms}ms`);
  ok('锁文件已清理', !fs.existsSync(LOCK));
}

// ---------------- 5b. 活着的持有者：绝不抢锁 ----------------
// 反方向的自愈验证：mtime 很旧但 pid 还活着，说明只是慢，不是死锁。
// 这种情况必须老实等超时，抢进去就是两人同时写。
section('5b. 持有者还活着：不抢锁');
{
  const holder = spawn(PS, ['-NoProfile', '-Command', 'Start-Sleep 120'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid: holder.pid, token: 'live', host: 'x', since: new Date(0).toISOString() }), 'utf8');
    const oldT = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(LOCK, oldT, oldT);
    const before = readRoom().msgs.length;

    const t0 = Date.now();
    const pending = runBus(['post', '-From', 'intrude', '-Text', 'must-not-write', '-Root', ROOT]);
    await new Promise((r) => setTimeout(r, 3000));      // 观察窗口内它有没有闯进去

    const ms = Date.now() - t0;
    ok('3 秒内没有闯进临界区', readRoom().msgs.length === before, `n=${readRoom().msgs.length}`);
    ok('锁文件完好（没被当陈旧锁删掉）', fs.existsSync(LOCK));

    const r = await pending;
    ok('最终是超时报错，不是静默写入', r.code !== 0 && /获取锁超时/.test(r.out + r.err), `code=${r.code}`);
    console.log(`  · 观察窗口 ${Math.round(ms / 1000)}s 内未闯入，最终超时放弃（符合预期）`);
  } finally {
    try { holder.kill(); } catch { }
  }
  // 这个 holder 可能被判陈旧（mtime 已过 120s 但 pid 仍活 → 不判陈旧），
  // 所以清掉它留下的锁，别影响后续。
  try { fs.rmSync(LOCK, { force: true }); } catch { }
}

// ---------------- 汇总 ----------------
const final = readRoom();
// 300 并发写 + 幂等写 1 条 + max+1 显式写 1 条 + 残留锁自愈 1 条
checkSeq('最终', final.msgs, PROCS * PER + 3);
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
console.log(`压测 runtime: ${ROOT}`);
process.exit(fail ? 1 : 0);
