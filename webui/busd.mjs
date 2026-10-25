/**
 * webui/busd.mjs — agent 工作台后端
 *
 * 只读日志 + 人工发言 + 配置。driver 不经过它，所以 busd 挂掉对话照跑。
 * 零依赖：node:http + SSE。不用框架、不用打包。
 *
 *   node webui/busd.mjs            默认 127.0.0.1:8088
 *   PORT=8090 node webui/busd.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, readAll, append, readCeo, writeCeo } from '../lib/bus.mjs';
import { readConfig, writeConfig, ensureConfig } from '../lib/config.mjs';
import { breakerState, names, gate, MAX_HOP_DEFAULT, BROADCAST } from '../lib/gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8088);
const HOST = process.env.HOST || '127.0.0.1';
const MEMBERS = (process.env.AGENT_BUS_MEMBERS || 'dsh,hermes,opencode').split(',').map((s) => s.trim());

ensureConfig();

// ---------------- 状态 ----------------
function heartbeatOf(name) {
  try {
    const p = path.join(ROOT, `.heartbeat-${name}.json`);
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    o.online = Date.now() - o.ts < 8000;
    return o;
  } catch {
    return { name, online: false, state: 'off' };
  }
}

function buildState() {
  const all = readAll();
  const cfg = readConfig();
  const now = Date.now();

  const members = MEMBERS.map((name) => {
    const mine = all.filter((m) => m.from === name);
    const hb = heartbeatOf(name);
    return {
      name,
      online: hb.online,
      state: hb.state || 'off',
      currentSeq: hb.currentSeq || 0,
      lastSeq: hb.lastSeq || 0,
      msgs: mine.length,
      auto: mine.filter((m) => m.via && m.via !== 'human').length,
      lastAt: mine.length ? mine[mine.length - 1].ts : null,
    };
  });

  const tasks = all
    .filter((m) => m.kind === 'task')
    .map((t) => {
      const claim = all.find((m) => m.kind === 'claim' && m.task === t.seq);
      const done = all.find((m) => m.kind === 'done' && m.task === t.seq);
      return {
        seq: t.seq, text: t.text, from: t.from, at: t.ts,
        claimedBy: claim ? claim.from : null,
        closed: !!done, closedTo: done ? done.to : null,
      };
    });

  const br = breakerState(all, now);

  return {
    now,
    root: ROOT,
    ceo: readCeo(),
    config: cfg,
    maxHop: cfg.maxHop ?? MAX_HOP_DEFAULT,
    breaker: br,
    paused: !!(cfg.pausedUntil && cfg.pausedUntil > now),
    pausedUntil: cfg.pausedUntil || 0,
    pauseReason: cfg.pauseReason || '',
    members,
    tasks,
    counts: {
      total: all.length,
      auto: all.filter((m) => m.via && m.via !== 'human').length,
      human: all.filter((m) => !m.via || m.via === 'human').length,
      lastSeq: all.length ? all[all.length - 1].seq : 0,
    },
  };
}

// ---------------- SSE ----------------
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// 轮询日志 + driver 事件流，推给所有 SSE 客户端
let lastSeq = 0;
let streamOffsets = {};
function pump() {
  try {
    const all = readAll();
    const fresh = all.filter((m) => m.seq > lastSeq);
    if (fresh.length) {
      lastSeq = fresh[fresh.length - 1].seq;
      for (const m of fresh) broadcast('msg', m);
      broadcast('state', buildState());
    }
  } catch {}

  for (const name of MEMBERS) {
    const p = path.join(ROOT, `stream-${name}.jsonl`);
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    const prev = streamOffsets[name] || 0;
    if (stat.size <= prev) { if (stat.size < prev) streamOffsets[name] = 0; continue; }
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(stat.size - prev);
      fs.readSync(fd, buf, 0, buf.length, prev);
      fs.closeSync(fd);
      streamOffsets[name] = stat.size;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { broadcast('agent', { agent: name, ...JSON.parse(line) }); } catch {}
      }
    } catch {}
  }
}
setInterval(pump, 700).unref();

// ---------------- HTTP ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(path.join(HERE, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && p === '/api/log') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Number(url.searchParams.get('limit') || 300);
      const all = readAll();
      const unread = all.filter((m) => m.seq > since);
      const sel = unread.slice(0, limit);
      return json(res, 200, { messages: sel, count: all.length, truncated: unread.length > sel.length });
    }

    if (req.method === 'GET' && p === '/api/state') {
      return json(res, 200, buildState());
    }

    if (req.method === 'GET' && p === '/api/events') {
      const agent = String(url.searchParams.get('agent') || '').trim();
      const limit = Number(url.searchParams.get('limit') || 200);
      if (!MEMBERS.includes(agent)) return json(res, 400, { error: 'unknown agent' });
      const file = path.join(ROOT, `stream-${agent}.jsonl`);
      let events = [];
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit);
        events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch {}
      return json(res, 200, { agent, events });
    }

    if (req.method === 'GET' && p === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ root: ROOT })}\n\n`);
      clients.add(res);
      const all = readAll();
      lastSeq = Math.max(lastSeq, all.length ? all[all.length - 1].seq : 0);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (req.method === 'POST' && p === '/api/say') {
      const b = await readBody(req);
      const text = String(b.text || '').trim();
      if (!text) return json(res, 400, { error: 'text 必填' });
      const from = String(b.from || 'human').trim();
      // 前端已经解析过 @名字，但这里自己再算一次：总线不该信任客户端传的
      // to/mentions（同一个 API 也被 tools/say.mjs 和 curl 调）。
      const m0 = String(text).match(/@([a-z0-9_-]+)/i);
      const named = m0 ? m0[1].toLowerCase() : '';
      // 群聊语义：不点名 = @全体。用 to='*' 哨兵，不是靠「to 为空」推断——
      // v1/早期消息也满足空条件，不该被追溯成广播。
      const broadcast = !named && String(b.broadcast ?? '1') !== '0';
      const target = named || (broadcast ? BROADCAST : '');
      const msg = append({
        from,
        kind: 'msg',
        to: target,
        text,
        thread: String(b.thread || '').trim(),
        reply_to: Number(b.reply_to || 0),
        mentions: target,
        hop: 0,
        via: b.via === 'driver' ? `driver:${from}` : 'human',
      });
      lastSeq = Math.max(lastSeq, msg.seq - 1); // 让 pump 立刻推这一条
      return json(res, 200, msg);
    }

    if (req.method === 'POST' && p === '/api/config') {
      const b = await readBody(req);
      const patch = {};
      if (typeof b.autoChat === 'boolean') patch.autoChat = b.autoChat;
      if (Number.isFinite(b.maxHop)) patch.maxHop = Math.max(0, Math.min(20, b.maxHop));
      if (typeof b.pausedUntil === 'number') patch.pausedUntil = b.pausedUntil;
      if (b.pauseReason !== undefined) patch.pauseReason = String(b.pauseReason);
      const cfg = writeConfig(patch);
      broadcast('state', buildState());
      return json(res, 200, cfg);
    }

    if (req.method === 'POST' && p === '/api/hop-reset') {
      const b = await readBody(req);
      const thread = String(b.thread || '').trim();
      if (!thread) return json(res, 400, { error: 'thread 必填' });
      const cfg = readConfig();
      const hopReset = { ...(cfg.hopReset || {}), [thread]: Date.now() };
      writeConfig({ hopReset });
      broadcast('state', buildState());
      return json(res, 200, { thread, hopReset });
    }

    if (req.method === 'POST' && p === '/api/ceo') {
      const b = await readBody(req);
      writeCeo(String(b.name || ''));
      broadcast('state', buildState());
      return json(res, 200, { ceo: readCeo() });
    }

    if (req.method === 'POST' && p === '/api/cancel') {
      const b = await readBody(req);
      const agent = String(b.agent || '').trim();
      if (!agent) return json(res, 400, { error: 'agent 必填' });
      fs.writeFileSync(path.join(ROOT, `.cancel-${agent}`), String(Date.now()), 'utf8');
      return json(res, 200, { ok: true, agent });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`busd 已启动 http://${HOST}:${PORT}   root=${ROOT}`);
  const all = readAll();
  lastSeq = all.length ? all[all.length - 1].seq : 0;
  console.log(`日志 ${all.length} 条，游标 seq=${lastSeq}`);
});
