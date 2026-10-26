/**
 * lib/floor.mjs —— 「谁主持这一场」的判据与状态
 *
 * 需求来自实测：human 在群里说「来成语接龙 ceo起头」，结果五个人各自起了
 * 一个头（马到成功 / 一心一意 / 首屈一指…），然后一百多条全在吵「谁是 ceo、
 * 哪条龙才算数」。根因不是模型笨，是群里根本没有「这一场谁说了算」这个概念。
 *
 * 这里把「主持人」做成一份显式状态，而不是让每个 agent 从聊天记录里猜：
 *
 *   1. 谁被指定 —— @名字 / 角色词（ceo、老板）/ 语义（「让最懂代码的起头」）
 *   2. 主持人做什么 —— 第一个开口 + 定规则 + 叫停抢跑
 *   3. 其他人做什么 —— 等它开场，然后按它定的规则接，不许另起一条
 *
 * 「语义指定」没有确定的人，所以用抢占：谁先认领谁主持（原子写，先到先得）。
 * 这比再调一次 LLM 去解析「最懂代码的是谁」便宜，也更符合群聊的直觉。
 *
 * 状态只有一个活跃 floor（.floor.json）。新的「起头/主持」指令会顶掉旧的；
 * 超过 TTL 自动失效，免得昨天的主持人管今天的闲聊。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 带「你来带」意味的动词 */
export const LEAD_VERB = /(起头|开头|先来|主持|定规矩|定规则|定个规矩|带节奏|组织一下|组织|发起|开局|开一局|你来安排|你负责|你带|管一下|管管|维持秩序|维护秩序|换.{0,6}(主持|带|来)|交给|下一局)/;
/** 角色词：解析成 ceo.txt 里的那个人 */
export const ROLE_WORD = /(ceo|老板|老大|大将军|主持人|队长|裁判)/i;

/**
 * 人类说「停 / 先停一下 / 收手 / 不玩了 / 结束这局 / 到此为止…」—— 一句话结束整场。
 *
 * 起因：实测里 human 发「先停一下」，系统把它当成链上普通一句继续接了，
 * 因为没有「人一句话取消 floor」的入口，它只认「换 X 主持 / 下一局」这种
 * 指向新主持的词。结果人喊停，agent 还在接龙。
 *
 * 判据只对人生效（isHumanMsg 在调用方把关）。必须排除「别停 / 不要停 /
 * 继续 / 接着来」这类否定与反向指令，否则反话会误停。也排除「停一下」后面
 * 跟的是别的事（这条用意图优先：纯停止意图才命中）。
 */
export const STOP_VERB = /(不玩了|不接了|别接了|收手|打住|停下|停住|停掉|停止|停一下|停这局|停这一局|停手|歇了|散了|散伙|结束这局|结束这一局|结束游戏|结束本局|收局|到此为止|到此打住|散了吧|收工|不来了|撤了|撤吧)/;
export const ANTI_STOP = /(别停|不要停|不用停|继续|接着来|接着玩|继续玩|再来|别收手|别打住|不停)/;

export function detectStop(text) {
  const t = String(text || '');
  if (!STOP_VERB.test(t)) return false;
  if (ANTI_STOP.test(t)) return false;
  return true;
}

/** 活跃 floor 的有效期：2 小时 */
export const FLOOR_TTL_MS = 2 * 60 * 60 * 1000;

export const floorPath = (root) => path.join(root, '.floor.json');
const lockPath = (root, name = '.floor.lock') => path.join(root, name);

/**
 * 从一条 human 消息里判断「这一场谁主持」。
 *
 * @returns {{lead:boolean, target:string|null, how:'mention'|'role'|'semantic'|null}}
 *   target=null 且 lead=true 表示「语义指定」——谁合适谁认领。
 */
