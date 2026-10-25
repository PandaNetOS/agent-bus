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
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, readAll, append, claimReply } from '../lib/bus.mjs';
import { ensureConfig, readConfig, writeConfig } from '../lib/config.mjs';
import { pending, replyContext, breakerState, gate, names, isBroadcast, BROADCAST } from '../lib/gates.mjs';

/** driver 进程内已抢到（或已知被别人抢走）的广播 seq */
const claimed = new Set();

const MAX_REPLY_CHARS = 2000;
const CONSUMED_KEEP = 200;
const AGENT_NAMES = (process.env.AGENT_BUS_MEMBERS || 'dsh,hermes,opencode')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * 回复里的 @名字 决定这条消息寄给谁。
 *
 * **只有写在最开头的 @名字 才算转交。** 正文中段的顺带提及不算。
 *
 * 原实现扫全文取第一个 @，于是 agent 写一句「我和 @opencode 双侧实据一致」，
 * 就把回给你的话改投给了 opencode —— 你问「下午好」，它回一句下午好，然后
 * 开始跟 opencode 开会，你在群里看到的是两个 agent 自说自话。实测 6 条
 * 被这样劫持（#62/#63/#64/#74/#79/#93）。
 *
 * 转交是重动作：这话从此不回给问它的人了。重动作必须显式、可预测，
 * 而且 agent 能学会——「想转交就把 @名字 放第一行」比「别在正文里提人」好教。
 *
 * 导出是为了能测：它被埋在 driver 里当私有函数时，上面那个 bug 没法钉。
 */
