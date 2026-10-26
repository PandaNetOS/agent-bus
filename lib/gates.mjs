/**
 * lib/gates.mjs — 自动对话的七道闸
 *
 * 单一实现：driver 和 busd 都 import 这一个文件，不各写一套，
 * 否则看板显示「可以投喂」而 driver 判定「不该投喂」，两边说法不一致。
 *
 * 七条（全部通过才投喂）：
 *   1. 点名      to == 我 或 mentions 含我
 *   2. 非自己    from != 我
 *   3. 跳数      via == human 或 hop < maxHop
 *   4. 未消费    该 seq 不在本 driver 的 consumed 集合里
 *   5. 未熔断    config.pausedUntil 已过
 *   6. 非时效    消息发出后没超过 maxAgeMs 还没人接
 *   7. 非循环    最近 20 条里同一 (from,to,text 前 80 字) 不超过 2 次
 */
import { parseMentions } from './bus.mjs';

export const MAX_HOP_DEFAULT = 3;
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_LIMIT = 12;
export const LOOP_WINDOW = 20;
export const LOOP_LIMIT = 2;
/** 消息超过这个时间还没人接，就不再自动投喂（见 gate 里的 stale 闸） */
export const STALE_MS_DEFAULT = 300_000;   // 5 分钟

/**
 * 群聊广播：不带 @名字 的消息（to 和 mentions 都为空）视为「@全体」，
 * 每个 agent 都能看到 —— 否则群聊里不点名的话，没有任何 agent 会接。
 *
 * 用 to==='*' 这个哨兵值标记，不靠「to 和 mentions 都为空」推断：
 * 老消息（v1 和 v2 早期）也满足空条件，不该被追溯成广播。
 */
export const BROADCAST = '*';

export const isBroadcast = (m) => m.to === BROADCAST;

export function isAuto(msg) {
  return !!(msg.via && msg.via !== 'human');
}

export function names(msg, me) {
  const meL = String(me).toLowerCase();
  if (isBroadcast(msg)) return true;
  const toMe = !!(msg.to && String(msg.to).toLowerCase() === meL);
  const mentioned = parseMentions(msg.mentions).includes(meL);
  return toMe || mentioned;
}

const loopKey = (m) => `${m.from}|${m.to}|${String(m.text || '').slice(0, 80)}`;

/** 已经有别人回过这条消息了吗（群聊里「一人回复」的依据） */
export function answered(all, seq) {
  return all.some((m) => m.reply_to === seq);
}

/**
 * 群聊里「没点名我，但我该看得见」的两种情况：
 *   1. 这条是在回我写的话（reply_to 指向我的消息）
 *   2. 这条在我已经说过话的线程里
 *
 * 没有这两条，每个 agent 只能回答点名自己的话 —— 三个人就成了三个
 * 互不相干的客服，而不是一个群。有了它，我插得进别人的对话，
 * 别人也接得上我的话。
 *
 * 只扫最近 300 条：room.jsonl 会长很大，而「我参与过的线程」只可能是近期的。
 */
export function reachableInGroup(msg, meL, all = []) {
  const scan = all.length > 300 ? all.slice(-300) : all;
  const myThreads = new Set();
  for (const m of scan) {
    if (String(m.from || '').toLowerCase() !== meL) continue;
    if (m.thread) myThreads.add(m.thread);
  }
  if (msg.thread && myThreads.has(msg.thread)) return true;
  if (msg.reply_to) {
    return scan.some((m) => m.seq === msg.reply_to
      && String(m.from || '').toLowerCase() === meL);
  }
  return false;
}
/**
 * 返回 {ok:true} 或 {ok:false, reason, detail}
 *
 * 群聊广播（to='*'）额外过两道「一人回复」的闸，缺一不可：
 *   - claimed：磁盘上的抢答记录。driver 投喂前先抢，赢了的才答。
 *   - answered：日志里已有 reply_to == 本条 的回复（兜底 + 看板显示用）。
 * 只判 answered 不够：driver 从投喂到写回要几十秒到几分钟，这期间
 * 别的 driver 看到的日志还是「没人回过」，于是也去答。加了 claimed 之后，
 * 抢答发生在投喂之前，先抢到的赢，第二条直接跳过。
 * 谁先抢到是不确定的 —— 这正是群聊该有的样子。
 */
