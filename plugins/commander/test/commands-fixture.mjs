#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';

if (process.argv.includes('serve')) {
  let stream;
  const event = value => stream.write(`data: ${JSON.stringify(value)}\n\n`);
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`) return res.writeHead(401).end();
    const path = new URL(req.url, 'http://localhost').pathname;
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
    if (path === '/global/health') return json({ healthy: true, version: '1.14.42' });
    if (path === '/session') return json({ id: 'commands-opencode' });
    if (path === '/event') { stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.write(': ready\n\n'); }
    if (path === '/command') return json([{ name: 'review', description: 'Review changes' }]);
    if (path.endsWith('/command') || path.endsWith('/summarize')) {
      const correct = path.endsWith('/summarize') ? body.providerID === 'test' && body.modelID === 'model' : body.command === 'review' && body.arguments === 'changed files';
      if (!correct) return res.writeHead(400).end('incorrect native command payload');
      json(null);
      event({ type: 'message.part.delta', properties: { sessionID: 'commands-opencode', field: 'text', delta: path.endsWith('/summarize') ? 'compacted' : 'reviewed' } });
      event({ type: 'session.idle', properties: { sessionID: 'commands-opencode' } });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
} else {
  const pi = process.argv.includes('--mode');
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    const method = pi ? message.type : message.method;
    const reply = result => send(pi ? { id: message.id, type: 'response', success: true, data: result } : { id: message.id, result });
    const fail = error => send(pi ? { id: message.id, type: 'response', success: false, error } : { id: message.id, error: { message: error } });
    if (method === 'initialize') return reply({});
    if (method === 'initialized') return;
    if (method === 'thread/start') return reply({ thread: { id: 'commands-codex' } });
    if (method === 'skills/list') return reply({ data: [{ skills: [{ name: 'review', path: '/fixture/SKILL.md', enabled: true }, { name: 'disabled', path: '/disabled', enabled: false }] }] });
    if (method === 'thread/compact/start') { reply({}); return send({ method: 'thread/compacted', params: { threadId: 'commands-codex' } }); }
    if (method === 'turn/start') {
      if (message.params.input[0].type !== 'skill' || message.params.input[0].path !== '/fixture/SKILL.md' || message.params.input[1].text !== '$review changed files') return fail('not a native skill input');
      reply({ turn: { id: 'skill-turn' } });
      return send({ method: 'turn/completed', params: { threadId: 'commands-codex', turn: { status: 'completed' } } });
    }
    if (method === 'get_state') return reply({ sessionFile: '/fixture/pi-session.jsonl', isStreaming: false });
    if (method === 'get_commands') return reply({ commands: [{ name: 'review' }] });
    if (method === 'compact') {
      if (message.customInstructions !== 'keep decisions') return fail('missing compaction instructions');
      return reply({ summary: 'compacted' });
    }
    if (method === 'prompt') {
      if (message.message.includes('contradiction')) {
        send({ type: 'agent_start' });
        reply({ agentInvoked: false });
        return setTimeout(() => send({ type: 'agent_end' }), 50);
      }
      send({ type: 'command_output', text: 'native-command-output' });
      return reply(message.message.includes('legacy') ? {} : { agentInvoked: false });
    }
    fail(`Unexpected fixture method: ${method}`);
  });
}