export function routeReply(text, fallback, me, agentNames = AGENT_NAMES) {
  const head = String(text || '').trimStart();
  const m = head.match(/^@([a-z0-9_-]+)\b/i);
  if (!m) return fallback;
  const n = m[1].toLowerCase();
  // @自己 和 @不存在的人 都不算转交，退回默认收件人（问话的人）
  if (n === String(me).toLowerCase()) return fallback;
  if (!agentNames.map(String).includes(n)) return fallback;
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** bus 自己的运行时文件：driver 写这些是本职工作，不算「擅自改文件」 */
const RUNTIME_FILES = /^(room\.jsonl|ceo\.txt|hub-config\.json|\.claims\.jsonl|\.bus\.lock|\.cursor-.+|\.heartbeat-.+|\.pid-.+|stream-.+\.jsonl|.+\.log)$/i;

/** 递归扫文件时的跳过项：这些目录巨大且不是「工作成果」 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'build', '.next']);
const SCAN_MAX_FILES = 5000;   // 防呆：目录异常大时不要拖死轮询循环

/**
 * 工作目录快照。**检测，不是拦截。**
 *
 * 为什么不是拦截：三个 agent 里只有 hermes/opencode 走 ACP（有 tool_call 事件可拦），
 * dsh 走 `dsh headless`，整个回答就是一个黑盒进程，没有任何流事件。
 * 三者的拦截能力不一致，只拦两个会给人虚假的安全感。所以统一做成可见。
 *
 * 为什么两份判据缺一不可：
 *   - 只用 git status：文件在投喂前就已是 M 状态、投喂期间又改了一次，
 *     `status --porcelain` 两次都输出「M doc.txt」，字符串没变 → 漏报。
 *   - 只用文件扫描：抓得住内容变化，但可读性差（`doc.txt 12 1234567890`）。
 * 两份拼在一起：git 那份负责说人话，扫描那份负责不漏。
 *
 * 局限（如实记录）：
 *   - 分不清改动来自 agent 还是正在旁边手改的人，所以措辞是「本轮期间有改动」。
 *   - 靠 size + mtimeMs 判变化；同一毫秒内改完且大小不变会漏（agent 做不到这么快）。
 */
export function snapshotWorkdir(root = ROOT) {
  const parts = [];

  // 判据一：git status（说人话，也能抓新建/删除）
  try {
    // stdio 忽略 stderr：非 git 仓库时 git 会往 stderr 打
    // "fatal: not a git repository"，直接冒泡到 driver 的控制台，
    // 每轮一条，很快就把真正的日志淹了。
    const out = execFileSync('git', ['-C', root, 'status', '--porcelain'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    parts.push(out.split('\n').map((l) => l.trim()).filter(Boolean)
      .filter((l) => !RUNTIME_FILES.test(l.replace(/^\S+\s+/, '')))
      .sort().join('\n'));
  } catch { /* 不是 git 仓库，只靠扫描 */ }

  // 判据二：递归扫文件（抓「已改动文件再改一次」这个盲区）
  const files = [];
  const walk = (dir, rel) => {
    if (files.length >= SCAN_MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= SCAN_MAX_FILES) return;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (RUNTIME_FILES.test(e.name)) continue;
        try {
          const st = fs.statSync(path.join(dir, e.name));
          files.push(`${r} ${st.size} ${st.mtimeMs}`);
        } catch {}
      }
    }
  };
  walk(root, "");
  parts.push(files.sort().join("\n"));
  return parts.join('\n---\n');
}

/**
 * 比对前后快照，把改动记进 driver 日志和该 agent 的 stream。
 *
 * **不发总线消息**：那会变成一条新消息被别的 agent 再答一遍，而且读起来
 * 像 agent 自己说的话。改动是给人看的，走 stream 和日志就够了。
 */
function detectFileChanges(name, msg, emit, snapBefore, root) {
  let snapAfter;
  try { snapAfter = snapshotWorkdir(root); } catch { return; }
  if (snapAfter === snapBefore) return;

  const before = new Set(String(snapBefore).split('\n').filter(Boolean));
  const after = String(snapAfter).split('\n').filter(Boolean);
  const changed = after.filter((l) => !before.has(l));
  if (!changed.length) return;

  emit({ type: 'files-changed', seq: msg.seq, files: changed.slice(0, 10) });
  log(name, `⚠ 处理 #${msg.seq} 期间工作目录有改动：` + changed.slice(0, 5).join(' | '));
  // 这只是「本轮期间有改动」，不证明是 agent 改的 —— 可能人正在旁边手改。
}

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
     `2. 想把问题交给别人：把 @名字 写在回复的**第一行开头**（可选：${others.join(' / ')}）。`,
     '   **正文中段提到 @名字 不算转交**，收件人仍然是问你的人 —— 所以正文里提别人是安全的。',
     '   转交意味着问你的人等不到你的回答了，只在真的该别人接手时用。',
    '3. 300 字内，说结论和下一步；不要复述指令，不要说「收到」。',
    '4. 要看历史可以用（只读，不会发消息）：',
    `   powershell -NoProfile -ExecutionPolicy Bypass -File "${busPs1}" tail -Limit 20`,
     '5. **不要修改任何文件**，除非对方在消息里明确要求你改（比如「改一下 README」）。',
     '   汇报、结案、总结都不算授权。想改就先问，等对方回「改」再动手。',
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

    const todo = pending({ me: name, all, consumed: cursor.consumed, config: cfg, claimed })
      .filter((m) => m.seq > cursor.baseline);
    if (!todo.length) {
      heartbeat(name, { state: 'idle', lastSeq: cursor.lastSeq });
      if (once) { log(name, '--once：没有待处理消息，退出'); break; }
      await sleep(intervalMs);
      continue;
    }

    const msg = todo[0];

    // 群聊广播：投喂之前先原子抢答。两个 driver 同时看到同一条群消息时，
    // 只有一个能抢到。必须在投喂前 —— 投喂到写回要几十秒到几分钟，
    // 那期间另一边看到的日志还是「没人回过」，两条回复就都冒出来了。
    if (isBroadcast(msg) && !claimReply(msg.seq, name)) {
      claimed.add(msg.seq);
      cursor.consumed.add(msg.seq);
      saveCursor(name, cursor);
      log(name, `#${msg.seq} 群消息已被别人抢答，跳过`);
      continue;
    }

    // 先落游标再投喂：中途崩溃重启也不会重复回答
    cursor.consumed.add(msg.seq);
    cursor.lastSeq = msg.seq;
    saveCursor(name, cursor);

    heartbeat(name, { state: 'thinking', currentSeq: msg.seq });
    const emit = makeEmitter(name, msg.seq);
    currentEmit = emit;

    // 投喂前拍一次工作目录快照，投喂后再拍一次。
    // 三个 agent 里只有 hermes/opencode 走 ACP（有 tool_call 事件可拦），
    // dsh 走 headless 没有任何流事件 —— 所以不做「拦截」，只做「说出来」。
    const snapBefore = snapshotWorkdir(workdir);

    try {
      const s = await ensureSession();
      const reply = await s.ask(buildPrompt(msg, name));
      const text = String(reply || '').trim().slice(0, MAX_REPLY_CHARS) || '(无文本输出)';
      const ctx = replyContext(msg, name);
      const target = routeReply(text, ctx.to, name);
      const out = append({
        from: name,
        kind: 'msg',
        // 回复不能写 '*'：那会让它自己又变成一条广播，被全体再答一遍。
        // 回复要么 @别人（转交），要么回给发起人。
        to: target === BROADCAST ? ctx.to : target,
        text,
        thread: ctx.thread,
        reply_to: ctx.reply_to,
        mentions: target === BROADCAST ? ctx.to : target,
        hop: ctx.hop,
        via: ctx.via,
      });
      emit({ type: 'replied', seq: out.seq, hop: ctx.hop, to: ctx.to });
      log(name, `#${msg.seq} → 回复 #${out.seq} (hop ${ctx.hop}) 给 ${ctx.to}`);
      detectFileChanges(name, msg, emit, snapBefore, workdir);
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
