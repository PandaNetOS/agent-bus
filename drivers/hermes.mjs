/**
 * drivers/hermes.mjs — Hermes 的 driver
 *
 * Hermes 自带 ACP stdio server（hermes-acp.exe，无子命令）。
 * 每轮开新会话：agent 之间对话的上下文由总线消息本身承载，
 * 续用同一个会话只会让上下文越滚越大、越来越慢。
 */
import fs from 'node:fs';
import { AcpClient } from './acp.mjs';
import { runDriver } from './driver.mjs';
import { ROOT } from '../lib/bus.mjs';
import { readConfig } from '../lib/config.mjs';

const NAME = 'hermes';

function findExe() {
  const cands = [
    process.env.HERMES_ACP,
    'D:\\Hermes\\bin\\hermes-acp.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 hermes-acp.exe（试过 HERMES_ACP 和 D:\\Hermes\\bin\\）');
}

const once = process.argv.includes('--once');
const replay = process.argv.includes('--replay');
const cwd = readConfig().cwd || ROOT;

async function createSession({ onEvent } = {}) {
  const c = new AcpClient({ exe: findExe(), args: [], cwd, label: NAME, onEvent }).start();
  await c.initialize();
  await c.newSession(cwd);
  return {
    ask: async (text) => {
      const r = await c.prompt(text, { timeoutMs: 240_000 });
      if (!r.answer) throw new Error(`空回复（stopReason=${r.stopReason || '未知'}）`);
      return r.answer;
    },
    close: () => c.close(),
  };
}

runDriver({ name: NAME, createSession, once, replay, workdir: cwd }).catch((e) => {
  console.error('hermes driver 致命错误:', e);
  process.exit(1);
});
