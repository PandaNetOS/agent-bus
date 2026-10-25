/**
 * lib/diagnose.mjs —— 「这条消息为什么没人回」的判据
 *
 * 从 webui/busd.mjs 里提出来的。挪出来的唯一理由：它是纯逻辑，却有 bug。
 *
 * 埋在 busd 里的时候没法测 —— busd 一 import 就起 HTTP 服务器，验收脚本碰不了
 * 它。于是 diagnose() 上线当天就印出过这种自相矛盾的话：
 *
 *   "@opencode 没有 driver 在接（只有 dsh / hermes / opencode 在线）"
 *
 * 目标明明在线，真实原因是跳数到顶。原因是原实现只要看到有人 not-named 就
 * 走「没 driver」分支，根本没看目标自己那一行的判据。
 *
 * 判据不另写一套规则，而是对每个成员跑 lib/gates.mjs 里那六道闸 —— 和 driver
 * 实际用的是同一份实现。否则诊断会和真实行为说不一致，那比没有诊断更糟。
 * 读的是真实 driver 游标（.cursor-<name>.json）和抢答记录（.claims.jsonl）。
 *
 * 依赖显式传入而不是自己 import ROOT：测试要指向临时 runtime。
 */
import fs from 'node:fs';
import path from 'node:path';
import { gate, MAX_HOP_DEFAULT } from './gates.mjs';

/** 人类可读的一句话解释 */
export const WHY_TEXT = {
  self: '自己发的',
  'not-named': '没点名它',
  consumed: '它已经处理过这条',
  replied: '它已经回过这条',
  skipped: '它选择不说话',
  claimed: '群里已有人抢答',
  answered: '群里已有人回过',
  breaker: '熔断中（自动消息太密，已暂停）',
  stale: '发出太久没人接，已过期（时效闸）',
  'hop-limit': `跳数到顶（这条已经转手 ${MAX_HOP_DEFAULT} 次，防止 agent 之间无限对聊）`,
  loop: '同样的话说过两次，判为循环',
};

/**
 * @param {object} deps
 * @param {string} deps.root       运行时目录（room.jsonl / .cursor-* 所在）
 * @param {string[]} deps.members  群成员名
 */
export function makeDiagnose({ root, members }) {
  const claimsPath = path.join(root, '.claims.jsonl');

  /** 这个 agent 对这条消息实际做了什么：回过、还是主动沉默 */
  function actionOf(me, seq) {
    try {
      const p = path.join(root, `stream-${me}.jsonl`);
      if (!fs.existsSync(p)) return null;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        let e;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        if (e.seq !== seq) continue;
        if (e.type === 'replied') return 'replied';
        if (e.type === 'skipped') return 'skipped';
      }
    } catch { /* 流文件读不了就当不知道，退回泛化文案 */ }
    return null;
  }

  /** 对一条消息，把六道闸按每个成员跑一遍 */
  function why(m, all, cfg) {
    const claimed = new Set(
      fs.existsSync(claimsPath)
        ? fs.readFileSync(claimsPath, 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l).seq; } catch { return null; } }).filter((x) => x != null)
        : [],
    );

    return members.map((me) => {
      // 每个成员的 consumed 不同，游标是 driver 自己维护的
      let consumed = new Set();
      let baseline = 0;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(root, `.cursor-${me}.json`), 'utf8'));
        consumed = new Set(c.consumed || []);
        baseline = c.baseline ?? 0;
      } catch { /* 没游标文件 = 这个 driver 从没启动过 */ }

      const g = gate(m, { me, all, consumed, config: cfg, claimed });
      // consumed 只说明这条进了它的游标，不代表它开过口 —— 群聊里它可能
      // 用 [SKIP] 主动沉默。诊断必须说清是哪一种，否则界面会印出
      // 「它已经回过这条」，而实际上一条回复都没有（实测 #143）。
      let reason = g.reason || 'ok';
      if (reason === 'consumed') reason = actionOf(me, m.seq) || 'consumed';
      return {
        agent: me,
        ok: g.ok,
        reason,
        detail: g.detail || '',
        hasDriver: fs.existsSync(path.join(root, `.heartbeat-${me}.json`)),
        belowBaseline: m.seq <= baseline,
      };
    });
  }

  /** 一句话解释；空串表示「会有人回」 */
  function diagnose(m, all, cfg) {
    const rows = why(m, all, cfg);
    const live = rows.filter((r) => r.hasDriver);
    const will = live.filter((r) => r.ok);

    if (!m.via || m.via === 'human') {
      if (!cfg.autoChat) return '自动对话总开关是关的，没人会被投喂';
    }
    if (will.length) return '';
    if (!live.length) return '没有任何 driver 在跑（左栏成员卡都是灰的）';

    const named = m.to && m.to !== '*';
    if (named) {
      const target = rows.find((r) => r.agent === m.to);
      if (!target) return `@${m.to} 不在群里`;
      // 点名的目标在线时，要说它自己的原因。
      // 之前只要有人是 not-named 就报「没有 driver 在接」，结果目标明明在线、
      // 真实原因却是 hop-limit，界面上就印出「@opencode 没有 driver 在接
      // （只有 dsh / hermes / opencode 在线）」这种自相矛盾的话。
      if (target.hasDriver) {
        // stale 的 detail 里有真实分钟数（「已过 37 分钟没人接」），比静态文案有用。
        // 其它闸的 detail 是内部口径（如 hop-limit 的「hop 3 >= 3」），
        // 对用户不如静态文案清楚，所以只有 stale 优先用 detail。
        const text = target.reason === 'stale' && target.detail
          ? target.detail
          : (WHY_TEXT[target.reason] || target.reason);
        return `@${m.to} 在线，但${text}`;
      }
      return `@${m.to} 没有 driver 在接（只有 ${live.map((r) => r.agent).join(' / ')} 在线）`;
    }
    // 三个人都主动沉默：说清楚，别让人以为消息丢了
    if (live.length && live.every((r) => r.reason === 'skipped')) {
      return `${live.length} 个 agent 都主动选择了沉默（觉得这句不用接）`;
    }
    return [...new Set(live.map((r) => (
      (r.reason === 'stale' && r.detail) || WHY_TEXT[r.reason] || r.reason
    )))].join('；');
  }

  return { why, diagnose };
}
