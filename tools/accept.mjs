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
// ---------------- 13. 心跳：长任务期间不能显示离线 ----------------
section('13. 长任务期间心跳要续');
{
  // 心跳原来只在投喂前写一次，而一轮 LLM 可能跑几十秒。busd 判在线的窗口
  // 是 8 秒，于是正在思考的 agent 在界面上看起来像死了 —— 人只能挨个问
  // 「你在线吗」。这条用例锁住：ask 期间心跳必须持续刷新。
  const { runDriver } = await import("../drivers/driver.mjs");
  fs.writeFileSync(path.join(TMP, "room.jsonl"), "", "utf8");
  fs.rmSync(path.join(TMP, ".claims.jsonl"), { force: true });
  fs.rmSync(path.join(TMP, ".cursor-hermes.json"), { force: true });
  writeConfig({ autoChat: true, maxHop: 3, pausedUntil: 0, pauseReason: '', hopReset: {}, groupChat: true });

  const hb = path.join(TMP, ".heartbeat-hermes.json");
  const quiet = async () => ({ ask: async () => "x", close: () => {} });
  // 第一次只建基线（房间是空的，没有待处理消息）
  await runDriver({ name: 'hermes', createSession: quiet, once: true, intervalMs: 10, pulseMs: 40 });

  append({ from: 'human', text: '慢慢想', to: '*', mentions: '*', via: 'human', thread: 't-hb' });

  let before = 0;
  let during = null;
  const slow = async () => ({
    ask: async () => {
      before = JSON.parse(fs.readFileSync(hb, "utf8")).ts;
      await new Promise((r) => setTimeout(r, 300));
      during = JSON.parse(fs.readFileSync(hb, "utf8"));
      return "想完了";
    },
    close: () => {},
  });
  await runDriver({ name: 'hermes', createSession: slow, once: true, intervalMs: 10, pulseMs: 40 });

  ok("ask 期间心跳有刷新（不是只在投喂前写一次）",
    during && during.ts > before, `before=${before} during=${during && during.ts}`);
  ok("ask 期间状态是 thinking", during && during.state === "thinking", JSON.stringify(during));

  // C. 建会话期间也要报活（ACP 冷启动实测 ~10 秒，比 8 秒窗口还长）
  append({ from: 'human', text: '再想一个', to: '*', mentions: '*', via: 'human', thread: 't-hb2' });
  let bootBefore = 0;
  let bootDuring = null;
  const slowBoot = async () => {
    bootBefore = JSON.parse(fs.readFileSync(hb, "utf8")).ts;
    await new Promise((r) => setTimeout(r, 300));
    bootDuring = JSON.parse(fs.readFileSync(hb, "utf8"));
    return { ask: async () => "ok", close: () => {} };
  };
  await runDriver({ name: 'hermes', createSession: slowBoot, once: true, intervalMs: 10, pulseMs: 40 });
  ok("建会话期间心跳有刷新",
    bootDuring && bootDuring.ts > bootBefore, `before=${bootBefore} during=${bootDuring && bootDuring.ts}`);
  ok("建会话期间状态是 starting", bootDuring && bootDuring.state === "starting", JSON.stringify(bootDuring));

  // 跨文件不变量：心跳间隔必须小于 busd 判在线的窗口，否则会闪成离线
  const drvSrc = fs.readFileSync(path.join(REPO, "drivers/driver.mjs"), "utf8");
  const busdSrc = fs.readFileSync(path.join(REPO, "webui/busd.mjs"), "utf8");
  const pm = drvSrc.match(/pulseMs = (\d+)/);
  const wm = busdSrc.match(/Date\.now\(\) - o\.ts < (\d+)/);
  ok("心跳间隔 < 判在线窗口", pm && wm && Number(pm[1]) < Number(wm[1]),
    `pulse=${pm && pm[1]} window=${wm && wm[1]}`);
}

