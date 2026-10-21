import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../client/controller.mjs';

globalThis.document ||= { baseURI: 'https://voice.example/' };

for (const protocol of ['transcriptions', 'transcriptions-sse', 'step-websocket', 'openai-websocket']) {
  for (const mode of ['dictation', 'call']) {
    test(`${mode} ${protocol} preserves the browser fetch receiver`, async t => {
      const calls = [], captures = [], queues = [];
      const config = { dictation: true, call: true, readAloud: true, asr: { configured: true, protocol }, tts: { configured: true } };

      const encode = event => new TextEncoder().encode(JSON.stringify(event) + '\n');
      t.mock.method(globalThis, 'fetch', function (url, options) {
        // Window.fetch accepts a bare call, but rejects a foreign receiver.
        if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
        const path = new URL(url).pathname, body = options.headers['content-type'] === 'application/json' ? JSON.parse(options.body) : null;
        calls.push(body?.action || path);
        const json = data => Response.json(data);
        if (path === '/api/voice/transcribe') return Promise.resolve(protocol.endsWith('-sse')
          ? new Response(encode({ type: 'final', text: '测试转录' }), { headers: { 'content-type': 'application/x-ndjson' } })
          : json({ text: '测试转录' }));
        if (path === '/api/voice/speech') {
          assert.equal(options.headers['x-voice-call-id'], mode === 'call' ? 'lease' : undefined);
          return Promise.resolve(new Response(new Uint8Array([0, 0])));
        }
        if (body.action === 'config') return Promise.resolve(json({ config }));
        if (body.action === 'call.start') return Promise.resolve(json({ call: { callId: 'lease' } }));
        if (body.action === 'asr.start') return Promise.resolve(json({ id: 'asr-session', ticket: 'one-use-ticket' }));
        return Promise.resolve(json({}));
      });
      const ctx = {
        connection: { openWebSocket(path) {
          assert.equal(path, '/api/voice/realtime');
          const ws = new EventTarget(); ws.readyState = 1; ws.bufferedAmount = 0;
          const event = data => queueMicrotask(() => ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })));
          ws.send = raw => {
            if (typeof raw !== 'string') { const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength); assert.deepEqual([...new Int16Array(raw.buffer.slice(raw.byteOffset + 12, raw.byteOffset + raw.byteLength))], [1, -1]); event({ type: 'ack', epoch: view.getUint32(0, true), sequence: view.getUint32(8, true), accepted: true }); return; }
            const input = JSON.parse(raw); calls.push(input.type);
            if (input.type === 'attach') { assert.equal(input.ticket, 'one-use-ticket'); assert.equal(input.callId, mode === 'call' ? 'lease' : ''); event({ type: 'ready', epoch: 0 }); }
            if (input.type === 'commit') event({ type: 'final', epoch: input.epoch, utteranceId: input.utteranceId, text: '测试转录' });
            if (input.type === 'clear') event({ type: 'ready', epoch: input.epoch });
          };
          ws.close = () => { ws.readyState = 3; }; queueMicrotask(() => ws.dispatchEvent(new Event('open'))); return ws;
        } },
        uiSession: { sessionStatus: { getSnapshot: () => new Map(), subscribe: () => () => {} } },
        sessions: { binding: sessionId => ({ sessionId, eventSource: { getSnapshot: () => ({ revision: 0, entries: [] }), subscribe: () => () => {} } }) },
      };
      const api = createVoiceController(ctx, {
        window: { addEventListener() {}, removeEventListener() {} },
        createCapture: options => { captures.push(options); return { start: async () => {}, dispose: async () => options.realtime?.close() }; },
        createPlayer: () => ({ start: async () => {}, dispose: async () => {} }),
        createQueue: options => { queues.push(options); return { items: [], cancel() {}, dispose: async () => {} }; },
      });
      t.after(() => api.dispose());
      const args = { sessionId: 's', inputActions: { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }) } };
      if (mode === 'call') { await api.toggleRead('s'); await api.startCall(args); }
      else await api.startDictation(args);
      const capture = captures[0];
      if (capture.realtime) {
        await capture.realtime.append([new Int16Array([1, -1])], 1, () => {});
        assert.equal(await capture.realtime.commit(1), '测试转录');
        await capture.realtime.clear();
      } else {
        const result = await capture.transcribe(new Blob(['wav']), new AbortController().signal);
        assert.equal(result.text, '测试转录');
      }
      if (mode === 'dictation') { await api.hangup(); await api.toggleRead('s'); }
      await queues[0].synthesize('测试朗读', new AbortController().signal);
      await api.hangup();
      assert.equal(api.state.getSnapshot().error, '');
      assert.ok(calls.includes('/api/voice/speech'));
      if (capture.realtime) for (const action of ['asr.start', 'attach', 'commit', 'clear', 'asr.end']) assert.ok(calls.includes(action));
    });
  }
}
