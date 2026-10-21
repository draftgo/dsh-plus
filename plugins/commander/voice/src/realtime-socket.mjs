import { randomBytes } from 'node:crypto';
import { VoiceError } from './config.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const reason = error => error instanceof VoiceError ? error.message : 'Realtime voice transport failed';
/** Carrier auth admits the owner/device; a one-use ticket binds its ASR lease. */
export function createRealtimeSockets(realtime) {
  const tickets = new Map(), sockets = new Set();
  let disposed = false;
  const issue = (id, callId) => {
    for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { id, callId, expires: Date.now() + 10000 });
    return ticket;
  };
  const accept = ws => {
    if (disposed) { ws.terminate(); return; }
    sockets.add(ws);
    let session, reader, epoch = 0, resetting = false, ended = false;
    const send = value => {
      if (ended || ws.readyState !== 1) return;
      if (ws.bufferedAmount > 65536) { ws.terminate(); return; }
      ws.send(JSON.stringify(value));
    };
    const stop = () => {
      if (ended) return; ended = true; clearTimeout(attachTimer); sockets.delete(ws);
      void reader?.cancel().catch(() => {});
      if (session) realtime.close(session.id);
    };
    const fail = error => { send({ type: 'error', error: reason(error) }); ws.close(1008, 'Voice transport rejected'); stop(); };
    const attachTimer = setTimeout(() => { ws.terminate(); stop(); }, 10000); attachTimer.unref?.();
    ws.on('error', stop); ws.on('close', stop);
    ws.on('message', (raw, binary) => {
      try {
        if (ended) return;
        if (binary) {
          if (!session || raw.length < 14 || raw.length > 972 || raw.length % 2) throw new VoiceError('Invalid PCM voice frame');
          const generation = raw.readUInt32LE(0), utteranceId = raw.readUInt32LE(4), sequence = raw.readUInt32LE(8);
          if (generation !== epoch || resetting) return;
          const accepted = realtime.append(session.id, session.callId, raw.subarray(12), utteranceId);
          send({ type: 'ack', epoch, sequence, accepted: accepted !== false });
          return;
        }
        if (raw.length > 2048) throw new VoiceError('Voice control message too large');
        const input = JSON.parse(String(raw));
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new VoiceError('Invalid voice control');
        if (!session) {
          if (input.type !== 'attach' || typeof input.ticket !== 'string') throw new VoiceError('Attach the voice session first');
          const ticket = tickets.get(input.ticket); tickets.delete(input.ticket);
          if (!ticket || ticket.expires < Date.now() || ticket.id !== input.id || ticket.callId !== (input.callId || '')) throw new VoiceError('Voice connection ticket expired', 401);
          session = realtime.get(ticket.id, ticket.callId);
          const emit = session.emit; session.emit = event => emit({ ...event, epoch });
          reader = realtime.events(session.id, session.callId).getReader(); clearTimeout(attachTimer);
          const previous = session.onClose;
          session.onClose = () => { previous?.(); if (!ended) { send({ type: 'closed' }); ws.close(1000); stop(); } };
          send({ type: 'ready', epoch });
          void (async () => {
            try {
              while (!ended) {
                const { value, done } = await reader.read(); if (done) break;
                const event = JSON.parse(new TextDecoder().decode(value));
                if (!resetting && event.epoch === epoch) send(event);
              }
            } catch (error) { if (!ended) fail(error); }
          })();
          return;
        }
        if (!integer(input.epoch)) throw new VoiceError('Invalid voice generation');
        if (input.type === 'clear') {
          if (input.epoch <= epoch) return;
          if (resetting) throw new VoiceError('Voice reset already pending');
          epoch = input.epoch; resetting = true;
          void realtime.reset(session.id, session.callId).then(() => { resetting = false; send({ type: 'ready', epoch }); }, error => { if (!ended) fail(error); });
          return;
        }
        if (input.epoch !== epoch) return;
        if (resetting) throw new VoiceError('Voice reset is not ready');
        if (input.type !== 'commit' || !integer(input.utteranceId) || !input.utteranceId) throw new VoiceError('Invalid voice control');
        if (!session.bytes) { send({ type: 'final', epoch, utteranceId: input.utteranceId, text: '' }); return; }
        realtime.commit(session.id, session.callId, input.utteranceId);
      } catch (error) { fail(error); }
    });
  };
  const clear = () => { tickets.clear(); for (const ws of sockets) ws.terminate(); sockets.clear(); };
  return { issue, accept, clear, dispose() { disposed = true; clear(); } };
}
