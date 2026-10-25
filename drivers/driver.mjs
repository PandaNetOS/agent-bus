/**
 * drivers/driver.mjs — 通用驱动循环
 *
 * 一个 driver = 一个 agent 的耳朵和嘴：
 *   轮询总线 → 过六闸 → 投喂自己的 agent → 把回复写回总线
 *
 * 三件事它必须做对：
 *   1. 先写游标再投喂。反过来一旦中途崩溃，重启会重复回答同一条，两边各说一遍。
 *   2. 熔断由自己判（读同一份 gates 实现），不依赖 busd 活着。
 *   3. agent 崩了就重启会话，不退出进程——一个 driver 挂了不该需要人手动拉起。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readAll, append } from '../lib/bus.mjs';
import { ensureConfig, readConfig, writeConfig } from '../lib/config.mjs';
import { pending, replyContext, breakerState, gate, names } from '../lib/gates.mjs';

const MAX_REPLY_CHARS = 2000;
const CONSUMED_KEEP = 200;
const AGENT_NAMES = (process.env.AGENT_BUS_MEMBERS || 'dsh,hermes,opencode')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * 回复里的 @名字 决定这条消息寄给谁。
 * 没有这个，agent 只能回给发消息的人，A 就没法把活转给 B —— 那还是留言板。
 */
