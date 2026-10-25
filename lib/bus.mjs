/**
 * lib/bus.mjs — 总线读写（Node 侧）
 *
 * 写路径不 spawn powershell，而是自己实现同一套协议：
 *   同一把 .bus.lock（独占创建 = bus.ps1 的 FileMode::CreateNew）
 *   同样的字段顺序、UTF-8 无 BOM、每行以 \n 结尾
 * 理由：spawn powershell 每次 200-400ms，且文本里的双引号/中文在
 * -File 参数传递时会被再解析一次，是稳定的编码事故源。
 * 代价是两套实现，所以验收里必须有一条「PS 与 Node 混写并发，seq 仍唯一连续」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = process.env.AGENT_BUS_ROOT || 'D:\\PNOS\\agent-bus';
export const ROOM = path.join(ROOT, 'room.jsonl');
const LOCK = path.join(ROOT, '.bus.lock');
const CEO = path.join(ROOT, 'ceo.txt');

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 与 PS 的 (Get-Date).ToString('o') 同形状：7 位小数 + 本地时区偏移 */
function isoLocal(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}0000${sign}${oh}:${om}`;
}

/** 直接读日志（无锁）。坏行跳过，与 Get-Messages 行为一致。 */
export function readAll() {
  let txt;
  try { txt = fs.readFileSync(ROOM, 'utf8'); } catch { return []; }
  const out = [];
  let n = 0;
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      n++;
      if (typeof o.seq !== 'number') o.seq = n;
      if (o.thread === undefined) o.thread = '';
      if (o.reply_to === undefined) o.reply_to = 0;
      if (o.mentions === undefined) o.mentions = '';
      if (o.hop === undefined) o.hop = 0;
      if (o.via === undefined) o.via = 'human';
      out.push(o);
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 与 bus.ps1 同一把锁，也同一套持有者协议：锁文件里写 {pid, token, host, since}。
 * 为什么要写内容：bus.ps1 靠 pid 判断「锁是不是没人要了」，空锁文件会被它当成
 * 陈旧锁清掉 —— 那会在 Node 正写着的时候把临界区打开。两套实现必须同协议。
 */
function withLock(fn, timeoutMs = 10000) {
  const t0 = Date.now();
  let fd = null;
  const token = crypto.randomUUID().replace(/-/g, '');
  for (;;) {
    try { fd = fs.openSync(LOCK, 'wx'); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`bus: 获取锁超时（${timeoutMs}ms）。若确认没有写入进行中，删掉 ${LOCK} 重试。`);
      }
      sleepSync(15);
    }
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, host: os.hostname(), since: new Date().toISOString() }));
  } catch { /* 写不进持有者信息不影响互斥本身 */ }
  try { return fn(); }
  finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try {
      // 只删自己那把锁：被判陈旧并重建后 token 对不上，就不能动别人的。
      const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      if (cur && cur.token === token) fs.unlinkSync(LOCK);
    } catch { try { fs.unlinkSync(LOCK); } catch {} }
  }
}

/** 追加一条。seq 在锁内重算，与 bus.ps1 完全同序。 */
export function append(fields) {
  return withLock(() => {
    const all = readAll();
    let nextSeq = 1;
    for (const m of all) if (m.seq >= nextSeq) nextSeq = m.seq + 1;
    const obj = {
      seq: nextSeq,
      ts: isoLocal(),
      from: fields.from,
      kind: fields.kind || 'msg',
      to: fields.to || '',
      task: fields.task || 0,
      text: fields.text || '',
      thread: fields.thread || '',
      reply_to: fields.reply_to || 0,
      mentions: fields.mentions || '',
      hop: fields.hop || 0,
      via: fields.via || 'human',
    };
    fs.mkdirSync(ROOT, { recursive: true });
    fs.appendFileSync(ROOM, JSON.stringify(obj) + '\n', 'utf8');
    return obj;
  });
}

export function readCeo() {
  try { return fs.readFileSync(CEO, 'utf8').trim(); } catch { return ''; }
}

export function writeCeo(name) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(CEO, String(name || '').trim(), 'utf8');
}

/** 等日志出现 seq > since 的新消息（轮询，简单可靠） */
export function waitForNew(since, timeoutMs = 30000, pollMs = 300) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const all = readAll();
      const fresh = all.filter((m) => m.seq > since);
      if (fresh.length) return resolve(fresh);
      if (Date.now() - t0 > timeoutMs) return resolve([]);
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

export function parseMentions(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}
