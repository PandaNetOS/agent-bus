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
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// ---------------- 1b. 群聊广播（@全体，一人回复） ----------------
section('1b. 群聊广播');
{
  const cfg = { autoChat: true, maxHop: 3, hopReset: {} };
  const bcast = { seq: 20, from: 'human', to: '*', mentions: '*', text: '大家好', hop: 0, via: 'human', thread: 't-g' };

  ok('广播：hermes 看得到', gates.gate(bcast, { me: 'hermes', all: [bcast], config: cfg }).ok);
  ok('广播：opencode 也看得到', gates.gate(bcast, { me: 'opencode', all: [bcast], config: cfg }).ok);
  ok('广播：dsh 也看得到', gates.gate(bcast, { me: 'dsh', all: [bcast], config: cfg }).ok);
  ok('广播：自己发的仍不算', gates.gate({ ...bcast, from: 'hermes' }, { me: 'hermes', all: [], config: cfg }).reason === 'self');

  // 已被抢答：磁盘上有抢答记录的 driver 必须跳过
  const claimed = new Set([20]);
  ok('已被抢答 → 不投喂', gates.gate(bcast, { me: 'hermes', all: [bcast], config: cfg, claimed }).reason === 'claimed');

  // 兜底：日志里已有回复（抢答记录丢失/老消息时）
  const answeredAll = [bcast, { seq: 21, from: 'opencode', to: 'human', reply_to: 20, via: 'driver:opencode', hop: 1 }];
  ok('日志里已有人回 → 不投喂', gates.gate(bcast, { me: 'hermes', all: answeredAll, config: cfg }).reason === 'answered');

  // 老消息（to 和 mentions 都为空）不能被追溯成广播 —— 那会让新装的 driver
  // 把历史里所有没点名的话全答一遍
  const legacy = { seq: 22, from: 'human', to: '', mentions: '', text: '老消息', via: 'human' };
  ok('老的空收件人消息不算广播', gates.gate(legacy, { me: 'hermes', all: [legacy], config: cfg }).reason === 'not-named');
  ok('isBroadcast 只认 * 哨兵', gates.isBroadcast(bcast) && !gates.isBroadcast(legacy));

  // 点名消息不受「一人回复」限制：点名是明确的委托，回几次由 hop 管
  const named = { seq: 23, from: 'human', to: 'hermes', mentions: 'hermes', text: 'hi', hop: 0, via: 'human', thread: 't-1' };
  const claimedNamed = new Set([23]);
  ok('点名消息不受抢答闸限制', gates.gate(named, { me: 'hermes', all: [named], config: cfg, claimed: claimedNamed }).ok);
}