export function gate(msg, { me, all = [], consumed = new Set(), config = {}, now = Date.now(), claimed = null }) {
  const meL = String(me).toLowerCase();
  // 群聊模式：默认开。关掉就退回「广播一人回复」的旧行为。
  const groupChat = config.groupChat !== false;

  if (String(msg.from || '').toLowerCase() === meL) return { ok: false, reason: 'self' };

  if (!names(msg, me)) {
    // 群聊模式下还看得见两种「没点名但与我有关」的话：别人回了我写的、
    // 以及我参与过的线程里后续的发言。没有这两条，我只能回答点名我的话，
    // 那就不是群聊，是三个互不相干的客服。
    //
    // activeThread：主持模式下这一场（t-floor.seq）对全员可见 —— 否则
    // 主持人回给 human 的开场、链上彼此的回复，别的成员根本收不到，
    // 轮次也就无从推进。
    const inActiveThread = !!(config.activeThread && msg.thread === config.activeThread);
    if (!inActiveThread && (!groupChat || !reachableInGroup(msg, meL, all))) {
      return { ok: false, reason: 'not-named' };
    }
  }
  if (consumed.has(msg.seq)) return { ok: false, reason: "consumed" };

  // 广播：群聊模式下**不抢答**。三个人都看得到，各自决定说不说，
  // 沉默由 agent 自己用 [SKIP] 表达（drivers/driver.mjs）—— 这才是群聊。
  // 「一人回复」的旧行为靠 config.groupChat=false 保留。
  if (isBroadcast(msg) && !groupChat) {
    if (claimed && claimed.has(msg.seq)) return { ok: false, reason: 'claimed', detail: '已被其他 agent 抢答' };
    if (answered(all, msg.seq)) return { ok: false, reason: 'answered', detail: '群里已有人回过' };
  }

  if (config.pausedUntil && config.pausedUntil > now) {
    return { ok: false, reason: 'breaker', detail: config.pauseReason || '熔断中' };
  }

  // 人喊停的场次 thread：停了就彻底不许再自动接。否则 floor 清掉后，旧链
  // 消息作为普通群 thread 仍可触达，在途的 agent 会接着接龙/辩论，尾巴拖很长
  // （实测 #528 喊停后 #530–#541 还在接；#579 喊停后 #585–#593 还在辩论）。
  // 但允许 agent 直接回应人的「停」（一句「好，停了」）——否则人喊停后群里
  // 鸦雀无声像被吞了。所以：停了的 thread 里，自动消息只有在「直接回人」时才
  // 放行；agent 之间在停了的 thread 里对聊（接龙尾巴/辩论）一律封掉。
  const stopped = Array.isArray(config.stoppedThreads) ? config.stoppedThreads : [];
  if (isAuto(msg) && msg.thread && stopped.includes(msg.thread)) {
    const target = Array.isArray(all) ? all.find((m) => m.seq === msg.reply_to) : null;
    const repliesToHuman = !!(target && String(target.from || '').toLowerCase() === 'human');
    if (!repliesToHuman) {
      return { ok: false, reason: 'thread-stopped', detail: `这条 thread（${msg.thread}）已被人喊停，只准回人的「停」，不准 agent 之间再接/辩论` };
    }
  }

  // 时效闸：太久没人接的消息，接了就是驴唇不对马嘴。
  // 起因是 #64「你好」在 37 分钟后才被回答 —— 反循环闸是「最近 20 条」的
  // 滑动窗口，20 条新消息一进来，老消息就自动解禁了。判据必须是时间，
  // 不能是条数：条数和「过了多久」没有关系。
  // 代价是 driver 停了 5 分钟以上时，重启后旧消息不再补答 —— 但这比
  // 半小时后突然冒出一句「你好」好，而且 /api/why 会把原因说清楚。
  const maxAgeMs = Number.isFinite(config.maxAgeMs) ? config.maxAgeMs : STALE_MS_DEFAULT;
  const ts = Date.parse(msg.ts || '');
  if (Number.isFinite(ts)) {
    const age = now - ts;
    if (age > maxAgeMs) {
      return {
        ok: false,
        reason: 'stale',
        detail: `已过 ${Math.round(age / 60000)} 分钟没人接，超过 ${Math.round(maxAgeMs / 60000)} 分钟不再自动回`,
      };
    }
  }

  // 跳数闸：防止 agent 之间无限对聊。但**主持场次里**它是错的闸 ——
  // 这一场的秩序由主持人 + 轮次锁 + 租约保证，一条接龙本来就该走几十跳。
  // 实测 #464：CEO 起头后 3 跳就到顶，接龙刚接三个词就断了。
  // 所以主持场次用 floorMaxHop（默认 40，约 8 轮），普通群聊仍用 maxHop。
  const inActiveFloor = !!(config.activeThread && msg.thread === config.activeThread);
  const baseHop = Number.isFinite(config.maxHop) ? config.maxHop : MAX_HOP_DEFAULT;
  const maxHop = inActiveFloor && Number.isFinite(config.floorMaxHop)
    ? config.floorMaxHop
    : baseHop;
  const hopReset = config.hopReset && config.hopReset[msg.thread];
  if (isAuto(msg) && !hopReset && (msg.hop || 0) >= maxHop) {
    return {
      ok: false,
      reason: 'hop-limit',
      detail: inActiveFloor
        ? `主持场次已走 ${msg.hop} 跳（上限 ${maxHop}），等人工放行`
        : `hop ${msg.hop} >= ${maxHop}，等人工放行`,
    };
  }

  // 回复数封顶：一条广播最多被 N 个 agent 回过就不再自动投喂。
  // 没有它，五个人会对同一条群消息各说一遍，群瞬间被刷屏。
  // 默认 0 = 不限制（验收/老行为）。运行时 hub-config.json 设为 3。
  const maxReplies = Number.isFinite(config.maxRepliesPerSeq) ? config.maxRepliesPerSeq : 0;
  if (maxReplies > 0 && isBroadcast(msg) && !isAuto(msg)) {
    const replies = all.filter((m) => m.reply_to === msg.seq).length;
    if (replies >= maxReplies) {
      return { ok: false, reason: 'max-replies', detail: `这条已被 ${replies} 人回过，超过上限 ${maxReplies}` };
    }
  }

  // 反循环闸只管 agent 之间的话。人重复发同一句不是循环 —— 通常是
  // 「刚才没人回，我再说一遍」。把它判成 loop，等于第二次也不理人，
  // 而且界面上只会显示一句看不懂的「判为循环」（实测 #144）。
  if (isAuto(msg)) {
    const key = loopKey(msg);
    const same = all.slice(-LOOP_WINDOW).filter((m) => loopKey(m) === key);
    if (same.length >= LOOP_LIMIT) return { ok: false, reason: 'loop', detail: '同样的话已出现两次' };
  }

  return { ok: true };
}

