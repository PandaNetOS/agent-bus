/**
 * lib/turn.mjs —— 主持模式下「谁该接这一棒」的确定性轮次
 *
 * floor.mjs 解决了「谁起头、谁定规则」。但起头之后，成语接龙这种游戏
 * 还需要一个明确的接话顺序，否则还是会变成各聊各的。
 *
 * 这里把「轮次」做成一份共享状态（.turn.json），由主持人开场后初始化：
 *   顺序 = 主持人 → 其余成员（按确定性排序：ceo > 名字序）
 * 每根棒只允许当前持棒者开口；其他人看到不是自己就不接。
 *
 * 关键：轮次绑在「当前该被接的那条消息」上（cursorSeq），不是绑在整场。
 * 否则五个人都会去接主持人那一句，还是分叉。cursorSeq 随着每条回复前移：
 *
 *   主持人 #334 开场（cursorSeq=334, idx=1）
 *     → hermes 接 #334，回 #335（cursorSeq=335, idx=2）
 *       → opencode 接 #335，回 #336（cursorSeq=336, idx=3）
 *         → pi 接 #336 …
 *
 * 这样链永远只有一条，且每条消息只被一个人接。
 *
 * 非主持模式（群聊、没有 floor）不走这套 —— acquireTurn 返回
 * {speaking:false, reason:'unmoderated'}，driver 退回原有群聊逻辑。
 * 两套行为互不污染。
 */
import fs from 'node:fs';
import path from 'node:path';

export const turnPath = (root) => path.join(root, '.turn.json');

/** 确定性轮次顺序：被点名者优先，其次 ceo，其余按名字序 */
export function orderFor(msg, { ceo = '', members = [] } = {}) {
  const m = String((msg && msg.text) || '').toLowerCase();
  const order = [];
  const seen = new Set();
  const push = (n) => {
    const l = String(n).toLowerCase();
    if (l && !seen.has(l)) { seen.add(l); order.push(l); }
  };
  for (const mem of members) {
    const l = String(mem).toLowerCase();
    if (l && m.includes('@' + l)) push(l);
  }
  if (ceo) push(ceo);
  members.map((x) => String(x).toLowerCase()).sort().forEach(push);
  return order;
}

export function readTurn(root) {
  try {
    const j = JSON.parse(fs.readFileSync(turnPath(root), 'utf8'));
    if (!j || typeof j.seq !== 'number' || !Array.isArray(j.order) || !j.order.length) return null;
    return j;
  } catch { return null; }
}

export function writeTurn(root, t) {
  fs.writeFileSync(turnPath(root), JSON.stringify(t), 'utf8');
}

export function clearTurn(root) {
  try { fs.rmSync(turnPath(root), { force: true }); } catch {}
}

/**
 * 初始化一局轮次（主持人开场后调用）。
 * @param {object} o
 * @param {number} o.seq          floor 的 seq（这一场）
 * @param {string} o.leader       主持人
 * @param {number} [o.cursorSeq]  下一棒该接的那条消息 seq（通常是开场那条）
 * @returns {object} turn 状态
 */
export function initTurn(root, { seq, leader, ceo = '', members = [], cursorSeq = seq, leaseMs = 300_000 }) {
  const order = orderFor({ text: '' }, { ceo, members });
  const lead = String(leader).toLowerCase();
  const rest = order.filter((n) => n !== lead);
  const finalOrder = [lead, ...rest];
  const t = {
    seq,
    order: finalOrder,
    idx: 0,
    cursorSeq,
    leaseMs,
    updatedAt: Date.now(),
    leader: lead,
  };
  writeTurn(root, t);
  return t;
}

/**
 * 取当前持棒者；租约超时则自动跳到下一位（cursorSeq 不变，下一位接同一条）。
 * @returns {{who:string, idx:number, cursorSeq:number, turn:object|null}}
 */
export function currentTurn(root, { seq, now = Date.now() } = {}) {
  let t = readTurn(root);
  if (!t || t.seq !== seq) return { who: '', idx: -1, cursorSeq: -1, turn: t };
  if (t.updatedAt && now - t.updatedAt > t.leaseMs) {
    t = { ...t, idx: (t.idx + 1) % t.order.length, updatedAt: now };
    writeTurn(root, t);
  }
  return { who: t.order[t.idx % t.order.length], idx: t.idx, cursorSeq: t.cursorSeq, turn: t };
}

/**
 * 我这一轮能不能开口？
 * @param {object} o
 * @param {number} o.seq      floor 的 seq
 * @param {number} [o.msgSeq] 我正在处理的这条消息 seq（用于判断是不是最新一条）
 * @returns {{speaking:boolean, who:string, reason:string, turn:object|null}}
 */
export function acquireTurn(root, { seq, msgSeq = null, me, now = Date.now() } = {}) {
  const cur = currentTurn(root, { seq, now });
  if (!cur.turn) return { speaking: false, who: '', reason: 'unmoderated', turn: null };
  const meL = String(me).toLowerCase();
  // 只接「最新一条」：老消息已经被别人接过了，再接就是分叉
  if (msgSeq != null && msgSeq !== cur.cursorSeq) {
    return { speaking: false, who: cur.who, reason: 'not-latest', turn: cur.turn };
  }
  return {
    speaking: cur.who === meL,
    who: cur.who,
    reason: cur.who === meL ? 'your-turn' : 'not-your-turn',
    turn: cur.turn,
  };
}

/** 当前持棒者接完 → 推进到下一根棒，并把 cursor 移到刚发出的那条 */
export function advanceTurn(root, { seq, me, nextSeq = null, now = Date.now() } = {}) {
  const t = readTurn(root);
  if (!t || t.seq !== seq) return null;
  const t2 = {
    ...t,
    idx: (t.idx + 1) % t.order.length,
    cursorSeq: nextSeq != null ? nextSeq : t.cursorSeq,
    updatedAt: now,
  };
  writeTurn(root, t2);
  return t2;
}

/** 给 prompt 用的一句话 */
export function turnBrief(turn, me) {
  if (!turn) return '';
  const meL = String(me).toLowerCase();
  const who = turn.order[turn.idx % turn.order.length];
  if (who === meL) {
    return '【轮到你接话】这一棒该你说。接完把状态写回 [BOARD]，不要等别人，也不要另起一条。';
  }
  return `【轮次】这一棒该 ${who} 接，你先别插话 —— 只回 [SKIP]，等轮到你。`;
}
