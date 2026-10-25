/**
 * lib/gates.mjs — 自动对话的六道闸
 *
 * 单一实现：driver 和 busd 都 import 这一个文件，不各写一套，
 * 否则看板显示「可以投喂」而 driver 判定「不该投喂」，两边说法不一致。
 *
 * 六条（全部通过才投喂）：
 *   1. 点名      to == 我 或 mentions 含我
 *   2. 非自己    from != 我
 *   3. 跳数      via == human 或 hop < maxHop
 *   4. 未消费    该 seq 不在本 driver 的 consumed 集合里
 *   5. 未熔断    config.pausedUntil 已过
 *   6. 非循环    最近 20 条里同一 (from,to,text 前 80 字) 不超过 2 次
 */
import { parseMentions } from './bus.mjs';

export const MAX_HOP_DEFAULT = 3;
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_LIMIT = 12;
export const LOOP_WINDOW = 20;
export const LOOP_LIMIT = 2;

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

  if (String(msg.from || '').toLowerCase() === meL) return { ok: false, reason: 'self' };
  if (!names(msg, me)) return { ok: false, reason: 'not-named' };
  if (consumed.has(msg.seq)) return { ok: false, reason: 'consumed' };
  if (isBroadcast(msg)) {
    if (claimed && claimed.has(msg.seq)) return { ok: false, reason: 'claimed', detail: '已被其他 agent 抢答' };
    if (answered(all, msg.seq)) return { ok: false, reason: 'answered', detail: '群里已有人回过' };
  }

  if (config.pausedUntil && config.pausedUntil > now) {
    return { ok: false, reason: 'breaker', detail: config.pauseReason || '熔断中' };
  }

  const maxHop = Number.isFinite(config.maxHop) ? config.maxHop : MAX_HOP_DEFAULT;
  const hopReset = config.hopReset && config.hopReset[msg.thread];
  if (isAuto(msg) && !hopReset && (msg.hop || 0) >= maxHop) {
    return { ok: false, reason: 'hop-limit', detail: `hop ${msg.hop} >= ${maxHop}，等人工放行` };
  }

  const key = loopKey(msg);
  const same = all.slice(-LOOP_WINDOW).filter((m) => loopKey(m) === key);
  if (same.length >= LOOP_LIMIT) return { ok: false, reason: 'loop', detail: '同样的话已出现两次' };

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
