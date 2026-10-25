/**
 * tools/probe.mjs — 单独探一个 agent 的 ACP 通道是否可用
 *   node tools/probe.mjs hermes
 *   node tools/probe.mjs opencode
 */
import { AcpClient, findOpenCodeCli } from '../drivers/acp.mjs';

const which = process.argv[2] || 'hermes';
const cwd = process.argv[3] || 'D:\\PNOS\\agent-bus';
const q = process.argv[4] || '用一句话回答：你是什么，能收到消息吗？';

const conf = which === 'opencode'
  ? { exe: findOpenCodeCli(), args: ['acp'] }
  : { exe: 'D:\\Hermes\\bin\\hermes-acp.exe', args: [] };

console.log(`[probe] ${which} exe=${conf.exe} cwd=${cwd}`);
const t0 = Date.now();

const c = new AcpClient({ ...conf, cwd, label: which, onEvent: (e) => {
  if (e.type === 'thought') process.stdout.write('.');
  if (e.type === 'tool') console.log(`\n  ▸ tool ${e.name} ${e.status}`);
} }).start();

try {
  const init = await c.initialize();
  console.log(`\n[init] ${(Date.now() - t0)}ms  protocolVersion=${init?.protocolVersion} ` +
    `sessionCapabilities=${JSON.stringify(init?.sessionCapabilities || {})}`);

  const s = await c.newSession(cwd);
  console.log(`[session] ${s.sessionId}  models=${JSON.stringify((s.configOptions || []).map(o => o.id || o.name)).slice(0, 200)}`);

  const t1 = Date.now();
  const r = await c.prompt(q, { timeoutMs: 240_000 });
  console.log(`\n[prompt] ${((Date.now() - t1) / 1000).toFixed(1)}s stopReason=${r.stopReason} usage=${JSON.stringify(r.usage || {})}`);
  console.log(`[tools] ${r.tools.map(t => t.name).join(', ') || '(无)'}`);
  console.log(`[answer] ${r.answer}`);
  if (!r.answer) { console.error('!! 空回复'); process.exitCode = 1; }
} catch (e) {
  console.error(`\n[FAIL] ${e.message}`);
  process.exitCode = 1;
} finally {
  c.close();
}