/** 给一条被投喂的消息算回复用的上下文 */
export function replyContext(msg, me) {
  const thread = msg.thread || `t-${msg.seq}`;
  return {
    thread,
    reply_to: msg.seq,
    hop: isAuto(msg) ? (msg.hop || 0) + 1 : 1,
    to: msg.from,
    via: `driver:${me}`,
  };
}

/** 熔断：窗口内自动消息超过上限 → 返回 {tripped, count} */
export function breakerState(all, now = Date.now(), windowMs = BREAKER_WINDOW_MS, limit = BREAKER_LIMIT) {
  const cutoff = now - windowMs;
  const auto = all.filter((m) => isAuto(m) && Date.parse(m.ts) >= cutoff);
  return { tripped: auto.length > limit, count: auto.length, limit, windowMs };
}

/** 这个 driver 现在能看到哪些待处理消息（按 seq 升序） */
export function pending({ me, all, consumed, config, now = Date.now(), claimed = null }) {
  return all.filter((m) => gate(m, { me, all, consumed, config, now, claimed }).ok);
}

/** 给看板用：为什么这条没被投喂 */
export function explain({ me, all, consumed, config, now = Date.now(), claimed = null }) {
  const out = [];
  for (const m of all.slice(-40)) {
    if (!names(m, me)) continue;
    const g = gate(m, { me, all, consumed, config, now, claimed });
    out.push({ seq: m.seq, ok: g.ok, reason: g.reason || 'ok', detail: g.detail || '' });
  }
  return out;
}
