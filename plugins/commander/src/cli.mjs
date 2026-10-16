#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Commander } from './runtime.mjs';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, config: { type: 'string' }, stdio: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Commander [--data-dir PATH] [--config JSON_FILE] [--stdio]\nInteractive native session control. --stdio is a trusted local JSONL API, not a network server.');
  process.exit(0);
}
const config = values.config ? JSON.parse(await readFile(values.config, 'utf8')) : {};
if (values['data-dir']) config.dataDir = values['data-dir'];
const commander = await new Commander(config).open();
const json = value => process.stdout.write(JSON.stringify(value) + '\n');
let selected;
let closing = false;
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !values.stdio && process.stdin.isTTY });
const stop = async () => {
  if (closing) return; closing = true; rl.close();
  try { await commander.close(); } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
commander.on('fault', error => { process.stderr.write(`Commander persistence error: ${error.message}\n`); void stop(); });
commander.on('event', event => {
  if (values.stdio) json({ event });
  else if (event.sessionId === selected) {
    if (event.type === 'text.delta') process.stdout.write(event.data.text);
    else if (event.type === 'approval.requested') console.log(`\n[${event.data.kind}] ${event.data.id}\n${JSON.stringify(event.data.details, null, 2)}\n/approve ID yes|no 或 /answer ID JSON`);
    else if (['turn.completed', 'session.error', 'input.uncertain', 'provider.retry'].includes(event.type)) console.log(`\n[${event.type}] ${JSON.stringify(event.data)}`);
  }
});

async function dispatch(method, params) {
  switch (method) {
    case 'providers': return commander.catalog();
    case 'doctor': return commander.doctor();
    case 'list': return commander.list();
    case 'create': return commander.create(params);
    case 'connect': return commander.connect(params.id);
    case 'send': return commander.submit(params.id, params.text, { requestId: params.requestId });
    case 'steer': await commander.steer(params.id, params.text); return commander.snapshot(params.id);
    case 'interrupt': await commander.interrupt(params.id); return commander.snapshot(params.id);
    case 'approve': commander.approve(params.id, params.approvalId, params.answer); return commander.snapshot(params.id);
    case 'events': return commander.events(params.id, params.after);
    case 'history': return commander.history(params.id);
    case 'discover': return commander.discover(params.id);
    case 'wait': return commander.wait(params.id, { timeout: params.timeout });
    case 'close': return commander.disconnect(params.id);
    case 'archive': return commander.archive(params.id, params.archived);
    default: throw new Error(`Unknown method: ${method}`);
  }
}

if (!values.stdio) console.log('Commander · 指挥官\n/new codex|claude|pi|opencode|gemini|hermes|grok|mcode [cwd]  /list  /use ID  /resume ID\n/steer TEXT  /stop  /approve ID yes|no  /answer ID JSON\n/events [cursor]  /history  /discover  /close  /archive  /quit\n输入普通文字向当前会话发送任务。原生会话导入使用 --stdio create 的 nativeId。');

// Requests can overlap in JSONL mode so an approval can be answered while a
// wait request is pending. Commander owns session mutation serialization.
const inFlight = new Set();
rl.on('line', line => {
  const task = (async () => {
    let request;
    try {
      if (values.stdio) {
        request = JSON.parse(line);
        const result = await dispatch(request.method, request.params ?? {});
        json({ id: request.id ?? null, result });
      } else {
        if (!line.trim()) return;
        const [command, ...rest] = line.trim().split(/\s+/); const text = rest.join(' ');
        if (command === '/quit') { void stop(); return; }
        let result;
        if (command === '/new') { result = await commander.create({ provider: rest[0], cwd: rest.slice(1).join(' ') || process.cwd() }); selected = result.id; }
        else if (command === '/list') result = commander.list();
        else if (command === '/doctor') result = await commander.doctor();
        else if (command === '/use') { commander.get(text); selected = text; result = commander.snapshot(selected); }
        else if (command === '/resume') { selected = text; result = await commander.connect(selected); }
        else {
          if (!selected) throw new Error('先使用 /new 或 /use 选择会话');
          if (command === '/stop') result = await dispatch('interrupt', { id: selected });
          else if (command === '/steer') result = await dispatch('steer', { id: selected, text });
          else if (command === '/events') result = commander.events(selected, Number(text || 0));
          else if (command === '/history') result = await commander.history(selected);
          else if (command === '/discover') result = await commander.discover(selected);
          else if (command === '/close') result = await commander.disconnect(selected);
          else if (command === '/archive') result = await commander.archive(selected);
          else if (command === '/approve') result = await dispatch('approve', { id: selected, approvalId: rest[0], answer: { allow: rest[1] === 'yes' } });
          else if (command === '/answer') result = await dispatch('approve', { id: selected, approvalId: rest[0], answer: JSON.parse(rest.slice(1).join(' ')) });
          else if (command.startsWith('/')) throw new Error('未知命令');
          else result = await commander.submit(selected, line);
        }
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      if (values.stdio) json({ id: request?.id ?? null, error: { message: error.message } });
      else console.error(error.message);
    }
  })();
  inFlight.add(task); task.finally(() => inFlight.delete(task));
});
rl.on('close', () => { void stop(); });
