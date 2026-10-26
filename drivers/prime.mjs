/**
 * drivers/prime.mjs — prime-agent 的 driver
 *
 * prime 也支持 `-p/--print` 一次性模式,和 dsh / pi 一样每轮一个新进程。
 *
 * 必须显式指定 provider/model/api-key:实测不带这三个参数时,prime 会去打
 * 一个默认的云端口,回 `Provider denied access ... (forbidden, 403)`,
 * 看起来像没权限,其实是它没读到本机的 magpie 配置。
 * 带上 `--provider magpie --model group/freeauto` 后 2 秒就出答案。
 *
 * key 来源:环境变量 MAGPIE_API_KEY,其次 ~/.prime/agent/models.json 里
 * providers.magpie.apiKey(那是它自己的配置,不重复写死一份)。
 *
 * `--offline` 关掉启动时的网络操作(更新检查之类),避免无谓等待。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDriver } from './driver.mjs';
import { ROOT } from '../lib/bus.mjs';
import { readConfig } from '../lib/config.mjs';

const NAME = 'prime';
const once = process.argv.includes('--once');
const replay = process.argv.includes('--replay');
const cwd = readConfig().cwd || ROOT;
const ASK_TIMEOUT_MS = 240_000;
const PROVIDER = 'magpie';
const MODEL = 'group/freeauto';

function findPrimeExe() {
  const cands = [
    process.env.PRIME_EXE,
    path.join(os.homedir(), '.local', 'share', 'prime-agent', 'prime-agent.exe'),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 prime-agent.exe(设 PRIME_EXE)');
}

function magpieKey() {
  if (process.env.MAGPIE_API_KEY) return process.env.MAGPIE_API_KEY;
  try {
    const p = path.join(os.homedir(), '.prime', 'agent', 'models.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j?.providers?.[PROVIDER]?.apiKey || '';
  } catch { /* 没有就让 prime 自己报错 */ }
  return '';
}

function askOnce(text) {
  return new Promise((resolve, reject) => {
    const exe = findPrimeExe();
    const key = magpieKey();
    const args = ['-p', '--offline', '--no-session', '--provider', PROVIDER, '--model', MODEL];
    if (key) args.push('--api-key', key);
    args.push(text);

    const child = spawn(exe, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env },
    });

    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`prime 超时(${ASK_TIMEOUT_MS}ms)`));
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
        reject(new Error(`prime 没有输出(${lastErr.slice(0, 200)})`));
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
  console.error('prime driver 启动失败:', e);
  process.exit(1);
});
