/**
 * drivers/dsh.mjs —— DSH 的 driver
 *
 * DSH 有两条路可走，实测下来只有第二条能用：
 *
 *   1) ACP（`dsh acp`，JSON-RPC over stdio）—— 能 initialize、能建 session，
 *      但一发 prompt 就报：
 *        no API key for provider route "deepseek-official";
 *        export DEEPSEEK_API_KEY in the launching environment
 *      桌面端能聊是因为它的 key 走的是 device grant（.credentials.yaml 里的
 *      deepseek-account-platform/device），不是 API key。命令行进程拿不到那个
 *      grant，所以 ACP 这条路在无头环境里是死的。
 *
 *   2) `dsh headless "<prompt>"` —— 一次一进程，stdout 就是答案正文，
 *      约 11~13 秒。走的是同一份 device grant，所以能用。
 *
 * 于是 ask() 每次 spawn 一个新进程。比 ACP 的持久会话慢（少了 ~6 秒的
 * 握手开销其实省不掉，换来的是真能跑通），但没有会话可以泄漏。
 *
 * 另外：stderr 里固定会有一条 orca-agent-hooks 的 ERR_MODULE_NOT_FOUND
 * 警告，是 DSH 自己 profile 的插件缺失，与本 driver 无关，不要当成失败。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { runDriver } from './driver.mjs';
import { ROOT } from '../lib/bus.mjs';
import { readConfig } from '../lib/config.mjs';

const NAME = 'dsh';
const once = process.argv.includes('--once');
const replay = process.argv.includes('--replay');
const cwd = readConfig().cwd || ROOT;

/**
 * 定位 dsh 的入口。
 * 直接 spawn bin.js 而不是走 dsh.ps1：PS 5.1 转发参数时会把 UTF-8 中文嚼烂，
 * 而且多一层 pwsh 启动更慢。exe 用当前 node，args 用绝对路径的 bin.js。
 */
function findDshBin() {
  const cands = [
    process.env.DSH_BIN,
    'C:\\Users\\panda\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 dsh 入口（设置 DSH_BIN 或检查 @deepseek-ai/dsh 是否安装）');
}

const ASK_TIMEOUT_MS = 240_000;

/**
 * 跑一次 headless，返回 stdout 里的答案。
 * stdout 是干净的正文；reasoning 和插件警告都在 stderr，丢弃。
 */
function askOnce(text) {
  return new Promise((resolve, reject) => {
    const bin = findDshBin();
    const child = spawn(process.execPath, [bin, 'headless', text], {
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
      reject(new Error(`dsh headless 超时（${ASK_TIMEOUT_MS}ms）`));
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
        // 只把 stderr 的「最后一行」带进错误信息：整个 stderr 有 1KB 多，
        // 全是 DSH 自己那个插件缺失的堆栈，进了日志纯属噪音
        const lastErr = err.trim().split('\n').filter(Boolean).slice(-1)[0] || `exit=${code}`;
        reject(new Error(`dsh 无输出（${lastErr.slice(0, 200)}）`));
        return;
      }
      resolve(answer);
    });
  });
}

async function createSession() {
  return {
    // headless 没有长命会话，ask 就是一次完整往返。
    // onEvent 用不上：拿不到中间流，只有最终结果。
    ask: (text) => askOnce(text),
    close: () => {},
  };
}

runDriver({ name: NAME, createSession, once, replay, workdir: cwd }).catch((e) => {
  console.error('dsh driver 启动失败:', e);
  process.exit(1);
});
