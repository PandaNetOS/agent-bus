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
import { ROOT, readAll, append, claimReply, readCeo } from '../lib/bus.mjs';
import { ensureConfig, readConfig, writeConfig } from '../lib/config.mjs';
import { pending, replyContext, breakerState, gate, names, isBroadcast } from '../lib/gates.mjs';
import { detectLead, readFloor, claimFloor, setOpening, clearFloor, floorBrief, detectStop } from '../lib/floor.mjs';
import {
  extractBoard, readBoard, writeBoard, clearBoard, applyPatch, boardBrief,
} from '../lib/task.mjs';
import {
  initTurn, readTurn, advanceTurn, acquireTurn, currentTurn, clearTurn, parseOrder, turnBrief,
} from '../lib/turn.mjs';

/** driver 进程内已抢到（或已知被别人抢走）的广播 seq */
const claimed = new Set();

const MAX_REPLY_CHARS = 2000;
const CONSUMED_KEEP = 200;
const AGENT_NAMES = (process.env.AGENT_BUS_MEMBERS || 'dsh,hermes,opencode,pi,prime')
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

/**
 * 开头连续 @ 的名字列表，用于 mentions（投喂）。
 *
 * routeReply 回答「转交给谁」，只能给一个；这条回答「还有谁该看见」，可以给多个。
 * 判据与 routeReply 保持一致：排除自己、排除不存在的成员；保序去重。
 * 只扫开头：正文中段的 @ 是顺带提及，不该改变投喂面（#62 那类劫持的教训）。
 */
