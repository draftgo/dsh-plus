import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { readJsonResponse } from '../client/http-response.mjs';

const url = new URL('https://desktop.example/link/api/commander?token=secret#private');
const context = /HTTP \d+ · \/link\/api\/commander/;
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('JSON responses preserve model IDs, arrays and successful application error payloads', async () => {
  const values = [{ projects: [], model: 'opaque:model/with:separators' }, ['one'], { error: 'partial report' }];
  for (const value of values) assert.deepEqual(await readJsonResponse(response(value), url), value);
});

test('plaintext 404 reports the real status and pathname without exposing the response or URL secrets', async () => {
  await assert.rejects(readJsonResponse(new Response('not found private response', { status: 404 }), url), failure => {
    assert.equal(failure.message, '请求失败（HTTP 404 · /link/api/commander）');
    assert.equal(failure.code, 'HTTP_ERROR');
    assert.equal(failure.status, 404);
    assert.equal(failure.pathname, '/link/api/commander');
    assert(failure.cause instanceof SyntaxError);
    assert.doesNotMatch(failure.message, /secret|private|not found|Unexpected/);
    return true;
  });
});

test('HTTP JSON errors retain server detail and support the nested error message contract', async () => {
  for (const error of ['服务暂不可用', { message: '服务暂不可用' }]) {
    await assert.rejects(readJsonResponse(response({ error }, 503), url), failure => {
      assert.equal(failure.message, '请求失败：服务暂不可用（HTTP 503 · /link/api/commander）');
      return true;
    });
  }
  await assert.rejects(readJsonResponse(response({ error: { code: 'unknown' } }, 403), url), /请求失败（HTTP 403/);
});

test('HTML, malformed JSON and empty successful responses are protocol errors with status and path', async () => {
  for (const body of ['<!doctype html><h1>login</h1>', '{"projects":', '']) {
    await assert.rejects(readJsonResponse(new Response(body), url), failure => {
      assert.equal(failure.code, 'INVALID_JSON_RESPONSE');
      assert.equal(failure.message, '接口返回格式异常（HTTP 200 · /link/api/commander）');
      assert.match(failure.message, context);
      return true;
    });
  }
});

test('JSON null and scalar successful payloads cannot masquerade as empty API data', async () => {
  for (const value of [null, 'not found', false, 5]) {
    await assert.rejects(readJsonResponse(response(value), url), { code: 'INVALID_JSON_RESPONSE' });
  }
});

test('body cancellation and stream failures propagate unchanged', async () => {
  for (const error of [new DOMException('aborted', 'AbortError'), new Error('connection closed')]) {
    const stream = new ReadableStream({ start(controller) { controller.error(error); } });
    await assert.rejects(readJsonResponse(new Response(stream), url), failure => failure === error);
  }
});

test('sidebar preserves POST fields and cancellation signal and never retries failed writes', async () => {
  const source = readFileSync(new URL('../client/index.jsx', import.meta.url), 'utf8');
  const code = transformSync(source + '\nexport { api };', { loader: 'jsx', format: 'cjs' }).code;
  const calls = [], module = { exports: {} };
  let next = () => new Response('not found', { status: 404 });
  runInNewContext(code, { module, exports: module.exports, URL, document: { baseURI: 'https://desktop.example/link/' }, localStorage: { getItem: () => null }, require: id => id === './http-response.mjs' ? { readJsonResponse } : {}, fetch: async (target, options) => { calls.push({ target, options }); return next(); } });
  const controller = new AbortController();
  await assert.rejects(module.exports.api('create', { projectId: 'existing' }, controller.signal), /请求失败（HTTP 404 · \/link\/api\/commander）/);
  assert.equal(calls.length, 1);
  const { target, options } = calls[0];
  assert.equal(String(target), 'https://desktop.example/link/api/commander');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), { action: 'create', projectId: 'existing' });
  assert.equal(options.signal, controller.signal);
  next = () => response({ projects: [], sessions: [] });
  assert.deepEqual(await module.exports.api('state'), { projects: [], sessions: [] });
  const offline = new TypeError('Failed to fetch');
  next = () => { throw offline; };
  await assert.rejects(module.exports.api('create'), error => error === offline);
  assert.equal(calls.length, 3);
});
