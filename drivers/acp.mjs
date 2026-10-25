/**
 * drivers/acp.mjs — 通用 ACP 客户端（JSON-RPC over stdio，ndjson）
 *
 * 两个 agent 共用一份实现：Hermes 用 `hermes-acp.exe`（无子命令），
 * OpenCode 用 `opencode-cli.exe acp`。差异只在可执行文件和参数。
 *
 * 协议要点（都是踩过的坑）：
 *   - protocolVersion 必须是数字 1，传字符串 "0.1.0" 会被拒
 *   - 每次都是新起的 server 进程，session 存在它内存里；续会话必须先 session/resume
 *   - HOME / USERPROFILE / PWD 必须是 Windows 路径，否则 CLI 试图 cd 到 MSYS 路径而失败
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function findOpenCodeCli() {
  const candidates = [];
  const appdata = process.env.APPDATA;
  if (appdata) {
    const base = path.join(appdata, 'ai.opencode.desktop', 'cli');
    if (existsSync(base)) {
      for (const d of readdirSync(base)) {
        candidates.push(path.join(base, d, 'opencode-cli.exe'));
      }
    }
  }
  candidates.push('D:\\test\\OpenCode\\@opencodedesktop\\resources\\opencode-cli.exe');
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('找不到 opencode-cli.exe（找过 %APPDATA%\\ai.opencode.desktop\\cli\\* 和 D:\\test\\OpenCode）');
}

export class AcpClient {
  /**
   * @param {{exe:string,args?:string[],cwd:string,onEvent?:(e:object)=>void,label?:string}} opts
   */
  constructor({ exe, args = [], cwd, onEvent, label = 'acp' }) {
    this.exe = exe;
    this.args = args;
    this.cwd = cwd;
    this.onEvent = onEvent || (() => {});
    this.label = label;
    this.proc = null;
    this.pending = new Map();
    this.idSeq = 0;
    this.stderrTail = '';
    this.answer = [];
    this.thoughts = [];
    this.tools = [];
    this.usage = null;
    this.sessionId = null;
  }

  start() {
    if (!existsSync(this.cwd)) throw new Error(`工作目录不存在: ${this.cwd}`);
    // 先 chdir：子进程若继承 MSYS 格式的 cwd，Go 写的 CLI 会直接失败
    try { process.chdir(this.cwd); } catch {}

    const env = { ...process.env };
    env.HOME = env.USERPROFILE = process.env.USERPROFILE || 'C:\\Users\\panda';
    env.PWD = this.cwd;

    this.proc = spawn(this.exe, this.args, { env, cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this._onLine(line));
    this.proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`${this.label} 进程退出 code=${code}`));
      this.pending.clear();
      this.onEvent({ type: 'exit', code });
    });
    return this;
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      return;
    }
    if (msg.method !== 'session/update') return;

    const u = msg.params?.update || {};
    switch (u.sessionUpdate) {
      case 'agent_thought_chunk': {
        const t = u.content?.text || '';
        this.thoughts.push(t);
        this.onEvent({ type: 'thought', text: t });
        break;
      }
      case 'tool_call': {
        const rec = { name: u.name || u.title || 'tool', status: 'pending', at: Date.now() };
        this.tools.push(rec);
        this.onEvent({ type: 'tool', name: rec.name, status: 'pending' });
        break;
      }
      case 'tool_call_update': {
        this.onEvent({ type: 'tool', name: u.name || '', status: u.status || '' });
        break;
      }
      case 'agent_message_chunk': {
        const t = u.content?.text || '';
        this.answer.push(t);
        this.onEvent({ type: 'answer', text: t });
        break;
      }
      case 'usage_update': {
        this.usage = u;
        this.onEvent({ type: 'usage', usage: u });
        break;
      }
      default:
        break;
    }
  }

  send(method, params, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('ACP 未启动'));
      const id = ++this.idSeq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize() {
    const r = await this.send('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'agent-bus', version: '2.0', title: 'agent-bus' },
    });
    this.initResult = r;
    return r;
  }

  async newSession(cwd = this.cwd) {
    const r = await this.send('session/new', { cwd, mcpServers: [] });
    this.sessionId = r.sessionId;
    return r;
  }

  async resumeSession(sessionId, cwd = this.cwd) {
    const r = await this.send('session/resume', { sessionId, cwd });
    this.sessionId = sessionId;
    return r;
  }

  /** 发一轮 prompt，收集流事件，返回最终文本 */
  async prompt(text, { timeoutMs = 180_000 } = {}) {
    this.answer = [];
    this.thoughts = [];
    this.tools = [];
    const t0 = Date.now();
    const result = await this.send(
      'session/prompt',
      { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
      timeoutMs,
    );
    return {
      answer: this.answer.join('').trim(),
      thoughts: this.thoughts.join(''),
      tools: this.tools,
      usage: result?.usage || this.usage,
      stopReason: result?.stopReason,
      ms: Date.now() - t0,
    };
  }

  cancel() {
    if (this.sessionId) this.notify('session/cancel', { sessionId: this.sessionId });
  }

  close() {
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }
}
