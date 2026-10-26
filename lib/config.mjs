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
  // 群聊模式（默认开）：不点名的群消息三个人都看得到，各自决定说不说，
  // 沉默由 agent 自己用 [SKIP] 表达。关掉就退回「广播只有一人回复」的旧行为。
  groupChat: true,
  // 消息发出多久没人接就不再自动投喂（见 gates.mjs 的时效闸）。
  // 起因是一条「你好」在 37 分钟后才被回答 —— 反循环闸是「最近 20 条」
  // 的滑动窗口，跟时间没关系。
  maxAgeMs: 300_000,    // 5 分钟
  // 已被人喊停的场次 thread（t-${floor.seq}）。人喊停后这条 thread 里的
  // 自动回话一律不许再投喂，否则旧链还会拖一串尾巴（实测 #528 喊停后
  // #530–#541 还在接龙/辩论）。
  stoppedThreads: [],
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