export function routeMentions(text, me, agentNames = AGENT_NAMES) {
  const known = new Set(agentNames.map((x) => String(x).toLowerCase()));
  const meL = String(me).toLowerCase();
  let head = String(text || '').trimStart();
  const out = [];
  for (;;) {
    const m = head.match(/^@([a-z0-9_-]+)\b/i);
    if (!m) break;
    const n = m[1].toLowerCase();
    if (n !== meL && known.has(n) && !out.includes(n)) out.push(n);
    head = head.slice(m[0].length).replace(/^[\s,，、]+/, '');
  }
  return out;
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

/** 这条是不是人发的（不是 agent 之间的话） */
function isHumanMsg(msg) {
  return !msg.from || String(msg.from).toLowerCase() === 'human' || msg.via === 'human';
}

/** 把总线消息包成给 agent 的指令 */
/**
 * 投喂给 agent 的提示词。
 *
 * 关键设计：**它可以选择沉默**，但沉默的边界是「同伴之间」，不是「人说话」。
 * 回复以 [SKIP] 开头表示「这话我不接」，driver 收到就不发消息。没有这个出口，
 * 群聊模式下三个人会对每条群消息各说一遍「收到」，那比只有一个回答更糟。
 *
 * 反过来，如果对人也能沉默，就变成「我在群里发消息没有回复」——
 * 实测三条全跳过一句「早上好」。所以 human 的消息在没人接过时必须接。
 *
 * 同理，agent 得知道同伴的存在 —— 不然它不知道该不该接、该不该转给别人。
 * 带上最近几句对话，否则它只看得到一条凭空冒出来的话，那不是聊天。
 */
export function buildPrompt(msg, me, all = [], floor = null) {
  const ctx = replyContext(msg, me);
  const others = AGENT_NAMES.filter((n) => n !== me.toLowerCase());
  const busPs1 = path.join(ROOT, "bus.ps1");
  const ceo = readCeo();

  // 当前轮次（主持模式下、属于同一场 thread 才有）
  const promptFloorThread = floor ? `t-${floor.seq}` : null;
  const turn = (floor && floor.opening && promptFloorThread && msg.thread === promptFloorThread)
    ? readTurn(ROOT) : null;
  // 当前任务棋盘（只在当前场次 thread 里注入，免得旧棋盘污染闲聊）
  const board = (floor && promptFloorThread && msg.thread === promptFloorThread)
    ? readBoard(ROOT) : null;
  // 主持说明只在「这场起头那条」或「本场 thread」里注入，别让旧主持人污染闲聊
  const floorRelevant = !!(floor && (
    msg.seq === floor.seq
    || (floor.opening && promptFloorThread && msg.thread === promptFloorThread)
  ));

  // 带上最近几句对话：只看一条消息就像有人凭空插一句，那不是聊天
  const recent = (all || []).slice(-8).filter((m) => m.seq !== msg.seq);
  const hist = recent.length
    ? recent.map((m) => {
        const to = m.to && m.to !== "*" ? "→" + m.to : "";
        const txt = String(m.text || "").replace(/\s+/g, " ").slice(0, 160);
        return `  #${m.seq} ${m.from}${to}：${txt}`;
      }).join("\n")
    : "  （暂无）";

  const named = !!(msg.to && msg.to !== "*");
  // 「人说话必须有人接」是硬规则：group chat 里最糟的不是三个人抢话，
  // 是人问一句、三个人全用 [SKIP] 装死（实测 #143「早上好」三条全跳）。
  const fromHuman = isHumanMsg(msg);
  const alreadyAnswered = (all || []).filter((m) => m.reply_to === msg.seq);

  // 但「必须接」不能盖过「这一场谁主持」：human 说「ceo 起头」时，
  // 其他人被逼着开口，就会各自起一个头（实测 #333 四个头）。
  const meL = String(me).toLowerCase();
  const iAmLeader = !!(floor && floor.leader === meL);
  const waitingLeader = !!(floor && !iAmLeader && !floor.opening);
  const mustAnswer = fromHuman && !alreadyAnswered.length && !waitingLeader;

  const rules = [
    waitingLeader
      ? `1. **这一场由 ${floor.leader} 起头并定规则，它还没开口。你只回 [SKIP]，不要抢头。**`
      : (fromHuman
        ? (alreadyAnswered.length
          ? `1. 这条来自 human，群里已经有人回过了（#${alreadyAnswered.map((m) => m.seq).join(" / #")}）。`
            + "\n   你要么补充、要么反对，要么 [SKIP] —— 别把别人说过的再说一遍。"
          : (iAmLeader
            ? "1. **human 让你起头。你先开口，并用一句话定规则**（格式、怎么判定、谁接谁）。"
              + "\n   别问「谁是 ceo」—— 就是你。别人抢跑你就直接叫停。"
            : "1. **这条来自 human，现在还没有人回。你不能沉默。**"
              + "\n   哪怕只是一句「早上好」，也回一句「早」。人说话没人应，是这个群最糟的样子。"
              + "\n   觉得这事不用做，就说「不用做」并给一句理由 —— 但不许消失。"))
        : "1. 这条来自同伴。客套、互相确认、别人已经说清楚了 —— 都可以只回 [SKIP]。"
          + "\n   沉默是正当的：群里有几个人，不需要人人都接同伴的每一句。"),
    "",
    "2. 要说话就直说，300 字内。说你的看法、结论、下一步。",
    "   不要复述指令，不要说「收到」，不要拍马屁。",
    "",
    `3. 默认回给 ${msg.from}。想把话转给别人，把 @名字 写在回复的**第一行开头**`,
    `   （可选：${others.join(" / ")}）。正文中段提到 @名字 不算转交，安全。`,
    "",
    "4. 同伴说了你觉得不对的话，直接说出来 —— 你有自己的判断，不是为了附和。",
    "   看到别人在忙同一件事，可以插话补充，也可以指出他漏了什么。",
    "",
    "5. **不要自己运行 bus.ps1 发消息**——会重复，而且绕过系统的闸门。",
    "6. 要看历史可以用（只读，不会发消息）：",
    `   powershell -NoProfile -ExecutionPolicy Bypass -File "${busPs1}" tail -Limit 20`,
    "7. **不要修改任何文件**，除非对方在消息里明确要求你改。",
    "   汇报、结案、总结都不算授权。想改就先问。",
    board
      ? "8. 这是一局有状态的任务。要在回复**最后单起一行**写 `[BOARD] {\"键\":值}` 更新共享状态"
        + "（例如 `[BOARD] {\"tail\":\"强\",\"chain\":[\"一心一意\",\"强词夺理\"]}`）。"
        + "\n   这一行不会显示给群里的人；它会写进权威棋盘，下一棒靠它接。"
      : "",
  ];

  return [
    `你是 ${me}，agent-bus 群里的一员 —— 一个独立的个体，不是答题机。`,
    `群里还有：${others.join("、")}。你们能力不同，看法也不必一致。`,
    ceo ? `群里 CEO 是 ${ceo}（human 指定的负责人）。human 说「ceo 起头」就是让 ${ceo} 起头，别问 ceo 是谁。` : "",
    floorRelevant ? floorBrief(floor, me) : "",
    turn ? turnBrief(turn, me) : "",
    board ? boardBrief(board) : "",
    "",
    "【群里刚刚在说什么】",
    hist,
    "",
    `【现在这条消息】#${msg.seq} 来自 ${msg.from}`
      + (named ? "（点名你）" : "（对群里所有人说的）") + "：",
    `「${msg.text}」`,
    "",
    "决定你要不要说话。规则：",
    ...rules,
    "",
    waitingLeader
      ? `这一场由 ${floor.leader} 起头，它还没开口 —— 你只回 [SKIP]。`
      : (named
        ? "这条是点名你的，一般来说你该回应。"
        : (fromHuman
          ? (alreadyAnswered.length
            ? "这条是群里广播，已经有人接过了 —— 按需补充。"
            : (iAmLeader
              ? "human 点名让你起头 —— 先说第一个，并把规则定下来。"
              : "这条是群里广播，**还没人接** —— 你得说点什么。"))
          : "这条是群里广播，自己判断该不该接。")),
  ].join("\n");
}

/**
 * @param {object} opts
 * @param {string} opts.name                    agent 名（dsh / hermes / opencode）
 * @param {() => Promise<{ask:(text:string)=>Promise<string>,close:()=>void,ready?:boolean}>} opts.createSession
 * @param {number} [opts.intervalMs]
 * @param {string} [opts.workdir]
 */
export async function runDriver({ name, createSession, intervalMs = 1500, workdir = ROOT, once = false, replay = false, pulseMs = 5000 }) {
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
  let onceDone = false;   // --once 模式下：本轮已处理（含主动 [SKIP]）过一条
  let currentEmit = () => {};

  // 匿名监听器每调用一次 runDriver 就多两个，验收里连续跑十几个就触发
  // MaxListenersExceededWarning。留个引用，退出时摘掉。
  const onStop = () => { stopped = true; };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);

  const ensureSession = async () => {
    if (session) return session;
    // 起会话本身也可能超过 busd 的 8 秒窗口（ACP 冷启动实测 ~10 秒），
    // 所以启动期间同样要续心跳，否则「正在启动」会显示成「没在跑」。
    heartbeat(name, { state: 'starting' });
    const boot = setInterval(() => heartbeat(name, { state: 'starting' }), pulseMs);
    try {
      // onEvent 走一个可变引用：会话是长命的，但每条消息的 emit 绑定不同的 seq
      session = await createSession({ onEvent: (e) => currentEmit(e) });
    } finally {
      clearInterval(boot);
    }
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

    // 主持状态要在算 pending 之前读：它决定「这一场 thread」对全员可见，
    // 否则主持人的开场、链上的回复都只回给了 human，别人收不到，轮次推不动。
    let floor = readFloor(ROOT);
    const meL = String(name).toLowerCase();
    if (floor) cfg.activeThread = `t-${floor.seq}`;

    let todo = pending({ me: name, all, consumed: cursor.consumed, config: cfg, claimed })
      .filter((m) => m.seq > cursor.baseline);

    // 主持模式下，这一场 thread 里只有「最新一条 + 轮到我」才处理。
    // 不消费别人的消息 —— 轮次没到时留着，等真轮到再取（避免持棒者掉线死锁）。
    if (floor && floor.opening) {
      const ft = `t-${floor.seq}`;
      const cur = currentTurn(ROOT, { seq: floor.seq });
      todo = todo.filter((m) => {
        if (m.thread !== ft) return true;
        if (!cur.turn) return true;
        return m.seq === cur.cursorSeq && cur.who === meL;
      });
    }

    if (!todo.length) {
      heartbeat(name, { state: 'idle', lastSeq: cursor.lastSeq });
      if (once) { log(name, '--once：没有待处理消息，退出'); break; }
      await sleep(intervalMs);
      continue;
    }

    const msg = todo[0];

    // 人一句话结束整局：human 喊「停 / 先停一下 / 不玩了 / 收手 / 结束这局…」
    // 就清掉 floor + 轮次锁 + 棋盘，所有人立刻收手。必须在 lead 检测之前判。
    // 只对人生效；agent 之间不能说停（那是想抢话）。
    //
    // 清完不 continue：让这句作为普通群消息被自然回应一句「好，停了」——
    // 否则人喊停后群里鸦雀无声，像被吞了（这条群聊最忌）。局已经清了，
    // 不会有人再接力；回复数封顶（maxRepliesPerSeq）挡住五个人一起应声。
    if (isHumanMsg(msg) && detectStop(msg.text)) {
      if (floor) {
        // 把这一场的 thread 记进 config.stoppedThreads：人喊停后，这条
        // thread 里的自动回话一律不许再投喂（gates.mjs 的 thread-stopped
        // 闸），否则 floor 清掉后旧链还能被在途 agent 接着接（实测 #530 起）。
        const stoppedThread = `t-${floor.seq}`;
        // 人的「停」这条消息本身通常是广播、没 thread，agent 的回应会落进
        // t-${msg.seq} 这个新 thread——不封它，agent 就会在「停」下面互相
        // 辩论谁记对了链（实测 #664/#665）。所以连同停令自己的 thread 一起封。
        const stopThread = `t-${msg.seq}`;
        const cfg2 = readConfig();
        const cur = Array.isArray(cfg2.stoppedThreads) ? cfg2.stoppedThreads : [];
        const add = [stoppedThread, stopThread].filter((t) => !cur.includes(t));
        if (add.length) {
          writeConfig({ stoppedThreads: [...cur, ...add] });
        }
        clearFloor(ROOT);
        clearTurn(ROOT);
        clearBoard(ROOT);
        floor = null;
        log(name, `#${msg.seq} 人喊停，结束整局（floor/turn/board 已清，thread ${stoppedThread}+${stopThread} 封停）`);
      } else {
        log(name, `#${msg.seq} 人喊停，但当前没有进行中的局`);
      }
    }

    // 「这一场谁主持」：human 说「ceo 起头 / 让 X 来」时，先认领。
    // 必须在投喂前做 —— 五个人同时看到广播，先到先得，只有一个能当主持人。
    // 不这么做就会各自起头（实测 #333 一条指令四个头）。
    if (isHumanMsg(msg)) {
      const lead = detectLead(msg.text, { ceo: readCeo(), members: AGENT_NAMES });
      if (lead.lead) {
        const r = claimFloor(ROOT, { seq: msg.seq, me: name, allowed: lead.target });
        floor = r.floor;
        if (!r.won) {
          cursor.consumed.add(msg.seq);
          cursor.lastSeq = msg.seq;
          saveCursor(name, cursor);
          log(name, `#${msg.seq} 由 ${(floor && floor.leader) || lead.target || '别人'} 主持，我先等它开场`);
          continue;
        }
        log(name, `#${msg.seq} 我来主持（${lead.how}${lead.target ? '→' + lead.target : ''}）`);
        // 新的一场开始：清掉上一局的棋盘和轮次，免得旧状态串进来。
        clearBoard(ROOT);
        clearTurn(ROOT);
      }
    }
    // 「起头」那条只有主持人处理；其他人不管它开没开场都不接这条 ——
    // 否则会各自起头（实测 #333 四个头）。
    if (floor && floor.seq === msg.seq && floor.leader !== meL) {
      cursor.consumed.add(msg.seq);
      cursor.lastSeq = msg.seq;
      saveCursor(name, cursor);
      log(name, `#${msg.seq} 由 ${floor.leader} 起头，我不抢`);
      continue;
    }

    // 主持模式下这一场 thread 的轮次已在上面过滤过；这里只做安全兜底：
    // 万一不是最新一条或没轮到我，就不投喂（不消费，留给该接的人）。
    const floorThread = floor ? `t-${floor.seq}` : null;
    if (floor && floor.opening && floorThread && msg.thread === floorThread) {
      const turn = acquireTurn(ROOT, { seq: floor.seq, msgSeq: msg.seq, me: name });
      if (!turn.speaking) {
        log(name, `#${msg.seq} 轮次未轮到（该 ${turn.who} 接 / ${turn.reason}），先不接`);
        await sleep(intervalMs);
        continue;
      }
    }

    // 群聊模式（默认）：**不抢答**。三个人都看得到这条群消息，各自决定
    // 说不说 —— 沉默由 agent 自己用 [SKIP] 表达，这才是群聊。
    // 抢答只在 config.groupChat=false 时启用（退回旧的「一人回复」行为）。
    const groupChat = cfg.groupChat !== false;
    if (isBroadcast(msg) && !groupChat && !claimReply(msg.seq, name)) {
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
      // 长任务期间也要报活。心跳原来只在投喂前写一次，而一轮 LLM 可能跑几十秒，
      // busd 判在线的窗口是 8 秒 —— 正在思考的 agent 在界面上看起来像死了，
      // 于是人只能挨个问「你在线吗」。thinking 状态本来就在，缺的是持续刷新。
      // ensureSession() 建会话时会把状态改回 idle，所以这里再写一次。
      heartbeat(name, { state: 'thinking', currentSeq: msg.seq });
      const pulse = setInterval(() => heartbeat(name, { state: 'thinking', currentSeq: msg.seq }), pulseMs);
      let reply;
      try {
        reply = await s.ask(buildPrompt(msg, name, all, floor));
        // 人说话不许被跳过。实测 #143「早上好」三个人全回 [SKIP]，群里
        // 就变成「我发消息没人理」。只追问一次：再问也不会让它开口。
        const skipped = /^\[SKIP\]/i.test(String(reply || "").trim());
        if (skipped && isHumanMsg(msg) && !all.some((m) => m.reply_to === msg.seq)) {
          log(name, `#${msg.seq} 对 human 的消息选择了沉默，追问一次`);
          reply = await s.ask(
            buildPrompt(msg, name, all, floor)
            + "\n\n【必须回】你刚才选择了沉默，但这条是 human 的消息，群里还没有人回。"
            + "现在回一句，不要 [SKIP]。",
          );
        }
      } finally {
        clearInterval(pulse);
      }
      const text = String(reply || '').trim().slice(0, MAX_REPLY_CHARS) || '(无文本输出)';

      // 终检：ask 可能耗时 1–4 分钟，期间人可能喊停 / 别人可能先回。再判一次，
      // 一旦这条 thread 被停（thread-stopped）就把在途回复丢掉，不投喂。
      // 否则人喊停后还会冒出旧链的尾巴（实测 #581 在 #579 停令后仍在接）。
      // 注意：不能用完整 gate(msg)——msg 此刻已在 cursor.consumed，会误拦。
      // 这里只针对「停过的 thread」这一条做兜底。
      {
        const cfgNow = readConfig();
        const stoppedNow = Array.isArray(cfgNow.stoppedThreads) ? cfgNow.stoppedThreads : [];
        if (msg.thread && msg.thread.startsWith("t-") && stoppedNow.includes(msg.thread)) {
          log(name, `#${msg.seq} 终检：thread ${msg.thread} 已被人喊停，丢弃在途回复，不投喂`);
          detectFileChanges(name, msg, emit, snapBefore, workdir);
          failures = 0;
          if (once) onceDone = true;
          continue;
        }
      }

      // 抽离 [BOARD] 旁信道：agent 在回复里写一行 JSON 补丁维护共享棋盘，
      // 我们从可见文本里剥掉它，再 apply 到 .task.json。下一棒投喂时就能看到
      // 权威状态，而不是从聊天记录里猜（实测 #333 分叉的根因）。
      // board 注入只在当前场次；开场那条也允许主持人写初始棋盘。
      const promptFloorThread = floor ? `t-${floor.seq}` : null;
      const inFloorThread = !!(promptFloorThread && msg.thread === promptFloorThread);
      const isOpening = !!(floor && floor.leader === String(name).toLowerCase() && !floor.opening);
      const inFloor = isOpening || (floor && floor.opening && inFloorThread);
      const { text: cleanText, patch } = inFloor ? extractBoard(text) : { text, patch: null };

      // 群聊的关键出口：agent 自己决定不说话。
      // 没有它，三个人会对每条群消息各说一遍「收到」，比只有一个回答更糟。
      if (/^\[SKIP\]/i.test(text)) {
        emit({ type: "skipped", seq: msg.seq });
        log(name, `#${msg.seq} 自己选择不说话`);
        detectFileChanges(name, msg, emit, snapBefore, workdir);
        failures = 0;
        if (once) onceDone = true;
        continue;
      }

      if (patch) {
        const board = applyPatch(readBoard(ROOT) || { seq: msg.seq, state: {}, history: [] }, patch);
        board.seq = msg.seq;
        writeBoard(ROOT, board);
        log(name, `#${msg.seq} 更新棋盘：${JSON.stringify(patch).slice(0, 200)}`);
      }
      const ctx = replyContext(msg, name);
      const target = routeReply(cleanText, ctx.to, name);
      // to 保持标量：room 记录和 gates 的 to===me 都按单人判。
      // 开头写了多个 @ 时，其余名字进 mentions，供 gate 的 names() 投喂。
      const mentioned = routeMentions(cleanText, name);
      const out = append({
        from: name,
        kind: 'msg',
        // 回复不能写 '*'：那会让它自己又变成一条广播，被全体再答一遍。
        // 回复要么 @别人（转交），要么回给发起人。
        to: target,
        text: cleanText,
        thread: ctx.thread,
        reply_to: ctx.reply_to,
        mentions: mentioned.join(','),
        hop: ctx.hop,
        via: ctx.via,
      });
      emit({ type: 'replied', seq: out.seq, hop: ctx.hop, to: ctx.to });
      log(name, `#${msg.seq} → 回复 #${out.seq} (hop ${ctx.hop}) 给 ${ctx.to}`);

      // 我是主持人、且这条就是「起头」指令 —— 把我的开场白记成规则，
      // 后面的人照着接，不会再各自起头（实测 #333）。
      if (floor && floor.seq === msg.seq && floor.leader === String(name).toLowerCase() && !floor.opening) {
        setOpening(ROOT, { seq: msg.seq, me: name, text: cleanText });
        // 主持人开场就初始化棋盘：把规则和起头写进 .task.json
        if (patch) { /* 已写 */ } else {
          const b = readBoard(ROOT) || { seq: msg.seq, state: {}, history: [] };
          b.seq = msg.seq;
          if (!b.kind) b.kind = 'open';
          if (!b.owner) b.owner = String(name).toLowerCase();
          if (!b.rule) b.rule = cleanText.slice(0, 300);
          writeBoard(ROOT, b);
        }
        // 初始化轮次，让后续接话者按确定性顺序来。
        // 主持人刚说完开场，轮次立即推进到下一位，cursor 指向开场那条 ——
        // 下一位要接的就是它（否则 idx 停在主持人，后面永远轮不到）。
        // 主持人若在开场里自己定了顺序（「顺序是 我→hermes→pi→…」），照它的来
        const statedOrder = parseOrder(cleanText, { leader: name, members: AGENT_NAMES });
        initTurn(ROOT, {
          seq: msg.seq, leader: name, ceo: readCeo(), members: AGENT_NAMES,
          cursorSeq: out.seq, order: statedOrder,
        });
        advanceTurn(ROOT, { seq: msg.seq, me: name, nextSeq: out.seq });
      }

      // 主持模式下接完这一棒 → 推进轮次，cursor 移到刚发出的这条，
      // 让下一位接「我说的这句」，而不是所有人回头去接主持人的开场。
      if (floor && floor.opening && floorThread && msg.thread === floorThread) {
        advanceTurn(ROOT, { seq: floor.seq, me: name, nextSeq: out.seq });
      }
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
    // onceDone：agent 用 [SKIP] 选择了沉默，也算「处理过一条」
    if (once) { log(name, onceDone ? '--once：已处理一条（跳过），退出' : '--once：已处理一条，退出'); break; }
  }

  try { session?.close?.(); } catch {}
  heartbeat(name, { state: 'off', note: 'stopped' });
  process.off('SIGINT', onStop);
  process.off('SIGTERM', onStop);
}

function log(name, s) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${name}: ${s}`;
  console.log(line);
}

export { log };
