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

  // 群聊模式（默认）：三个人都看得到，不抢答 —— 各自决定说不说
  ok('群聊模式：广播不因别人抢答而挡住我',
    gates.gate(bcast, { me: 'hermes', all: [bcast], config: cfg, claimed: new Set([20]) }).ok);

  // 已被抢答：只在 groupChat:false（旧行为「一人回复」）下生效
  const cfgOld = { ...cfg, groupChat: false };
  const claimed = new Set([20]);
  ok('groupChat:false 时已被抢答 → 不投喂',
    gates.gate(bcast, { me: 'hermes', all: [bcast], config: cfgOld, claimed }).reason === 'claimed');

  // 兜底：日志里已有回复（抢答记录丢失/老消息时）
  const answeredAll = [bcast, { seq: 21, from: 'opencode', to: 'human', reply_to: 20, via: 'driver:opencode', hop: 1 }];
  ok('群聊模式：别人回过了我仍能补充',
    gates.gate(bcast, { me: 'hermes', all: answeredAll, config: cfg }).ok);
  ok('groupChat:false 时已有人回 → 不投喂',
    gates.gate(bcast, { me: 'hermes', all: answeredAll, config: cfgOld }).reason === 'answered');

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
section('4b. 群聊：三个人都看得到，各自决定说不说');
{
  const { runDriver } = await import("../drivers/driver.mjs");
  fs.writeFileSync(path.join(TMP, "room.jsonl"), "", "utf8");
  fs.rmSync(path.join(TMP, ".claims.jsonl"), { force: true });
  for (const n of ['hermes', 'opencode']) fs.rmSync(path.join(TMP, `.cursor-${n}.json`), { force: true });
  writeConfig({ autoChat: true, maxHop: 3, pausedUntil: 0, pauseReason: '', hopReset: {}, groupChat: true });

  // 两个 driver 各建一次基线（模拟刚装好、开关刚打开）
  const mk = (tag, counter, replyText) => async () => ({
    ask: async () => { counter.n++; return replyText; },
    close: () => {},
  });
  const ch = { n: 0 }, co = { n: 0 };
  await runDriver({ name: 'hermes', createSession: mk('hermes', ch, '我在'), once: true, intervalMs: 10 });
  await runDriver({ name: 'opencode', createSession: mk('opencode', co, '我也在'), once: true, intervalMs: 10 });

  // 一条不带 @ 的群消息
  append({ from: 'human', text: '大家谁在', to: '*', mentions: '*', via: 'human', thread: 't-grp' });

  // 群聊模式下两个 driver 都会被投喂 —— 这就是「群聊」：
  // 每个人都是独立个体，各自决定要不要说话。
  await runDriver({ name: 'hermes', createSession: mk('hermes', ch, '我在'), once: true, intervalMs: 10 });
  await runDriver({ name: 'opencode', createSession: mk('opencode', co, '我也在'), once: true, intervalMs: 10 });

  ok('两个人都被投喂了（不是只有一人抢到）', ch.n === 1 && co.n === 1, `hermes=${ch.n} opencode=${co.n}`);

  const replies = readAll().filter((m) => m.via && m.via !== "human");
  ok("两条回复都落盘了", replies.length === 2, `实际 ${replies.length} 条`);
  ok("回复 reply_to 都指向群消息", replies.every((r) => r.reply_to === 1),
    JSON.stringify(replies.map((r) => r.reply_to)));
  ok("回复不再标 *（否则会被无限接力）", replies.every((r) => r.to !== "*" && r.mentions !== "*"),
    JSON.stringify(replies.map((r) => ({ to: r.to, m: r.mentions }))));
  ok("回复都回给发起人", replies.every((r) => r.to === "human"), JSON.stringify(replies.map((r) => r.to)));
  ok("两个人各说各的，内容不同",
    replies.length >= 2 && replies[0].text !== replies[1].text,
    JSON.stringify(replies.map((r) => (r && r.text) || null)));

  // ---- 沉默出口：回复 [SKIP] 就不发消息 ----
  fs.writeFileSync(path.join(TMP, "room.jsonl"), "", "utf8");
  fs.rmSync(path.join(TMP, ".claims.jsonl"), { force: true });
  for (const n of ['hermes', 'opencode']) fs.rmSync(path.join(TMP, `.cursor-${n}.json`), { force: true });
  writeConfig({ autoChat: true, maxHop: 3, pausedUntil: 0, pauseReason: '', hopReset: {}, groupChat: true });
  const ch2 = { n: 0 }, co2 = { n: 0 };
  await runDriver({ name: 'hermes', createSession: mk('hermes', ch2, 'x'), once: true, intervalMs: 10 });
  await runDriver({ name: 'opencode', createSession: mk('opencode', co2, 'x'), once: true, intervalMs: 10 });
  append({ from: 'human', text: '有人吗', to: '*', mentions: '*', via: 'human', thread: 't-grp2' });
  // hermes 说话，opencode 选择沉默
  await runDriver({ name: 'hermes', createSession: mk('hermes', ch2, '我在'), once: true, intervalMs: 10 });
  await runDriver({ name: 'opencode', createSession: mk('opencode', co2, '[SKIP]'), once: true, intervalMs: 10 });
  const r2 = readAll().filter((m) => m.via && m.via !== "human");
  ok("选沉默的那个不发消息", r2.length === 1, `实际 ${r2.length} 条`);
  ok("沉默的 agent 也没被记为已消费之外的问题", ch2.n === 1 && co2.n === 1,
    `两人都被问过 hermes=${ch2.n} opencode=${co2.n}`);

  // ---- groupChat:false 退回「一人回复」旧行为 ----
  fs.writeFileSync(path.join(TMP, "room.jsonl"), "", "utf8");
  fs.rmSync(path.join(TMP, ".claims.jsonl"), { force: true });
  for (const n of ['hermes', 'opencode']) fs.rmSync(path.join(TMP, `.cursor-${n}.json`), { force: true });
  writeConfig({ autoChat: true, maxHop: 3, pausedUntil: 0, pauseReason: '', hopReset: {}, groupChat: false });
  const ch3 = { n: 0 }, co3 = { n: 0 };
  await runDriver({ name: 'hermes', createSession: mk('hermes', ch3, 'y'), once: true, intervalMs: 10 });
  await runDriver({ name: 'opencode', createSession: mk('opencode', co3, 'y'), once: true, intervalMs: 10 });
  append({ from: 'human', text: '谁在', to: '*', mentions: '*', via: 'human', thread: 't-grp3' });
  await runDriver({ name: 'hermes', createSession: mk('hermes', ch3, '我在'), once: true, intervalMs: 10 });
  await runDriver({ name: 'opencode', createSession: mk('opencode', co3, '我也在'), once: true, intervalMs: 10 });
  const r3 = readAll().filter((m) => m.via && m.via !== "human");
  ok("groupChat:false 时退回一人回复", r3.length === 1, `实际 ${r3.length} 条`);
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
  // 群聊模式：广播被回过了，别人仍能补充，所以不该报「已有人回过」
  {
    const all = readAll();
    const t = D.diagnose(all[0], all, cfg);
    ok('群聊模式：已有人回过不阻塞（别人还能补充）', !t.includes('已有人回过'), t);
  }
  {
    // 旧行为（一人回复）下，已有人回过就该报出来
    const all = readAll();
    const t = D.diagnose(all[0], all, { ...cfg, groupChat: false });
    ok('groupChat:false 时已有人回过时报回过', t.includes('已有人回过'), t);
  }
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
// ---------------- 9. 转交必须显式 ----------------
section('9. 回复转交的显式性');
{
  // routeReply 原来扫全文取第一个 @名字。于是 agent 写一句
  // 「我和 @opencode 双侧实据一致」，就把回给用户的话改投给了 opencode ——
  // 用户问「下午好」，agent 回一句下午好，然后跟 opencode 开起了会。
  // 实测 6 条被这样劫持（#62/#63/#64/#74/#79/#93）。
  const { routeReply } = await import("../drivers/driver.mjs");
  const AG = ['dsh', 'hermes', 'opencode'];
  const R = (text, fallback = "human", me = "dsh") => routeReply(text, fallback, me, AG);

  ok('开头 @名字 = 转交', R('@opencode 这个交给你') === 'opencode', R('@opencode 这个交给你'));
  ok('无 @ = 回给问的人', R('好的，我来处理') === 'human', R('好的，我来处理'));

  // 这就是那个 bug：正文中间的顺带提及
  const buggy = '下午好。\n\n悬着的一件还是 #73 的定性结论，我和 @opencode 双侧实据一致：不是投递掉包。';
  ok('正文中段的 @ 不再劫持收件人', R(buggy) === 'human', `实际=${R(buggy)}`);
  ok('开头 @ 仍然生效（不误伤）', R('@opencode ' + buggy) === 'opencode');

  ok('@自己 不算转交', R('@dsh 我来', 'human', 'dsh') === 'human', R('@dsh 我来', 'human', 'dsh'));
  ok('@不存在的人 不算转交', R('@nobody 你看', 'human', 'dsh') === 'human', R('@nobody 你看', 'human', 'dsh'));
  ok('行首空白不影响判定', R('   @hermes 你去', 'human', 'dsh') === 'hermes', R('   @hermes 你去', 'human', 'dsh'));
  ok('@名字后跟标点仍算转交', R('@hermes：这个是你的', 'human', 'dsh') === 'hermes', R('@hermes：这个是你的', 'human', 'dsh'));
  ok('正文换行后再 @ 不算转交', R('先说结论。\n@opencode 你补充', 'human', 'dsh') === 'human');
}

// ---------------- 10. 时效闸 ----------------
section('10. 时效闸');
{
  // 起因：#64「你好」在 37 分钟后才被回答。反循环闸是「最近 20 条」的滑动窗口，
  // 跟时间没关系——20 条新消息进来，老消息自动解禁。时效必须按时间判。
  const cfg0 = { autoChat: true, maxHop: 3, pausedUntil: 0, hopReset: {} };
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const m = (over) => ({ seq: 1, from: "human", to: "hermes", mentions: "hermes",
    hop: 0, via: "human", text: "你好", ts: ago(over) });

  ok('1 分钟前的消息照常投喂', gates.gate(m(60_000), { me: 'hermes', all: [m(60_000)], config: cfg0 }).ok === true);
  {
    const mm = m(10 * 60_000);
    const g = gates.gate(mm, { me: "hermes", all: [mm], config: cfg0 });
    ok('10 分钟没人接 → 过期', g.ok === false && g.reason === 'stale', JSON.stringify(g));
    ok('过期文案带上真实分钟数', /10\s*分钟/.test(g.detail || ''), g.detail);
  }
  {
    // maxAgeMs 可配置，且能放宽到比默认更长
    const mm = m(10 * 60_000);
    const g = gates.gate(mm, { me: "hermes", all: [mm], config: { ...cfg0, maxAgeMs: 20 * 60_000 } });
    ok('maxAgeMs 可调：放宽到 20 分钟后放行', g.ok === true, JSON.stringify(g));
  }
  {
    // 没 ts 字段的老消息不能因为时效闸被卡死
    const mm = { seq: 1, from: "human", to: "hermes", mentions: "hermes", hop: 0, via: "human", text: "x" };
    const g = gates.gate(mm, { me: "hermes", all: [mm], config: cfg0 });
    ok('缺 ts 的老消息不受时效闸影响', g.ok === true, JSON.stringify(g));
  }
}
// ---------------- 11. 改动检测（不拦截） ----------------
section('11. 工作目录改动检测');
{
  // dsh 走 headless，没有工具流可拦；只有 hermes/opencode 有 ACP tool_call 事件。
  // 三者能力不一致，硬拦两个会给人虚假的安全感 —— 所以统一做成「检测并说出来」。
  // 这里钉死两个已知盲区：运行时文件要忽略、已改动文件再改一次不能漏。
  const { snapshotWorkdir } = await import('../drivers/driver.mjs');

  const D = path.join(TMP, "snapdir");
  fs.rmSync(D, { recursive: true, force: true });
  fs.mkdirSync(D, { recursive: true });
  const W = (n, c) => fs.writeFileSync(path.join(D, n), c, "utf8");

  // A. 运行时文件不算改动
  W("room.jsonl", "a"); W(".cursor-x.json", "a"); W("busd.log", "a");
  const sA = snapshotWorkdir(D);
  W("room.jsonl", "bbbb"); W(".cursor-x.json", "bbbb"); W("busd.log", "bbbb");
  const sA2 = snapshotWorkdir(D);
  ok('运行时文件的变化不算改动', sA === sA2);

  // B. 新建文件要发现
  const sB = snapshotWorkdir(D);
  W("doc.txt", "v1");
  ok('新建文件能发现', snapshotWorkdir(D) !== sB);

  // C. **盲区**：文件已存在、投喂期间内容被改 —— 只看 git status 会漏，
  //     因为 --porcelain 两次都输出同一个文件名，字符串没变。
  W("doc.txt", "v2");
  const sC = snapshotWorkdir(D);
  W("doc.txt", "v3 内容又变了");
  ok('已存在文件的内容改动能发现', snapshotWorkdir(D) !== sC);

  // D. 同样大小、只改内容（size 相同，靠 mtime）
  W("doc.txt", "v4 同长度改");
  const sD = snapshotWorkdir(D);
  W("doc.txt", "v5 同长度改");
  ok('同长度改内容也能发现', snapshotWorkdir(D) !== sD);

  // E. 空转不能误报
  const sE = snapshotWorkdir(D);
  ok('无改动时快照稳定', snapshotWorkdir(D) === sE);

  // F. 子目录也要扫到（agent 可能在子目录里改）
  fs.mkdirSync(path.join(D, "sub"), { recursive: true });
  W("sub/inner.txt", "x");
  const sF = snapshotWorkdir(D);
  W("sub/inner.txt", "yyy");
  ok('子目录里的改动能发现', snapshotWorkdir(D) !== sF);

  fs.rmSync(D, { recursive: true, force: true });
}
// ---------------- 12. 群聊：每个 agent 是独立个体 ----------------
section('12. 群聊语义：独立个体，各说各的');
{
  // 旧语义是「广播一人回复」：三个人里抢到的那个答，另外两个直接跳过。
  // 那不是群聊，是三个答题机共用一个名额。新语义下：
  //   - 群消息三个人都看得到
  //   - 各自决定说不说（沉默用 [SKIP]）
  //   - 接得上同伴的话（回我的话、我参与过的线程里后续的发言）
  //   - 点名仍然只给那一个人
  const cfg = { autoChat: true, maxHop: 3, hopReset: {}, groupChat: true };
  const mk = (seq, from, to, extra = {}) => ({
    seq, from, to, mentions: to, text: "t" + seq, hop: 0, via: "human", thread: "t-" + seq, ...extra,
  });

  // A. 群消息：三个人都看得到
  const b = { seq: 1, from: "human", to: "*", mentions: "*", text: "大家好", hop: 0, via: "human", thread: "t-g" };
  for (const who of ['hermes', 'opencode', 'dsh']) {
    ok(`群消息：${who} 看得到`, gates.gate(b, { me: who, all: [b], config: cfg }).ok);
  }

  // B. 接得上同伴的话：别人回复了我写的消息，我看得到
  const mine = mk(10, "hermes", "human", { via: "driver:hermes", hop: 1 });
  const replyToMe = mk(11, "opencode", "human", {
    via: "driver:opencode", hop: 2, reply_to: 10, thread: "t-10", text: "我不同意",
  });
  ok('别人回了我的话 → 我看得到（能接得上）',
    gates.gate(replyToMe, { me: 'hermes', all: [mine, replyToMe], config: cfg }).ok);

  // C. 我参与过的线程里，后续发言我也看得到
  const inMyThread = mk(12, "dsh", "opencode", {
    via: "driver:dsh", hop: 1, thread: "t-10", text: "插一句",
  });
  ok('我参与过的线程里的后续发言 → 我看得到',
    gates.gate(inMyThread, { me: 'hermes', all: [mine, inMyThread], config: cfg }).ok);

  // D. 与我无关的线程：不该打扰我（否则每条消息都会惊动三个人）
  const other = mk(20, "dsh", "opencode", { via: "driver:dsh", hop: 1, thread: "t-other" });
  ok('与我无关的线程 → 不打扰我',
    gates.gate(other, { me: 'hermes', all: [other], config: cfg }).reason === 'not-named');

  // E. 点名仍然只给那一个人
  const named = mk(30, "human", "opencode", { via: "human" });
  ok('点名 opencode → opencode 看得到', gates.gate(named, { me: 'opencode', all: [named], config: cfg }).ok);
  ok("点名 opencode → hermes 不被打扰",
    gates.gate(named, { me: 'hermes', all: [named], config: cfg }).reason === 'not-named');

  // F. 群聊关掉就退回旧行为（一人回复）
  const cfgOld = { ...cfg, groupChat: false };
  ok("groupChat:false → 已被抢答的不投喂",
    gates.gate(b, { me: 'hermes', all: [b], config: cfgOld, claimed: new Set([1]) }).reason === 'claimed');
}
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
console.log(`验收 runtime: ${TMP}`);
process.exit(fail ? 1 : 0);