export function detectLead(text, { ceo = '', members = [] } = {}) {
  const t = String(text || '');
  if (!LEAD_VERB.test(t)) return { lead: false, target: null, how: null };

  const low = t.toLowerCase();
  // 1. 显式 @名字 优先（哪怕同时提了 ceo，也是 @ 的那个人）
  for (const m of members) {
    const name = String(m).toLowerCase();
    if (name && low.includes('@' + name)) return { lead: true, target: name, how: 'mention' };
  }
  // 2. 角色词 → ceo.txt 里的人
  if (ROLE_WORD.test(t) && ceo) {
    return { lead: true, target: String(ceo).toLowerCase(), how: 'role' };
  }
  // 3. 语义指定：谁认领谁上
  return { lead: true, target: null, how: 'semantic' };
}

export function readFloor(root) {
  try {
    const f = JSON.parse(fs.readFileSync(floorPath(root), 'utf8'));
    if (!f || typeof f.seq !== 'number' || !f.leader) return null;
    if (f.ts && Date.now() - f.ts > FLOOR_TTL_MS) return null;
    return f;
  } catch { return null; }
}

export function writeFloor(root, f) {
  fs.writeFileSync(floorPath(root), JSON.stringify(f), 'utf8');
}

/** 极短的跨进程互斥：独占创建锁文件，拿不到就等 */
export function withLock(root, fn, lockName = '.floor.lock') {
  const p = lockPath(root, lockName);
  for (let i = 0; i < 100; i++) {
    try {
      const fd = fs.openSync(p, 'wx');
      try { return fn(); } finally {
        try { fs.closeSync(fd); } catch {}
        try { fs.rmSync(p, { force: true }); } catch {}
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw new Error('floor 锁超时');
}

/**
 * 认领主持权。
 *
 * @param {object} o
 * @param {number} o.seq     human 那条「起头」消息的 seq
 * @param {string} o.me      当前 agent
 * @param {string|null} o.allowed  显式/角色指定的人；null = 语义指定，先到先得
 * @returns {{won:boolean, floor:object|null}}
 */
export function claimFloor(root, { seq, me, allowed = null }) {
  const meL = String(me).toLowerCase();
  return withLock(root, () => {
    const cur = readFloor(root);
    if (cur && cur.seq === seq) {
      return { won: cur.leader === meL, floor: cur };
    }
    if (allowed && String(allowed).toLowerCase() !== meL) {
      return { won: false, floor: cur };
    }
    const next = { seq, leader: meL, ts: Date.now(), how: allowed ? 'assigned' : 'claimed', opening: '' };
    writeFloor(root, next);
    return { won: true, floor: next };
  });
}

/** 主持人开口之后，把它的开场白记成「规则」，后面的人照着接 */
export function setOpening(root, { seq, me, text }) {
  const meL = String(me).toLowerCase();
  return withLock(root, () => {
    const cur = readFloor(root);
    if (!cur || cur.seq !== seq || cur.leader !== meL || cur.opening) return cur;
    const next = { ...cur, opening: String(text || '').slice(0, 800), openedAt: Date.now() };
    writeFloor(root, next);
    return next;
  });
}

/** 清空活跃 floor（人喊停时用）。轮次锁 .turn.json 由调用方一并清。 */
export function clearFloor(root) {
  try { fs.rmSync(floorPath(root), { force: true }); } catch {}
}

/** 给 prompt 用的一句话 */
export function floorBrief(floor, me) {
  if (!floor) return '';
  const meL = String(me).toLowerCase();
  if (floor.leader === meL) {
    if (!floor.opening) {
      return '【主持人】human 指定你起头。你先开口，并用一句话把规则定下来'
        + '（格式、怎么判定、谁接谁）。别人抢跑你就直接叫停。';
    }
    return `【主持人】你是本场主持人 ${floor.leader}（已开场）。继续用你定的规则带节奏、`
      + '维持秩序：有人不按规则接、或另起一条，你直接叫停并拉回正轨。';
  }
  if (!floor.opening) {
    return `【主持人】这一场由 ${floor.leader} 起头并定规则。它还没开口，你先别抢头 —— 只回 [SKIP]。`;
  }
  return `【主持人】${floor.leader} 已经开场并定了规则：「${floor.opening.slice(0, 400)}」。`
    + '按它定的规则接，不要另起一条，也不要重新讨论规则。';
}
