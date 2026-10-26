/**
 * lib/task.mjs —— 有状态游戏/协作的「共享棋盘」
 *
 * 实测 #333 成语接龙：五个人各自从「最近 8 条」猜现在尾字是什么，
 * 于是同一条「ceo 起头」冒出 马到成功 / 一心一意 / 首屈一指 四个头，
 * 后面一百多条全在吵「哪条龙才算数」「你基于旧状态」。
 *
 * 根因：任务状态没有权威来源，每个人靠聊天记录推断，而每个人投喂时
 * 看到的历史快照还不一样 —— 等于五个人在用不同版本的「现实」。
 *
 * 这里把状态做成一份显式 JSON（.task.json），由主持人初始化、由接话者
 * 增量更新。回复里带一行 `[BOARD] {...}` 作为旁信道（side-channel）：
 *   - driver 解析出来、apply 到 .task.json
 *   - 这一行从可见文本里剥掉，群里看不到
 *   - 下一棒投喂时，prompt 里给「权威状态」而不是让大家猜
 *
 * 这样接龙就变成「读当前尾字 → 接一步 → 写回尾字」，不会出现分叉。
 * 非游戏任务（比如一起写文档）也可以用：谁在改、卡在哪、下一步谁做。
 */
import fs from 'node:fs';
import path from 'node:path';

export const taskPath = (root) => path.join(root, '.task.json');

/** 回复里带 [BOARD] {...} 的是棋盘补丁。可出现在任意位置（行中/行尾） */
export const BOARD_RE = /\[BOARD\][ \t]*(\{[\s\S]*?\})/;

/**
 * 从一段回复文本里抽出 [BOARD] 补丁，并返回「去掉旁信道后的干净文本」。
 * @returns {{text:string, patch:object|null}}
 */
export function extractBoard(text) {
  const t = String(text || '');
  const m = t.match(BOARD_RE);
  if (!m) return { text: t, patch: null };
  let patch = null;
  try { patch = JSON.parse(m[1]); } catch { patch = null; }
  // 剥掉那一行（连同它被包住的换行），但保留其它内容原样
  const cleaned = t.replace(BOARD_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, patch };
}

export function readBoard(root) {
  try {
    const j = JSON.parse(fs.readFileSync(taskPath(root), 'utf8'));
    if (!j || typeof j.seq !== 'number') return null;
    return j;
  } catch { return null; }
}

export function writeBoard(root, board) {
  fs.writeFileSync(taskPath(root), JSON.stringify(board, null, 2), 'utf8');
}

export function clearBoard(root) {
  try { fs.rmSync(taskPath(root), { force: true }); } catch {}
}

/**
 * 把补丁 apply 到棋盘上。补丁里出现的键覆盖原值；
 * history/chain 这类数组用 push 而不是覆盖（接龙要累积历史）。
 */
export function applyPatch(board, patch) {
  const b = board || { state: {}, history: [] };
  if (!patch || typeof patch !== 'object') return b;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (Array.isArray(v) && Array.isArray(b[k])) {
      b[k] = b[k].concat(v);
    } else if (k === 'seq') {
      // seq 单独维护，不被补丁覆盖
    } else {
      b[k] = v;
    }
  }
  return b;
}

/** 给 prompt 用的一句话：把当前权威状态讲清楚 */
export function boardBrief(board) {
  if (!board) return '';
  const parts = ['【当前任务状态】'];
  if (board.kind) parts.push(`类型：${board.kind}`);
  if (board.owner) parts.push(`主持/负责：${board.owner}`);
  if (board.rule) parts.push(`规则：${board.rule}`);
  if (board.head) parts.push(`起头：${board.head}`);
  if (board.tail) parts.push(`当前尾字/接龙头：${board.tail}`);
  if (board.turn) parts.push(`该谁接：${board.turn}`);
  if (Array.isArray(board.chain) && board.chain.length) {
    parts.push(`已接链条：${board.chain.join(' → ')}`);
  }
  if (board.note) parts.push(`备注：${board.note}`);
  return parts.join('\n');
}
