/**
 * tools/say.mjs — 从命令行往总线发一条消息（走 busd，或直连日志）
 *
 *   node tools/say.mjs "文本"
 *   node tools/say.mjs "@hermes 你看下" --to hermes
 *   node tools/say.mjs "文本" --direct         不经过 busd，直接写日志
 *
 * 为什么不用 curl：git-bash 把中文命令行参数交给 Windows 的 curl.exe 时会
 * 按 ANSI 代码页转换，落盘就是乱码。Node 的 argv 是 UTF-16 转 UTF-8，干净。
 */
import { append } from '../lib/bus.mjs';

const argv = process.argv.slice(2);
const words = [];
let to = '';
let direct = false;
let via = 'human';
let thread = '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--to') to = argv[++i] || '';
  else if (a === '--thread') thread = argv[++i] || '';
  else if (a === '--via') via = argv[++i] || 'human';
  else if (a === '--direct') direct = true;
  else words.push(a);
}
const text = words.join(' ');
if (!text) { console.error('用法: node tools/say.mjs "文本" [--to agent] [--direct]'); process.exit(2); }

const m0 = text.match(/@([a-z0-9_-]+)/i);
const mentions = to || (m0 ? m0[1].toLowerCase() : '');

if (direct) {
  const m = append({ from: via === 'human' ? 'human' : via, kind: 'msg', to, text, mentions, thread, hop: 0, via });
  console.log(`[#${m.seq}] 直写日志`);
} else {
  const port = process.env.PORT || 8088;
  const r = await fetch(`http://127.0.0.1:${port}/api/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: via === 'human' ? 'human' : via, text, to, mentions, thread, via }),
  });
  if (!r.ok) { console.error('失败', r.status, await r.text()); process.exit(1); }
  const m = await r.json();
  console.log(`[#${m.seq}] → ${m.to || '(全体)'}`);
}
