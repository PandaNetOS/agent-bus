/**
 * drivers/pi.mjs — pi 的 driver
 *
 * pi 是 `@earendil-works/pi-coding-agent`,自带 `-p/--print` 一次性模式:
 * 投一句 prompt,打完答案就退出。和 dsh 一样是「每轮一个新进程」,
 * 没有长会话可续 —— 上下文靠总线消息承载。
 *
 * 为什么要显式带 MAGPIE_API_KEY:`D:\PNOS\tools\pi.cmd` 里 set 了它,
 * 但这里直接 spawn node 跑 cli.js(绕开 .cmd 的引号/编码事故),
 * 所以得自己把 key 补上。优先用环境变量,其次从那个 .cmd 里读。
 *
 * 输出干净:pi 的 reasoning 走 stderr,stdout 只有答案。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { runDriver } from './driver.mjs';
import { ROOT } from '../lib/bus.mjs';
import { readConfig } from '../lib/config.mjs';

const NAME = 'pi';
const once = process.argv.includes('--once');
const replay = process.argv.includes('--replay');
const cwd = readConfig().cwd || ROOT;
const ASK_TIMEOUT_MS = 240_000;

function findPiCli() {
  const cands = [
    process.env.PI_CLI,
    'D:\\test\\pi-extract\\root\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 pi 的 cli.js(设 PI_CLI,或确认 @earendil-works/pi-coding-agent 已解包)');
}

/** MAGPIE_API_KEY:环境变量优先,其次从 pi.cmd 里抄 */
function magpieKey() {
  if (process.env.MAGPIE_API_KEY) return process.env.MAGPIE_API_KEY;
  try {
    const txt = fs.readFileSync('D:\\PNOS\\tools\\pi.cmd', 'utf8');
    const m = txt.match(/MAGPIE_API_KEY=([^\s"]+)/);
    if (m) return m[1];
  } catch { /* 没有就算了,让 pi 自己报缺 key */ }
  return '';
}

function askOnce(text) {
  return new Promise((resolve, reject) => {
    const cli = findPiCli();
    const env = { ...process.env };
    const key = magpieKey();
    if (key) env.MAGPIE_API_KEY = key;

    const child = spawn(process.execPath, [cli, '-p', '--no-session', text], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env,
    });

    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`pi 超时(${ASK_TIMEOUT_MS}ms)`));
    }, ASK_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const answer = out.trim();
      if (!answer) {
        const lastErr = err.trim().split('\n').filter(Boolean).slice(-1)[0] || `exit=${code}`;
        reject(new Error(`pi 没有输出(${lastErr.slice(0, 200)})`));
        return;
      }
      resolve(answer);
    });
  });
}

async function createSession() {
  return {
    ask: (text) => askOnce(text),
    close: () => {},
  };
}

runDriver({ name: NAME, createSession, once, replay, workdir: cwd }).catch((e) => {
  console.error('pi driver 启动失败:', e);
  process.exit(1);
});