// ---------------- 14. 人说话必须有人接 ----------------
section('14. 人说话不许被静默吞掉');
{
  // 实测事故：human 在群里发「早上好」两次，三条全回 [SKIP]，第二次还被
  // 反循环闸判成 loop —— 界面上只剩一句「判为循环」。群里看起来就是没人。
  // 这组用例钉死三件事：
  //   1. 反循环闸只管 agent 之间的话，人重复发不算循环
  //   2. prompt 对 human 的消息不给沉默出口
  //   3. 诊断要能说出「它们主动选择了沉默」，而不是谎称「已经回过」
  const { buildPrompt } = await import("../drivers/driver.mjs");
  const { makeDiagnose } = await import("../lib/diagnose.mjs");
  const cfg = { autoChat: true, maxHop: 3, hopReset: {}, groupChat: true };

  const mkM = (o) => ({ ts: new Date().toISOString(), kind: "msg", task: 0, thread: "t1",
    reply_to: 0, mentions: "", hop: 0, via: "human", ...o });

  // A. 人重复发同一句：不算循环
  const hello1 = mkM({ seq: 1, from: "human", to: "*", mentions: "*", text: "早上好" });
  const hello2 = mkM({ seq: 2, from: "human", to: "*", mentions: "*", text: "早上好" });
  ok("人重复发同一句 → 仍然投喂（不是循环）",
    gates.gate(hello2, { me: "hermes", all: [hello1, hello2], config: cfg }).ok);

  // B. agent 之间重复：仍然判循环
  const a1 = mkM({ seq: 3, from: "dsh", to: "*", mentions: "*", text: "收到", hop: 1, via: "driver:dsh" });
  const a2 = mkM({ seq: 4, from: "dsh", to: "*", mentions: "*", text: "收到", hop: 1, via: "driver:dsh" });
  ok("agent 重复发同一句 → 判循环",
    gates.gate(a2, { me: "hermes", all: [a1, a2], config: cfg }).reason === "loop");

  // C. prompt：human 的消息、还没人回 → 明确不许沉默
  const p1 = buildPrompt(hello1, "hermes", [hello1]);
  ok("prompt 对没人回的 human 消息说「不能沉默」", p1.includes("不能沉默"), p1.slice(0, 160));
  ok("prompt 不再把「寒暄」当沉默理由", !p1.includes("纯粹是寒暄"));

  // D. prompt：已经有人回过 → 允许跳过，但不许重复
  const helloReply = mkM({ seq: 5, from: "dsh", to: "human", hop: 1, via: "driver:dsh", reply_to: 1, text: "早" });
  const p2 = buildPrompt(hello1, "hermes", [hello1, helloReply]);
  ok("prompt 对已有人回的 human 消息允许跳过", p2.includes("已经有人回过"), p2.slice(0, 160));

  // E. prompt：agent 之间仍然可以沉默
  const peerMsg = mkM({ seq: 6, from: "dsh", to: "hermes", mentions: "hermes", hop: 1, via: "driver:dsh", text: "收到" });
  const p3 = buildPrompt(peerMsg, "hermes", [peerMsg]);
  ok("prompt 对同伴的消息允许 [SKIP]", p3.includes("[SKIP]"), p3.slice(0, 160));

  // F. 诊断：三条都主动沉默 → 说「主动选择了沉默」，不许谎称「已经回过」
  const D = makeDiagnose({ root: TMP, members: ["dsh", "hermes", "opencode"] });
  const MEMBS = ["dsh", "hermes", "opencode"];
  const putRoom = (msgs) => fs.writeFileSync(path.join(TMP, "room.jsonl"),
    msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf8");
  const putStream = (n, seq, type) => fs.writeFileSync(path.join(TMP, `stream-${n}.jsonl`),
    JSON.stringify({ ts: Date.now(), seq, type }) + "\n", "utf8");
  const setAll = (seq, type) => {
    for (const n of MEMBS) {
      fs.writeFileSync(path.join(TMP, `stream-${n}.jsonl`), "", "utf8");
      fs.writeFileSync(path.join(TMP, `.cursor-${n}.json`),
        JSON.stringify({ consumed: [seq], lastSeq: seq, baseline: 0 }), "utf8");
      fs.writeFileSync(path.join(TMP, `.heartbeat-${n}.json`),
        JSON.stringify({ name: n, ts: Date.now(), state: "idle" }), "utf8");
      putStream(n, seq, type);
    }
    fs.rmSync(path.join(TMP, ".claims.jsonl"), { force: true });
  };

  putRoom([hello1]);
  setAll(1, "skipped");
  {
    const all = readAll();
    const t = D.diagnose(all[0], all, cfg);
    ok("三条都沉默时如实说「主动选择了沉默」", t.includes("主动选择了沉默"), t);
    ok("不再谎称「它已经回过这条」", !t.includes("已经回过这条"), t);
  }

  // G. 点名 + 沉默：说清是它自己不接，不是没 driver
  putRoom([mkM({ seq: 2, from: "human", to: "hermes", mentions: "hermes", text: "hermes 在吗" })]);
  setAll(2, "skipped");
  {
    const all = readAll();
    const t = D.diagnose(all[0], all, cfg);
    ok("点名 + 沉默 → 说它自己选择不说话", t.includes("@hermes 在线") && t.includes("选择不说话"), t);
  }

  // H. 真回过：以日志里的 reply_to 为准，不看 stream 的 replied 事件。
  //    stream 里的 replied 记的是「回复那条」的 seq（driver.mjs:453 用 out.seq），
  //    拿它比对被回的 seq 永远查不到 —— 这是实测 #145 暴露的第二个坑。
  putRoom([hello1,
    mkM({ seq: 9, from: "dsh", to: "human", hop: 1, via: "driver:dsh", reply_to: 1, text: "早" })]);
  for (const n of MEMBS) {
    fs.writeFileSync(path.join(TMP, `stream-${n}.jsonl`),
      JSON.stringify({ ts: Date.now(), seq: 9, type: "replied", hop: 1 }) + "\n", "utf8");
    fs.writeFileSync(path.join(TMP, `.cursor-${n}.json`),
      JSON.stringify({ consumed: [1], lastSeq: 1, baseline: 0 }), "utf8");
    fs.writeFileSync(path.join(TMP, `.heartbeat-${n}.json`),
      JSON.stringify({ name: n, ts: Date.now(), state: "idle" }), "utf8");
  }
  {
    const all = readAll();
    const rows = D.why(all[0], all, cfg);
    const dshRow = rows.find((r) => r.agent === "dsh");
    const hermesRow = rows.find((r) => r.agent === "hermes");
    ok("回过的那位 → 判为 replied", dshRow.reason === "replied", JSON.stringify(dshRow));
    ok("没开口的那位 → 不冒充 replied", hermesRow.reason !== "replied", JSON.stringify(hermesRow));
  }
}

// ---------------- 15. 谁起头谁主持（秩序机制） ----------------
section('15. 谁起头谁主持：定规则 + 维护秩序');
{
  // 实测 #333：human 说「来成语接龙 ceo起头」，五个人各自起了马到成功/一心一意/
  // 首屈一指…四个头，然后一百多条全在吵「谁是 ceo、哪条龙才算数」。
  // 根因：群里根本没有「这一场谁说了算」的概念。现在用一份显式 floor 状态：
  // 谁被指定 → 它第一个开口且定规则；别人抢跑或不按规则接，由它叫停。
  const F = await import("../lib/floor.mjs");

  // A. 角色词 → ceo.txt 里的人
  {
    const r = F.detectLead("来成语接龙 ceo起头", { ceo: "dsh", members: ["dsh","hermes","opencode"] });
    ok("角色词 ceo → 指定 ceo.txt 的人", r.lead && r.target === "dsh" && r.how === "role");
  }

  // B. 显式 @名字 优先于角色词
  {
    const r = F.detectLead("来接龙 @hermes 起头，ceo 别抢", { ceo: "dsh", members: ["dsh","hermes","opencode"] });
    ok("@名字 优先于角色词", r.lead && r.target === "hermes" && r.how === "mention");
  }

  // C. 只有「起头」动词才触发，普通聊天不触发
  {
    const r = F.detectLead("今天天气不错", { ceo: "dsh", members: ["dsh"] });
    ok("没有起头动词 → 不触发主持", !r.lead);
    const r2 = F.detectLead("ceo 你觉得呢", { ceo: "dsh", members: ["dsh"] });
    ok("只提 ceo 没说起头 → 不触发", !r2.lead);
  }

  // D. 语义指定：target=null，谁认领谁上（原子抢）
  {
    fs.rmSync(path.join(TMP, ".floor.json"), { force: true });
    const r1 = F.claimFloor(TMP, { seq: 100, me: "hermes", allowed: null });
    ok("语义指定：先到先得，第一个认领者赢", r1.won && r1.floor.leader === "hermes");
    const r2 = F.claimFloor(TMP, { seq: 100, me: "opencode", allowed: null });
    ok("语义指定：后来的认领被拒", !r2.won);
  }

  // E. 显式指定：非目标认领被拒
  {
    fs.rmSync(path.join(TMP, ".floor.json"), { force: true });
    const r1 = F.claimFloor(TMP, { seq: 101, me: "dsh", allowed: "dsh" });
    ok("显式指定：目标认领成功", r1.won && r1.floor.leader === "dsh");
    const r2 = F.claimFloor(TMP, { seq: 101, me: "hermes", allowed: "dsh" });
    ok("显式指定：非目标认领被拒", !r2.won);
  }

  // F. 主持人开场后登记规则，brief 让后面的人照接
  {
    F.setOpening(TMP, { seq: 101, me: "dsh", text: "四字成语，尾字接首字，不许谐音" });
    const fl = F.readFloor(TMP);
    const briefOther = F.floorBrief(fl, "hermes");
    ok("开场后别人看到规则", briefOther.includes("四字成语") && briefOther.includes("dsh"));
    const briefLead = F.floorBrief(fl, "dsh");
    ok("主持人自己不被要求等", !briefLead.includes("先别抢头"));
  }

  // G. 没开场时别人看到「先别抢头」
  {
    fs.rmSync(path.join(TMP, ".floor.json"), { force: true });
    const fl = F.claimFloor(TMP, { seq: 102, me: "dsh", allowed: "dsh" }).floor;
    const briefOther = F.floorBrief(fl, "opencode");
    ok("主持人没开场 → 别人先别抢头", briefOther.includes("先别抢头"));
  }

  // H. prompt：被指定的人被要求定规则；其余人等开场
  {
    const { buildPrompt } = await import("../drivers/driver.mjs");
    const mkH = (seq, text) => ({ ts: new Date().toISOString(), kind: "msg", from: "human", to: "*", mentions: "*", text, hop: 0, via: "human", seq, reply_to: 0 });
    fs.rmSync(path.join(TMP, ".floor.json"), { force: true });
    const fl = F.claimFloor(TMP, { seq: 200, me: "dsh", allowed: "dsh" }).floor;
    const pLead = buildPrompt(mkH(200, "来成语接龙 ceo起头"), "dsh", [mkH(200, "来成语接龙 ceo起头")], fl);
    ok("prompt：主持人被要求先说并定规则", pLead.includes("定规则") && !pLead.includes("先别抢头"));
    const pWait = buildPrompt(mkH(200, "来成语接龙 ceo起头"), "opencode", [mkH(200, "来成语接龙 ceo起头")], fl);
    ok("prompt：非主持人等开场、不抢头", pWait.includes("先别抢头") && pWait.includes("[SKIP]"));
    const pCeo = buildPrompt(mkH(200, "来成语接龙 ceo起头"), "dsh", [mkH(200, "来成语接龙 ceo起头")], fl);
    ok("prompt：被指定的 CEO 知道自己是 CEO（不问 ceo 是谁）", pCeo.includes("CEO 是 dsh"));
  }

  // 收尾
  fs.rmSync(path.join(TMP, ".floor.json"), { force: true });
  fs.rmSync(path.join(TMP, ".floor.lock"), { force: true });
}

// ---------------- 16. 共享棋盘 + 轮次锁 + 回复数封顶 ----------------
section('16. 共享棋盘 / 轮次锁 / 回复数封顶');

// A. [BOARD] 抽出补丁、从可见文本剥掉
{
  const T = await import("../lib/task.mjs");
  const r1 = T.extractBoard("接「强」：强词夺理 [BOARD] {\"tail\":\"强\",\"chain\":[\"一心一意\",\"强词夺理\"]}");
  ok("BOARD：可见文本剥掉旁信道", !r1.text.includes("[BOARD]") && r1.text.includes("强词夺理"));
  ok("BOARD：补丁被解析", r1.patch && r1.patch.tail === "强" && Array.isArray(r1.patch.chain));
  const r2 = T.extractBoard("没有棋盘的一句普通回复");
  ok("BOARD：无标记文本原样返回", r2.text === "没有棋盘的一句普通回复" && r2.patch === null);
}

// B. applyPatch 累积数组、覆盖标量
{
  const T = await import("../lib/task.mjs");
  let b = T.applyPatch(null, { kind: "idiom", tail: "意", chain: ["一心一意"] });
  b = T.applyPatch(b, { tail: "强", chain: ["强词夺理"] });
  ok("BOARD：数组累积", b.chain.length === 2 && b.chain[1] === "强词夺理");
  ok("BOARD：标量覆盖", b.tail === "强");
  // seq 不被补丁覆盖
  b = T.applyPatch(b, { seq: 999 });
  ok("BOARD：seq 不受补丁覆盖", b.seq === undefined || b.seq !== 999);
  // 完整链条不重复：agent 发全量时应该替换而不是 concat 成两遍
  const full = T.applyPatch({ chain: ["一心一意", "强词夺理"] }, { chain: ["一心一意", "强词夺理", "理直气壮"] });
  ok("BOARD：完整链条去重", full.chain.length === 3 && full.chain[2] === "理直气壮");
  const inc = T.applyPatch({ chain: ["一心一意"] }, { chain: ["强词夺理"] });
  ok("BOARD：增量链条累积", inc.chain.length === 2);
}

// C. boardBrief 给出权威状态
{
  const T = await import("../lib/task.mjs");
  const b = { kind: "成语接龙", owner: "dsh", rule: "四字成语", head: "一心一意", tail: "强", turn: "hermes", chain: ["一心一意", "强词夺理"] };
  const s = T.boardBrief(b);
  ok("BOARD：brief 含尾字/链条/该谁接", s.includes("强") && s.includes("一心一意 → 强词夺理") && s.includes("hermes"));
}

// D. 轮次顺序：主持人队首 + ceo 优先 + 其余名字序
{
  const U = await import("../lib/turn.mjs");
  const order = U.orderFor({ text: "@opencode 来" }, { ceo: "dsh", members: ["dsh","hermes","opencode","pi","prime"] });
  ok("TURN：显式 @ 在最前", order[0] === "opencode");
  ok("TURN：ceo 在 @ 之后、其余之前", order.indexOf("dsh") === 1);
  ok("TURN：其余按名字序", order.slice(2).join(",") === "hermes,pi,prime");
}

// D2. 主持人自己定的顺序优先（实测 #456 主持人写了「我→hermes→pi→prime→opencode」）
{
  const U = await import("../lib/turn.mjs");
  const members = ["dsh", "hermes", "opencode", "pi", "prime"];
  const stated = U.parseOrder("顺序是 我→hermes→pi→prime→opencode→我", { leader: "dsh", members });
  ok("TURN：解析主持人自定顺序", Array.isArray(stated) && stated.join(",") === "dsh,hermes,pi,prime,opencode",
    `实际 ${JSON.stringify(stated)}`);
  const t = U.initTurn(TMP, { seq: 500, leader: "dsh", ceo: "dsh", members, order: stated });
  ok("TURN：initTurn 采用主持人自定顺序", t.order.join(",") === "dsh,hermes,pi,prime,opencode");
  ok("TURN：解析不出顺序时返回 null", U.parseOrder("大家随便聊", { leader: "dsh", members }) === null);
  fs.rmSync(path.join(TMP, ".turn.json"), { force: true });
}

// E. 主持人开场后 initTurn 把主持人放队首
{
  fs.rmSync(path.join(TMP, ".turn.json"), { force: true });
  const U = await import("../lib/turn.mjs");
  const t = U.initTurn(TMP, { seq: 300, leader: "dsh", ceo: "dsh", members: ["dsh","hermes","opencode"] });
  ok("TURN：initTurn 队首是主持人", t.order[0] === "dsh" && t.idx === 0);
  const a = U.acquireTurn(TMP, { seq: 300, me: "dsh" });
  ok("TURN：主持人轮到开口", a.speaking && a.who === "dsh");
  const a2 = U.acquireTurn(TMP, { seq: 300, me: "hermes" });
  ok("TURN：非持棒者被拦", !a2.speaking && a2.reason === "not-your-turn");
  const t2 = U.advanceTurn(TMP, { seq: 300, me: "dsh" });
  ok("TURN：advance 后轮到 hermes", t2.order[t2.idx] === "hermes");
  const a3 = U.acquireTurn(TMP, { seq: 300, me: "hermes" });
  ok("TURN：advance 后 hermes 可开口", a3.speaking);
  fs.rmSync(path.join(TMP, ".turn.json"), { force: true });
}

// F. 租约超时自动让位
{
  const U = await import("../lib/turn.mjs");
  U.initTurn(TMP, { seq: 301, leader: "dsh", ceo: "dsh", members: ["dsh","hermes","opencode"] });
  const a = U.acquireTurn(TMP, { seq: 301, me: "dsh", now: Date.now() + 999999 });
  ok("TURN：租约超时自动跳下一位", !a.speaking && a.who === "hermes");
  fs.rmSync(path.join(TMP, ".turn.json"), { force: true });
}

// G. maxRepliesPerSeq 闸
{
  const G = await import("../lib/gates.mjs");
  const cfg = { groupChat: true, maxRepliesPerSeq: 3 };
  const msg = { seq: 1, from: "human", to: "*", mentions: "*", hop: 0, via: "human" };
  const all = [
    msg,
    { seq: 10, from: "dsh", reply_to: 1, via: "driver:dsh" },
    { seq: 11, from: "hermes", reply_to: 1, via: "driver:hermes" },
    { seq: 12, from: "opencode", reply_to: 1, via: "driver:opencode" },
  ];
  const g = G.gate(msg, { me: "pi", all, consumed: new Set(), config: cfg });
  ok("GATES：回复数达上限 → 封顶", !g.ok && g.reason === "max-replies");
  const g2 = G.gate(msg, { me: "pi", all: all.slice(0, 3), consumed: new Set(), config: cfg });
  ok("GATES：未达上限 → 仍可投喂", g2.ok);
  const g3 = G.gate(msg, { me: "pi", all, consumed: new Set(), config: { groupChat: true } });
  ok("GATES：默认 0 = 不限制", g3.ok);
  fs.rmSync(path.join(TMP, ".turn.json"), { force: true });
}

// H. cursorSeq：只有「最新一条 + 轮到我」才能接，杜绝分叉
{
  const U = await import("../lib/turn.mjs");
  fs.rmSync(path.join(TMP, ".turn.json"), { force: true });
  U.initTurn(TMP, { seq: 400, leader: "dsh", ceo: "dsh", members: ["dsh","hermes","opencode"], cursorSeq: 334 });
  U.advanceTurn(TMP, { seq: 400, me: "dsh", nextSeq: 334 });
  const h = U.acquireTurn(TMP, { seq: 400, me: "hermes", msgSeq: 334 });
  ok("TURN：hermes 接最新一条", h.speaking && h.who === "hermes");
  const o = U.acquireTurn(TMP, { seq: 400, me: "opencode", msgSeq: 334 });
  ok("TURN：没轮到的人不能接", !o.speaking && o.reason === "not-your-turn");
  const old = U.acquireTurn(TMP, { seq: 400, me: "hermes", msgSeq: 333 });
  ok("TURN：老消息不能再接（防分叉）", !old.speaking && old.reason === "not-latest");
  U.advanceTurn(TMP, { seq: 400, me: "hermes", nextSeq: 335 });
  const o2 = U.acquireTurn(TMP, { seq: 400, me: "opencode", msgSeq: 335 });
  ok("TURN：链条前进后轮到 opencode", o2.speaking);
  const hOld = U.acquireTurn(TMP, { seq: 400, me: "hermes", msgSeq: 334 });
  ok("TURN：接过的消息不能再接", !hOld.speaking);
  fs.rmSync(path.join(TMP, ".turn.json"), { force: true });
}

// I. activeThread：主持场次对全员可见（否则链传不下去）
{
  const G = await import("../lib/gates.mjs");
  const msg = { seq: 50, from: "dsh", to: "human", thread: "t-40", mentions: "", hop: 1, via: "driver:dsh" };
  const g = G.gate(msg, { me: "hermes", all: [msg], consumed: new Set(), config: { groupChat: true, activeThread: "t-40" } });
  ok("GATES：主持场次对全员可见", g.ok);
  const g2 = G.gate(msg, { me: "hermes", all: [msg], consumed: new Set(), config: { groupChat: true } });
  ok("GATES：非主持场次仍按点名/线程判", !g2.ok);
  fs.rmSync(path.join(TMP, ".turn.json"), { force: true });
}



console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
console.log(`验收 runtime: ${TMP}`);
process.exit(fail ? 1 : 0);
