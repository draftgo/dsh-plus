#!/usr/bin/env node
import { createServer } from 'node:http';
const streams = new Set();
const publish = event => { for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`); };
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`) { response.writeHead(401).end(); return; }
  const path = new URL(request.url, 'http://localhost').pathname;
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
  if (path === '/global/health') return json({ healthy: true, version: process.env.FIXTURE_VERSION ?? '1.14.42' });
  if (path === '/event') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': ready\n\n');
    streams.add(response); request.on('close', () => streams.delete(response)); return;
  }
  if (path === '/session' || path === '/session/native-opencode') return json({ id: 'native-opencode' });
  if (path === '/session/native-opencode/message') return json([{ role: 'assistant', text: 'opencode' }]);
  if (path === '/session/native-opencode/prompt_async') {
    json(null);
    if (body.parts[0].text === 'approval') publish({ type: 'permission.asked', properties: { sessionID: 'native-opencode', id: 'p1', permission: 'bash', patterns: ['echo hi'] } });
    else {
      publish({ type: 'message.part.delta', properties: { sessionID: 'native-opencode', field: 'text', delta: 'fixture-opencode' } });
      publish({ type: 'session.idle', properties: { sessionID: 'native-opencode' } });
    }
    return;
  }
  if (path === '/permission/p1/reply') {
    json(null); publish({ type: 'message.part.delta', properties: { sessionID: 'native-opencode', field: 'text', delta: body.reply } });
    publish({ type: 'session.idle', properties: { sessionID: 'native-opencode' } }); return;
  }
  response.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => { console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`); });
