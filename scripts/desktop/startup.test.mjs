import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const renderer = await readFile(new URL('./renderer/dsh-plus-startup.js', import.meta.url), 'utf8');
function startup(skip) {
  const handlers = new Map();
  const status = { textContent: '' };
  const retry = { hidden: true, disabled: false, addEventListener: (name, fn) => handlers.set(name, fn) };
  const timers = [];
  vm.runInNewContext(renderer, {
    document: { getElementById: id => id === 'startup-status' ? status : retry },
    window: { dshWelcome: { skip }, addEventListener: (name, fn) => handlers.set(name, fn) },
    setTimeout: fn => timers.push(fn),
  });
  return { status, retry, handlers, timers };
}

test('desktop enters through the official skip operation after the native load, only once', async () => {
  let calls = 0;
  let resolve;
  const page = startup(() => { calls++; return new Promise(done => { resolve = done; }); });
  assert.equal(calls, 0);
  page.handlers.get('load')();
  assert.equal(calls, 0);
  const entering = page.timers[0]();
  assert.equal(calls, 1);
  await page.handlers.get('click')();
  assert.equal(calls, 1);
  resolve();
  await entering;
  await page.handlers.get('click')();
  assert.equal(calls, 1);
  assert.equal(page.retry.hidden, true);
});

test('a failed desktop navigation stays recoverable and retries only on request', async () => {
  let calls = 0;
  const page = startup(async () => { if (++calls === 1) throw new Error('navigation failed'); });
  page.handlers.get('load')();
  await page.timers[0]();
  assert.equal(calls, 1);
  assert.equal(page.retry.hidden, false);
  assert.equal(page.retry.disabled, false);
  assert.match(page.status.textContent, /请重试/);
  await page.handlers.get('click')();
  assert.equal(calls, 2);
  assert.equal(page.retry.hidden, true);
});
