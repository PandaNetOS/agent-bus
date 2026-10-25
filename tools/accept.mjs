/**
 * tools/accept.mjs — 验收脚本
 *
 *   node tools/accept.mjs          快速项（不需要 LLM，几秒）
 *   node tools/accept.mjs --live   加上真 agent 的双向对话（要几分钟、要花钱）
 *
 * 检查的是「共享状态原语」的失败路径，不是 happy path：
 * 并发、游标重放、跳数到顶、熔断、单点失效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const TMP = process.env.ACCEPT_ROOT || 'D:\\test\\bus-accept';

// 每次验收用独立 runtime，绝不碰生产日志
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, 'ceo.txt'), 'dsh', 'utf8');
process.env.AGENT_BUS_ROOT = TMP;

const { readAll, append } = await import('../lib/bus.mjs');
const gates = await import('../lib/gates.mjs');
const { readConfig, writeConfig, ensureConfig } = await import('../lib/config.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

// ---------------- 1. 六道闸（纯函数） ----------------
section('1. 六道闸');
{
  const cfg = { autoChat: true, maxHop: 3, hopReset: {} };
  const base = { seq: 10, from: 'human', to: 'hermes', mentions: 'hermes', text: 'hi', hop: 0, via: 'human', thread: 't-1' };

  ok('点名 to → 投喂', gates.gate(base, { me: 'hermes', all: [base], config: cfg }).ok);
  ok('mentions → 投喂', gates.gate({ ...base, to: '', mentions: 'hermes,opencode' }, { me: 'hermes', all: [base], config: cfg }).ok);
  ok('没点名 → 不投喂', gates.gate({ ...base, to: '', mentions: '' }, { me: 'hermes', all: [], config: cfg }).reason === 'not-named');
  ok('自己发的 → 不投喂', gates.gate({ ...base, from: 'hermes' }, { me: 'hermes', all: [], config: cfg }).reason === 'self');
  ok('已消费 → 不投喂', gates.gate(base, { me: 'hermes', all: [], consumed: new Set([10]), config: cfg }).reason === 'consumed');
  ok('hop 到顶 → 不投喂', gates.gate({ ...base, hop: 3, via: 'driver:x' }, { me: 'hermes', all: [], config: cfg }).reason === 'hop-limit');
  ok('hop 到顶但人工放行 → 投喂', gates.gate({ ...base, hop: 3, via: 'driver:x' }, { me: 'hermes', all: [], config: { ...cfg, hopReset: { 't-1': Date.now() } } }).ok);
  ok('熔断中 → 不投喂', gates.gate(base, { me: 'hermes', all: [], config: { ...cfg, pausedUntil: Date.now() + 60000 } }).reason === 'breaker');
  ok('人工消息不受 hop 限制', gates.gate({ ...base, hop: 9, via: 'human' }, { me: 'hermes', all: [], config: cfg }).ok);

  const dup = { ...base, via: 'driver:a', hop: 1 };
  ok('同样的话第 3 次 → 判循环', gates.gate(dup, { me: 'hermes', all: [dup, dup], config: cfg }).reason === 'loop');
}

// ---------------- 2. 熔断计数 ----------------
section('2. 熔断');
{
  const now = Date.now();
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    seq: i + 1, ts: new Date(now - 1000).toISOString(), via: 'driver:x', hop: 1, from: 'a', to: 'b', text: 't' + i,
  }));
  ok('12 条不触发', !gates.breakerState(mk(12), now).tripped);
  ok('13 条触发', gates.breakerState(mk(13), now).tripped);
  ok('窗口外的老消息不计', !gates.breakerState(mk(20).map((m) => ({ ...m, ts: new Date(now - 120000).toISOString() })), now).tripped);
}

// ---------------- 3. PS 与 Node 混写并发 ----------------
section('3. 混写并发（bus.ps1 + lib/bus.mjs 同一把锁）');
{
  fs.writeFileSync(path.join(TMP, 'room.jsonl'), '', 'utf8');
  const busPs1 = path.join(REPO, 'bus.ps1');
  const N = 8, M = 3;

  const psJob = (i) => new Promise((res) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', busPs1,
      'post', '-From', `ps${i}`, '-Text', `ps ${i}`, '-Root', TMP], { stdio: 'ignore' });
    p.on('exit', res);
  });
  const nodeJob = (i) => new Promise((res) => {
    try { append({ from: `node${i}`, text: `node ${i}`, via: 'human' }); } catch (e) { console.log('   node 写入失败', e.message); }
    res();
  });

  const jobs = [];
  for (let i = 0; i < N; i++) {
    jobs.push(psJob(i));
    jobs.push(nodeJob(i));
    for (let j = 1; j < M; j++) jobs.push(nodeJob(i * 10 + j));
  }
  await Promise.all(jobs);

  const all = readAll();
  const seqs = all.map((m) => m.seq).sort((a, b) => a - b);
  const uniq = new Set(seqs);
  const contiguous = seqs.length > 0 && seqs[0] === 1 && seqs[seqs.length - 1] === seqs.length && uniq.size === seqs.length;
  ok(`混写 ${seqs.length} 条：seq 唯一且连续`, contiguous, `count=${seqs.length} uniq=${uniq.size} first=${seqs[0]} last=${seqs[seqs.length - 1]}`);
  const bad = fs.readFileSync(path.join(TMP, 'room.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).filter((l) => { try { JSON.parse(l); return false; } catch { return true; } });
  ok('无坏行', bad.length === 0, `${bad.length} 行解析失败`);
}

// ---------------- 4. 游标不重放 ----------------
section('4. driver 游标不重放');
{
  fs.writeFileSync(path.join(TMP, 'room.jsonl'), '', 'utf8');
  const { runDriver } = await import('../drivers/driver.mjs');
  const cfgFile = path.join(TMP, 'hub-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ autoChat: true, maxHop: 3, hopReset: {} }), 'utf8');

  let calls = 0;
  const createSession = async () => ({ ask: async () => { calls++; return 'mock 回复'; }, close: () => {} });

  // 先跑一次建基线（首次启动不投喂历史，这是刻意的安全行为）
  await runDriver({ name: 'hermes', createSession, once: true, intervalMs: 10 });
  append({ from: 'human', text: '@hermes 测试游标', to: 'hermes', mentions: 'hermes', via: 'human' });
  await runDriver({ name: 'hermes', createSession, once: true, intervalMs: 10 });
  await runDriver({ name: 'hermes', createSession, once: true, intervalMs: 10 });
  await runDriver({ name: 'hermes', createSession, once: true, intervalMs: 10 });
  ok('同一 seq 只被投喂一次（跑 3 次 driver）', calls === 1, `实际投喂 ${calls} 次`);

  const auto = readAll().filter((m) => m.via === 'driver:hermes');
  ok('回复落盘且 via 标对', auto.length === 1 && auto[0].via === 'driver:hermes');
  ok('回复带 hop=1 / thread / reply_to', auto[0].hop === 1 && !!auto[0].thread && auto[0].reply_to > 0,
    JSON.stringify({ hop: auto[0].hop, thread: auto[0].thread, reply_to: auto[0].reply_to }));

  // 首次启动（没有游标文件）不能把历史全回答一遍
  fs.writeFileSync(path.join(TMP, 'room.jsonl'), '', 'utf8');
  fs.rmSync(path.join(TMP, '.cursor-hermes.json'), { force: true });
  for (let i = 0; i < 3; i++) {
    append({ from: 'human', text: `@hermes 历史 ${i}`, to: 'hermes', mentions: 'hermes', via: 'human' });
  }
  let calledFresh = 0;
  await runDriver({
    name: 'hermes',
    createSession: async () => ({ ask: async () => { calledFresh++; return 'x'; }, close: () => {} }),
    once: true, intervalMs: 10,
  });
  ok('首次启动不投喂历史（基线=最新 seq）', calledFresh === 0, `投喂了 ${calledFresh} 条`);
}

// ---------------- 5. 熔断由 driver 自己判（不依赖 busd） ----------------
section('5. 单点失效：driver 不依赖 busd');
{
  fs.writeFileSync(path.join(TMP, 'room.jsonl'), '', 'utf8');
  fs.rmSync(path.join(TMP, '.cursor-hermes.json'), { force: true });
  writeConfig({ autoChat: true, maxHop: 3, pausedUntil: 0, pauseReason: '', hopReset: {} });
  {
    const { runDriver: rd } = await import('../drivers/driver.mjs');
    await rd({ name: 'hermes', createSession: async () => ({ ask: async () => 'x', close: () => {} }), once: true, intervalMs: 10 });
  }
  // 造 13 条窗口内的自动消息
  for (let i = 0; i < 13; i++) {
    append({ from: 'x', to: 'hermes', mentions: 'hermes', text: `auto ${i}`, hop: 1, via: 'driver:x', thread: 't-b' });
  }
  let called = false;
  const { runDriver } = await import('../drivers/driver.mjs');
  await runDriver({
    name: 'hermes',
    createSession: async () => ({ ask: async () => { called = true; return 'x'; }, close: () => {} }),
    once: true, intervalMs: 10,
  });
  ok('13 条自动消息 → driver 不投喂', !called);
  const cfg = readConfig();
  ok('driver 自己写了 pausedUntil', cfg.pausedUntil > Date.now(), `pausedUntil=${cfg.pausedUntil}`);
  ok('暂停原因写明条数', /自动消息/.test(cfg.pauseReason || ''), cfg.pauseReason);

  const src = fs.readFileSync(path.join(REPO, 'drivers', 'driver.mjs'), 'utf8');
  ok('driver.mjs 不 import busd', !/from\s+['"].*busd/.test(src));
  ok('driver.mjs 不依赖 HTTP', !/fetch\(|http\.request/.test(src));
}

// ---------------- 6. 增量读可见性 ----------------
section('6. 增量读截断');
{
  fs.writeFileSync(path.join(TMP, 'room.jsonl'), '', 'utf8');
  for (let i = 0; i < 10; i++) append({ from: 'x', text: 'm' + i });
  const busPs1 = path.join(REPO, 'bus.ps1');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', busPs1,
    'read', '-Since', '0', '-Limit', '3', '-Json', '-Root', TMP], { encoding: 'utf8' });
  const j = JSON.parse(out.trim());
  ok('返回 3 条并标 truncated', j.messages.length === 3 && j.truncated === true, JSON.stringify({ n: j.messages.length, t: j.truncated, r: j.remaining }));
  ok('remaining 数字对', j.remaining === 7, `remaining=${j.remaining}`);
}

// ---------------- 7. 真 agent 双向对话（--live） ----------------
if (process.argv.includes('--live')) {
  section('7. 真 agent 双向对话（A→B→A）');
  fs.writeFileSync(path.join(TMP, 'room.jsonl'), '', 'utf8');
  writeConfig({ autoChat: true, maxHop: 3, pausedUntil: 0, pauseReason: '', hopReset: {}, cwd: TMP });
  fs.rmSync(path.join(TMP, '.cursor-hermes.json'), { force: true });
  fs.rmSync(path.join(TMP, '.cursor-opencode.json'), { force: true });

  const run = (drv) => new Promise((res) => {
    const p = spawn(process.execPath, [path.join(REPO, 'drivers', `${drv}.mjs`), '--once'], {
      env: { ...process.env, AGENT_BUS_ROOT: TMP }, stdio: 'inherit',
    });
    p.on('exit', res);
  });
  await run('hermes');   // 空日志先跑一次，把基线定在 0
  append({ from: 'human', text: '@hermes 一句话说结论，并让 @opencode 补充一句', to: 'hermes', mentions: 'hermes', via: 'human' });
  await run('hermes');
  await run('opencode');

  const all = readAll();
  const chain = all.filter((m) => m.via !== 'human').sort((a, b) => a.seq - b.seq);
  ok('至少两条自动消息', chain.length >= 2, `实际 ${chain.length}`);
  ok('from 不同（真的两个 agent）', new Set(chain.map((m) => m.from)).size >= 2, [...new Set(chain.map((m) => m.from))].join(','));
  ok('hop 递增', chain.every((m, i) => i === 0 || m.hop >= chain[i - 1].hop), chain.map((m) => m.hop).join('→'));
  ok('同一 thread', new Set(chain.map((m) => m.thread)).size === 1, [...new Set(chain.map((m) => m.thread))].join(','));
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
console.log(`验收 runtime: ${TMP}`);
process.exit(fail ? 1 : 0);
