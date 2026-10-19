import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const delegationSchema = { type: 'object', properties: {
  provider: { type: 'string', enum: ['codex', 'claude', 'pi', 'opencode', 'gemini', 'hermes', 'grok', 'mcode'] },
  model: { type: 'string' }, text: { type: 'string' },
  operation: { type: 'string', enum: ['delegate', 'result'] }, sessionId: { type: 'string' },
}, required: [], additionalProperties: false };

/** Per-process, per-session capability endpoint for native MCP/extension tools. No public listener. */
export class DelegationBridge {
  constructor(commander, { serverFactory = createServer } = {}) { this.commander = commander; this.tokens = new Map(); this.serverFactory = serverFactory; }
  async open() {
    this.server = this.serverFactory(async (req, res) => {
      const id = this.tokens.get(req.headers.authorization?.replace(/^Bearer /, ''));
      res.setHeader('Content-Type', 'application/json');
      if (!id || req.method !== 'POST' || req.url !== '/delegate') { res.writeHead(403); res.end('{}'); return; }
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('Delegation request too large'); }
        res.end(JSON.stringify(await this.commander.delegate(id, JSON.parse(body))));
      } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { this.server.removeListener('listening', ready); this.server.removeListener('error', failed); reject(error); };
        const ready = () => { this.server.removeListener('error', failed); resolve(); };
        this.server.once('error', failed);
        this.server.once('listening', ready);
        try { this.server.listen(0, '127.0.0.1'); } catch (error) { failed(error); }
      });
    } catch (error) { await this.close(); throw error; }
    this.url = `http://127.0.0.1:${this.server.address().port}/delegate`;
    return this;
  }
  forSession(id) {
    const token = randomBytes(32).toString('hex'); this.tokens.set(token, id);
    return { url: this.url, token, command: process.execPath, script: fileURLToPath(new URL('./mcp.mjs', import.meta.url)), schema: delegationSchema };
  }
  revoke(id) { for (const [token, owner] of this.tokens) if (owner === id) this.tokens.delete(token); }
  async close() {
    this.tokens.clear();
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }
}
