import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { commandCatalog, compactCommand } from '../commands.mjs';

// OpenCode v1 HTTP/SSE adapter. v2 has a different contract and is deliberately
// rejected rather than guessed from a successful TCP connection.
export class OpenCodeProvider {
  static capabilities = { stream: true, resume: true, steer: false, approvals: true, discover: true };
  constructor(config = {}) { this.config = config; }

  async connect(session, host) {
    const password = randomBytes(24).toString('hex');
    const inline = this.config.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
    const existing = inline ? JSON.parse(inline) : {};
    const child = spawn(this.config.command ?? 'opencode', [...(this.config.commandArgs ?? []), 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: session.cwd, env: { ...process.env, ...this.config.env, OPENCODE_SERVER_PASSWORD: password,
        ...(host.delegation ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...existing, mcp: { ...existing.mcp, commander: { type: 'local', command: [host.delegation.command, host.delegation.script], environment: { COMMANDER_DELEGATE_URL: host.delegation.url, COMMANDER_DELEGATE_TOKEN: host.delegation.token }, enabled: true } } }) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    const controller = new AbortController();
    let closing = false;
    let tail = '';
    let base;
    let pump;
    let rejectReady;
    const exited = new Promise(resolve => child.once('close', resolve));
    const stop = async () => {
      closing = true; controller.abort();
      const kill = signal => {
        try { if (child.pid) process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      kill('SIGTERM');
      const timer = setTimeout(() => kill('SIGKILL'), 1500);
      try { await exited; await pump; } finally { clearTimeout(timer); }
    };
    child.on('error', error => { rejectReady?.(error); if (!closing) host.failure(error); });
    child.on('close', () => { const error = new Error(`OpenCode server exited: ${tail.slice(-1000)}`); rejectReady?.(error); if (!closing) host.failure(error); });
    try {
      base = await new Promise((resolve, reject) => {
        rejectReady = reject;
        const timer = setTimeout(() => reject(new Error('OpenCode startup timed out')), 20_000);
        const data = chunk => {
          tail = (tail + chunk.toString()).slice(-8192);
          const url = tail.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/)?.[0];
          if (url) { clearTimeout(timer); resolve(url); }
        };
        child.stdout.on('data', data); child.stderr.on('data', data);
        exited.then(() => clearTimeout(timer));
      });
      const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' };
      const request = async (path, method = 'GET', body, timeout = 30_000) => {
        const url = new URL(path, base); url.searchParams.set('directory', session.cwd);
        const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) });
        if (!response.ok) throw new Error(`OpenCode ${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
        const text = await response.text(); return text ? JSON.parse(text) : null;
      };
      const health = await request('/global/health');
      if (!health?.healthy || !/^1\./.test(health.version ?? '')) throw new Error(`Unsupported OpenCode protocol/version: ${health?.version ?? 'unknown'}; v1 required`);
      const info = session.nativeId
        ? await request(`/session/${encodeURIComponent(session.nativeId)}`)
        : await request('/session', 'POST', { permission: [{ permission: '*', pattern: '*', action: 'ask' }] });
      if (!info?.id || (session.nativeId && info.id !== session.nativeId)) throw new Error('OpenCode returned an invalid native session');
      const id = encodeURIComponent(info.id);
      // Open and attach SSE before accepting prompts; no startup race dropping
      // the first delta/permission request.
      const streamURL = new URL('/event', base); streamURL.searchParams.set('directory', session.cwd);
      const response = await fetch(streamURL, { headers, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error('OpenCode event subscription failed');
      const handle = async event => {
        const p = event.properties ?? {};
        const sessionId = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID;
        if (sessionId !== info.id) return;
        if (event.type === 'message.part.delta' && p.field === 'text') host.event('text.delta', { text: p.delta, itemId: p.partID });
        else if (event.type === 'message.part.updated') {
          host.event('item', { part: p.part, delta: p.delta ?? null });
          if (p.part?.type === 'step-finish' && p.part.tokens) host.event('usage', { id: p.part.id, usage: p.part.tokens });
        }
        else if (event.type === 'session.idle') host.event('turn.completed', { status: 'completed' });
        else if (event.type === 'session.error') host.event('turn.completed', { status: 'failed', error: p.error });
        else if (event.type === 'permission.asked') {
          const answer = await host.approval({ kind: 'permission', method: p.permission, nativeRequestId: p.id, details: p });
          await request(`/permission/${encodeURIComponent(p.id)}/reply`, 'POST', { reply: answer.allow ? 'once' : 'reject' });
        } else if (event.type === 'question.asked') {
          const answer = await host.approval({ kind: 'question', method: event.type, nativeRequestId: p.id, details: p });
          if (answer.answers) await request(`/question/${encodeURIComponent(p.id)}/reply`, 'POST', { answers: answer.answers });
          else await request(`/question/${encodeURIComponent(p.id)}/reject`, 'POST', {});
        }
      };
      pump = (async () => {
        const decoder = new TextDecoder(); let buffer = '';
        try {
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');
            if (buffer.length > 16 * 1024 * 1024) throw new Error('OpenCode SSE frame too large');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (data) void handle(JSON.parse(data)).catch(error => host.failure(error));
            }
          }
          if (!closing) host.failure(new Error('OpenCode event stream disconnected; reconnect the session before continuing'));
        } catch (error) { if (!closing) host.failure(error); }
      })();
      return {
        nativeId: info.id,
        async setModel(model) { session.model = model || undefined; },
        async commands() { return commandCatalog(await request('/command'), [compactCommand, { ...compactCommand, name: 'summarize' }]); },
        validateCommand({ name, arguments: args }) {
          if (name !== 'compact' && name !== 'summarize') return;
          if (args) throw new Error('OpenCode compact does not accept arguments');
          if (!session.model?.includes('/')) throw new Error('Select an explicit provider/model before OpenCode compact');
        },
        async command({ name, arguments: args }) {
          const model = session.model?.split('/');
          if (name === 'compact' || name === 'summarize') {
            if (args) throw new Error('OpenCode compact does not accept arguments');
            if (!model || model.length < 2) throw new Error('Select an explicit provider/model before OpenCode compact');
            await request(`/session/${id}/summarize`, 'POST', { providerID: model[0], modelID: model.slice(1).join('/') }, 30 * 60_000);
          } else await request(`/session/${id}/command`, 'POST', { command: name, arguments: args, ...(session.model ? { model: session.model } : {}) }, 30 * 60_000);
        },
        async submit(text) {
          const model = session.model?.split('/');
          if (model && model.length < 2) throw new Error('OpenCode model must be provider/model');
          await request(`/session/${id}/prompt_async`, 'POST', { parts: [{ type: 'text', text }], ...(model ? { model: { providerID: model[0], modelID: model.slice(1).join('/') } } : {}) });
        },
        async interrupt() { await request(`/session/${id}/abort`, 'POST', {}); },
        async history() { return request(`/session/${id}/message`); },
        async discover() { return request('/session'); },
        close: stop,
      };
    } catch (error) { await stop(); throw error; }
  }
}