// ---------------- 1c. 抢答原子性（两个 driver 抢同一条） ----------------
section('1c. 抢答原子性');
{
  const { claimReply, releaseClaim } = await import('../lib/bus.mjs');
  fs.writeFileSync(path.join(TMP, '.claims.jsonl'), '', 'utf8');

  ok('第一个抢到', claimReply(900, 'hermes') === true);
  ok('第二个抢不到', claimReply(900, 'opencode') === false);
  ok('不同 seq 互不干扰', claimReply(901, 'opencode') === true);
  ok('抢答落到磁盘（可审计）', fs.readFileSync(path.join(TMP, '.claims.jsonl'), 'utf8').split('\n').filter(Boolean).length === 2);
  ok('releaseClaim 能清掉', releaseClaim(900) === true);
  ok('清掉后能再抢', claimReply(900, 'opencode') === true);

  // 真并发：8 个独立进程同时抢同一个 seq，只能有一个赢。
  // 关键是「投喂前先抢」——投喂到写回要几十秒到几分钟，只靠日志里有没有
  // reply_to 判断，两个 driver 会都认为自己该答。
  const N = 8;
  fs.writeFileSync(path.join(TMP, '.claims.jsonl'), '', 'utf8');
  const sf = path.join(TMP, 'claim-probe.mjs');
  fs.writeFileSync(sf, `
    const { claimReply } = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'lib', 'bus.mjs')).href)});
    process.stdout.write(String(claimReply(950, process.argv[2])));
  `, 'utf8');

  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => new Promise((res) => {
      const p = spawn(process.execPath, [sf, 'w' + i], {
        env: { ...process.env, AGENT_BUS_ROOT: TMP }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let so = '', se = '';
      p.stdout.on('data', (d) => { so += d; });
      p.stderr.on('data', (d) => { se += d; });
      p.on('exit', () => res({ out: so.trim(), err: se.trim().split('\n')[0] || '' }));
    })),
  );
  const crashed = results.filter((r) => r.out !== 'true' && r.out !== 'false');
  ok('并发抢答进程都没崩', crashed.length === 0, crashed.map((c) => c.err).join(' | '));
  const winners = results.filter((r) => r.out === 'true');
  ok(`${N} 进程并发抢同一 seq：只有 1 个赢`, winners.length === 1, `赢了 ${winners.length} 个：${results.map((r) => r.out).join(',')}`);
  ok('其余全部拿到 false', results.filter((r) => r.out === 'false').length === N - 1);

  fs.rmSync(path.join(TMP, '.claims.jsonl'), { force: true });
  fs.rmSync(sf, { force: true });
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

// ---------------- 4b. 群聊：两个 driver 面对同一条 @全体 ----------------
section('4b. 群聊广播只产生一条回复');
{
  const { runDriver } = await import('../drivers/driver.mjs');
  fs.writeFileSync(path.join(TMP, 'room.jsonl'), '', 'utf8');
  fs.rmSync(path.join(TMP, '.claims.jsonl'), { force: true });
  for (const n of ['hermes', 'opencode']) fs.rmSync(path.join(TMP, `.cursor-${n}.json`), { force: true });
  writeConfig({ autoChat: true, maxHop: 3, pausedUntil: 0, pauseReason: '', hopReset: {} });

  // 两个 driver 各建一次基线（模拟刚装好、开关刚打开）
  const mk = (tag, counter) => async () => ({
    ask: async () => { counter.n++; return `${tag} 的回答`; },
    close: () => {},
  });
  const ch = { n: 0 }, co = { n: 0 };
  await runDriver({ name: 'hermes', createSession: mk('hermes', ch), once: true, intervalMs: 10 });
  await runDriver({ name: 'opencode', createSession: mk('opencode', co), once: true, intervalMs: 10 });

  // 一条不带 @ 的群消息
  append({ from: 'human', text: '大家谁在', to: '*', mentions: '*', via: 'human', thread: 't-grp' });

  // 两个 driver 都来轮询：只有抢到的那个答
  await runDriver({ name: 'hermes', createSession: mk('hermes', ch), once: true, intervalMs: 10 });
  await runDriver({ name: 'opencode', createSession: mk('opencode', co), once: true, intervalMs: 10 });

  ok('只有一个人回答了', ch.n + co.n === 1, `hermes=${ch.n} opencode=${co.n}`);

  const replies = readAll().filter((m) => m.via && m.via !== 'human');
  ok('日志里只有 1 条回复', replies.length === 1, `实际 ${replies.length} 条`);
  ok('回复 reply_to 指向群消息', replies[0].reply_to === 1, `reply_to=${replies[0].reply_to}`);
  ok('回复不再标 *（否则会被无限接力）', replies[0].to !== '*' && replies[0].mentions !== '*',
    JSON.stringify({ to: replies[0].to, mentions: replies[0].mentions }));
  ok('回复回给发起人', replies[0].to === 'human', `to=${replies[0].to}`);
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

// ---------------- 8. 「没人回」诊断 ----------------
section('8. 没人回复的诊断');
{
  // 这段判据曾经印出过「@opencode 没有 driver 在接（只有 dsh / hermes / opencode 在线）」
  // —— 目标明明在线，真实原因是跳数到顶。它埋在 busd.mjs 里没法测（一 import 就起服务器），
  // 所以挪到 lib/diagnose.mjs 之后补这组用例，钉死那个矛盾。
  const { makeDiagnose } = await import("../lib/diagnose.mjs");
  const D = makeDiagnose({ root: TMP, members: ['dsh', 'hermes', 'opencode'] });
  const cfg = { autoChat: true, maxHop: 3, pausedUntil: 0, pauseReason: '', hopReset: {} };
  const MEMBS = ["dsh", "hermes", "opencode"];

  const writeRoom = (msgs) => fs.writeFileSync(path.join(TMP, "room.jsonl"),
    msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
  const setHb = (live) => {
    for (const n of MEMBS) fs.rmSync(path.join(TMP, `.heartbeat-${n}.json`), { force: true });
    for (const n of live) {
      fs.writeFileSync(path.join(TMP, `.heartbeat-${n}.json`),
        JSON.stringify({ name: n, ts: Date.now(), state: "idle" }), "utf8");
    }
  };
  const setCur = (n, consumed = []) => fs.writeFileSync(path.join(TMP, `.cursor-${n}.json`),
    JSON.stringify({ consumed, lastSeq: 0, baseline: 0 }), "utf8");
  const mk = (o) => ({ ts: new Date().toISOString(), kind: "msg", task: 0, thread: "t1",
    reply_to: 0, mentions: "", hop: 0, via: "human", ...o });

  // A. 点名目标在线、真实原因是跳数到顶 —— 就是修掉的那个 bug
  setHb(MEMBS);
  for (const n of MEMBS) setCur(n, []);
  fs.rmSync(path.join(TMP, ".claims.jsonl"), { force: true });
  writeRoom([mk({ seq: 1, from: "hermes", to: "opencode", mentions: "opencode",
    hop: 3, via: "driver:hermes", text: "转手三次的消息" })]);
  {
    const all = readAll();
    const t = D.diagnose(all[0], all, cfg);
    ok('点名目标在线时报它自己的原因', t.includes('@opencode 在线，但') && t.includes('跳数到顶'), t);
    ok('不再自相矛盾地说它没 driver', !t.includes('没有 driver 在接'), t);
  }

  // B. 点名目标真的没有 driver
  setHb(["hermes"]);
  {
    const all = readAll();
    const t = D.diagnose(all[0], all, cfg);
    ok('目标无 driver 时能说清楚', t.includes('@opencode 没有 driver 在接') && t.includes('hermes'), t);
  }

  // C. 总开关关着
  setHb(MEMBS);
  writeRoom([mk({ seq: 1, from: "human", to: "*", mentions: "*", text: "开关关着的广播" })]);
  {
    const all = readAll();
    const t = D.diagnose(all[0], all, { ...cfg, autoChat: false });
    ok('开关关着时报开关', t.includes('总开关'), t);
  }

  // D. 一个 driver 都没有
  setHb([]);
  {
    const all = readAll();
    const t = D.diagnose(all[0], all, cfg);
    ok('没人跑时报没人跑', t.includes('没有任何 driver'), t);
  }

  // E. 广播已经被别人回过
  setHb(MEMBS);
  writeRoom([mk({ seq: 1, from: "human", to: "*", mentions: "*", text: "已被回过的广播" }),
    mk({ seq: 2, from: "hermes", to: "human", hop: 1, via: "driver:hermes", reply_to: 1, text: "我来回" })]);
  {
    const all = readAll();
    const t = D.diagnose(all[0], all, cfg);
    ok('已有人回过时报回过', t.includes('已有人回过'), t);
  }

  // F. 有人会回 —— 不该给任何解释
  writeRoom([mk({ seq: 1, from: "human", to: "*", mentions: "*", text: "没人回过的广播" })]);
  {
    const all = readAll();
    ok('有人会回时不报原因', D.diagnose(all[0], all, cfg) === '', D.diagnose(all[0], all, cfg));
  }

  // 收尾：别把假心跳/假游标留给后面的用例
  for (const n of MEMBS) {
    fs.rmSync(path.join(TMP, `.heartbeat-${n}.json`), { force: true });
    fs.rmSync(path.join(TMP, `.cursor-${n}.json`), { force: true });
  }
}
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
console.log(`验收 runtime: ${TMP}`);
process.exit(fail ? 1 : 0);
