/**
 * drivers/opencode.mjs — OpenCode 的 driver
 *
 * opencode-cli.exe acp，二进制不在 PATH 且升级会改版本号目录，所以动态找。
 */
import { AcpClient, findOpenCodeCli } from './acp.mjs';
import { runDriver } from './driver.mjs';
import { ROOT } from '../lib/bus.mjs';
import { readConfig } from '../lib/config.mjs';

const NAME = 'opencode';
const once = process.argv.includes('--once');
const replay = process.argv.includes('--replay');
const cwd = readConfig().cwd || ROOT;

async function createSession({ onEvent } = {}) {
  const c = new AcpClient({ exe: findOpenCodeCli(), args: ['acp'], cwd, label: NAME, onEvent }).start();
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
  console.error('opencode driver 致命错误:', e);
  process.exit(1);
});
