/**
 * lib/config.mjs — hub 配置（busd 写，driver 读）
 *
 * 放在 runtime 目录而不是代码仓库：它是运行状态，不是源码。
 * autoChat 默认 false —— 没人盯着就自动对话会烧钱，开关必须是显式的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './bus.mjs';

export const CONFIG_PATH = path.join(ROOT, 'hub-config.json');

const DEFAULTS = {
  autoChat: false,      // 自动对话总开关
  maxHop: 3,            // 自动对话最多几跳
  pausedUntil: 0,       // 熔断截止时间戳（ms）
  pauseReason: '',
  hopReset: {},         // { thread: ts } 人工放行的线程
  cwd: '',              // agent 工作目录（空 = 用 driver 自己的 cwd）
};

export function readConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const cfg = { ...DEFAULTS, ...raw };
  // 熔断过期自动解除，免得忘了解锁
  if (cfg.pausedUntil && cfg.pausedUntil < Date.now()) {
    cfg.pausedUntil = 0;
    cfg.pauseReason = '';
  }
  // cwd 校验：手写 JSON 时把 "D:\\test" 写成 "D:\test"，\t \b 会被当成控制字符，
  // 路径静默变成不可达。宁可回退到 ROOT 并出声，也不要让 driver 报"目录不存在"。
  if (cfg.cwd) {
    const bad = /[\x00-\x1f]/.test(cfg.cwd);
    if (bad || !fs.existsSync(cfg.cwd)) {
      console.warn(`[config] cwd 不可用（${bad ? '含控制字符，多半是 JSON 里反斜杠没转义' : '目录不存在'}）: ` +
        JSON.stringify(cfg.cwd) + ' → 回退到 ' + ROOT);
      cfg.cwd = '';
    }
  }
  return cfg;
}

export function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) writeConfig({});
  return readConfig();
}