function routeReply(text, fallback, me) {
  const found = [...String(text || '').matchAll(/@([a-z0-9_-]+)/gi)]
    .map((m) => m[1].toLowerCase())
    .filter((n) => n !== me.toLowerCase() && AGENT_NAMES.includes(n));
  return found.length ? found[0] : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cursorPath(name) { return path.join(ROOT, `.cursor-${name}.json`); }
function heartbeatPath(name) { return path.join(ROOT, `.heartbeat-${name}.json`); }
function streamPath(name) { return path.join(ROOT, `stream-${name}.jsonl`); }

function loadCursor(name) {
  try {
    const o = JSON.parse(fs.readFileSync(cursorPath(name), 'utf8'));
    return { consumed: new Set(o.consumed || []), lastSeq: o.lastSeq || 0, baseline: o.baseline ?? 0, fresh: false };
  } catch {
    return { consumed: new Set(), lastSeq: 0, baseline: 0, fresh: true };
  }
}

function saveCursor(name, cursor) {
  const arr = [...cursor.consumed].sort((a, b) => a - b).slice(-CONSUMED_KEEP);
  fs.writeFileSync(cursorPath(name), JSON.stringify({ consumed: arr, lastSeq: cursor.lastSeq, baseline: cursor.baseline }), 'utf8');
}

function heartbeat(name, patch) {
  try {
    fs.writeFileSync(heartbeatPath(name), JSON.stringify({ name, ts: Date.now(), ...patch }), 'utf8');
  } catch {}
}

/** 事件流落文件，busd 用 tail 的方式读，driver 不依赖 busd 在线 */
function makeEmitter(name, seq) {
  return (e) => {
    try {
      fs.appendFileSync(streamPath(name), JSON.stringify({ ts: Date.now(), seq, ...e }) + '\n', 'utf8');
    } catch {}
  };
}

function trimStream(name, keep = 400) {
  try {
    const p = streamPath(name);
    if (!fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    if (lines.length > keep * 2) {
      fs.writeFileSync(p, lines.slice(-keep).join('\n') + '\n', 'utf8');
    }
  } catch {}
}

/** 把总线消息包成给 agent 的指令 */
export function buildPrompt(msg, me) {
  const ctx = replyContext(msg, me);
  const others = AGENT_NAMES.filter((n) => n !== me.toLowerCase());
  const busPs1 = path.join(ROOT, 'bus.ps1');
  return [
    `你在 agent-bus 共享消息总线上，身份是 ${me}。`,
    `收到一条来自 ${msg.from} 的消息（seq #${msg.seq}，第 ${ctx.hop} 跳）：`,
    '',
    `「${msg.text}」`,
    '',
    '直接回答对方。规则：',
    `1. 你的回复会被系统自动发成一条总线消息，收件人默认是 ${msg.from}。`,
    '   **不要自己运行 bus.ps1 发消息**——会重复，而且绕过系统的闸门。',
    `2. 想把问题交给别人，就在回复里写 @名字（可选：${others.join(' / ')}），系统会自动改投给他。`,
    '3. 300 字内，说结论和下一步；不要复述指令，不要说「收到」。',
    '4. 要看历史可以用（只读，不会发消息）：',
    `   powershell -NoProfile -ExecutionPolicy Bypass -File "${busPs1}" tail -Limit 20`,
    '5. 除非对方明确要求，不要修改任何文件。',
  ].join('\n');
}

/**
 * @param {object} opts
 * @param {string} opts.name                    agent 名（dsh / hermes / opencode）
 * @param {() => Promise<{ask:(text:string)=>Promise<string>,close:()=>void,ready?:boolean}>} opts.createSession
 * @param {number} [opts.intervalMs]
 * @param {string} [opts.workdir]
 */
export async function runDriver({ name, createSession, intervalMs = 1500, workdir = ROOT, once = false, replay = false }) {
  ensureConfig();
  const cursor = loadCursor(name);
  trimStream(name);

  // 首次启动（没有游标文件）：基线设为当前最新 seq，历史消息一律不投喂。
  // 否则新装一个 driver、autoChat 一开，它会从 #1 开始把整个历史全回答一遍——
  // 那是几十轮 LLM 调用，而且内容早就过时了。要重放得显式 --replay。
  if (cursor.fresh) {
    const all = readAll();
    cursor.baseline = replay ? 0 : (all.length ? all[all.length - 1].seq : 0);
    cursor.lastSeq = cursor.baseline;
    cursor.fresh = false;
    saveCursor(name, cursor);
    log(name, `首次启动：基线 seq=${cursor.baseline}${replay ? '（--replay，会重放历史）' : '（历史消息不投喂）'}`);
  }

  let session = null;
  let failures = 0;
  let stopped = false;
  let currentEmit = () => {};

  process.on('SIGINT', () => { stopped = true; });
  process.on('SIGTERM', () => { stopped = true; });

  const ensureSession = async () => {
    if (session) return session;
    heartbeat(name, { state: 'starting' });
    // onEvent 走一个可变引用：会话是长命的，但每条消息的 emit 绑定不同的 seq
    session = await createSession({ onEvent: (e) => currentEmit(e) });
    heartbeat(name, { state: 'idle' });
    return session;
  };

  log(name, `driver 启动，游标 lastSeq=${cursor.lastSeq}，已消费 ${cursor.consumed.size} 条`);

  while (!stopped) {
    let cfg;
    try { cfg = readConfig(); } catch { cfg = ensureConfig(); }

    if (!cfg.autoChat) {
      heartbeat(name, { state: 'off', note: 'autoChat=false' });
      if (once) { log(name, '--once：autoChat=false，退出'); break; }
      await sleep(intervalMs);
      continue;
    }

    let all;
    try { all = readAll(); } catch (e) {
      log(name, `读日志失败: ${e.message}`);
      await sleep(intervalMs);
      continue;
    }

    // 熔断：窗口内自动消息超限 → 自己写 config 暂停，全体 driver 一起看到
    const br = breakerState(all);
    if (br.tripped) {
      writeConfig({
        pausedUntil: Date.now() + 60_000,
        pauseReason: `60 秒内自动消息 ${br.count} 条 > ${br.limit}`,
      });
      log(name, `熔断触发：${br.count} 条自动消息/60s，暂停 60 秒`);
      heartbeat(name, { state: 'breaker', note: br.count });
      if (once) break;
      await sleep(intervalMs);
      continue;
    }

    const todo = pending({ me: name, all, consumed: cursor.consumed, config: cfg })
      .filter((m) => m.seq > cursor.baseline);
    if (!todo.length) {
      heartbeat(name, { state: 'idle', lastSeq: cursor.lastSeq });
      if (once) { log(name, '--once：没有待处理消息，退出'); break; }
      await sleep(intervalMs);
      continue;
    }

    const msg = todo[0];
    // 先落游标再投喂：中途崩溃重启也不会重复回答
    cursor.consumed.add(msg.seq);
    cursor.lastSeq = msg.seq;
    saveCursor(name, cursor);

    heartbeat(name, { state: 'thinking', currentSeq: msg.seq });
    const emit = makeEmitter(name, msg.seq);
    currentEmit = emit;

    try {
      const s = await ensureSession();
      const reply = await s.ask(buildPrompt(msg, name));
      const text = String(reply || '').trim().slice(0, MAX_REPLY_CHARS) || '(无文本输出)';
      const ctx = replyContext(msg, name);
      const target = routeReply(text, ctx.to, name);
      const out = append({
        from: name,
        kind: 'msg',
        to: target,
        text,
        thread: ctx.thread,
        reply_to: ctx.reply_to,
        mentions: target,
        hop: ctx.hop,
        via: ctx.via,
      });
      emit({ type: 'replied', seq: out.seq, hop: ctx.hop, to: ctx.to });
      log(name, `#${msg.seq} → 回复 #${out.seq} (hop ${ctx.hop}) 给 ${ctx.to}`);
      failures = 0;
    } catch (e) {
      failures++;
      log(name, `处理 #${msg.seq} 失败(${failures}): ${e.message}`);
      emit({ type: 'error', message: e.message });
      try { session?.close?.(); } catch {}
      session = null;
      if (failures >= 3) {
        writeConfig({ pausedUntil: Date.now() + 30_000, pauseReason: `${name} 连续失败 ${failures} 次` });
        log(name, '连续失败 3 次，暂停 30 秒');
        failures = 0;
      }
      await sleep(2000);
    }

    heartbeat(name, { state: 'idle', lastSeq: cursor.lastSeq });
    if (once) { log(name, '--once：已处理一条，退出'); break; }
  }

  try { session?.close?.(); } catch {}
  heartbeat(name, { state: 'off', note: 'stopped' });
}

function log(name, s) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${name}: ${s}`;
  console.log(line);
}

export { log };
