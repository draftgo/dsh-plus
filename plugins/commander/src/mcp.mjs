import { createInterface } from 'node:readline';
import { delegationSchema } from './delegation.mjs';
// Spawned only by the native engine. Capabilities arrive through its private environment.
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  void (async () => {
    let m;
    try {
      m = JSON.parse(line); if (m.id === undefined) return;
      let result;
      if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'DSH-Plus', version: '0.2.0' } };
      else if (m.method === 'ping') result = {};
      else if (m.method === 'tools/list') result = { tools: [{ name: 'commander_delegate', description: 'Delegate to another coding engine in this same project. Provide provider and text, optionally model. Human approval required. Returns child result; if pending, call again with operation=result and sessionId to read it. Do not resubmit.', inputSchema: delegationSchema }] };
      else if (m.method === 'tools/call' && m.params.name === 'commander_delegate') {
        const r = await fetch(process.env.COMMANDER_DELEGATE_URL, { method: 'POST', headers: { authorization: `Bearer ${process.env.COMMANDER_DELEGATE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(m.params.arguments), signal: AbortSignal.timeout(240000) });
        const value = await r.json(); result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: !r.ok };
      } else throw new Error('Unsupported MCP method');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    } catch (error) { if (m?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: error.message } }) + '\n'); }
  })();
}
