import { randomUUID } from 'node:crypto';
import { VoiceError } from './config.mjs';

const TTL = 45000, MAX_DURATION = 30 * 60000;
const identity = (value, name) => { if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f]/u.test(value)) throw new VoiceError(`Invalid ${name}`); return value; };
/** Process-local ownership only. Media cancellation never grants/revokes Agent permissions. */
export class CallLeases {
  constructor({ now = Date.now } = {}) { this.now = now; this.sessions = new Map(); }
  public(lease) { const { timer, controller, ...value } = lease; return value; }
  remove(lease) { clearTimeout(lease.timer); lease.controller.abort(); this.sessions.delete(lease.sessionId); }
  schedule(lease) {
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => this.remove(lease), Math.max(0, Math.min(lease.expiresAt, lease.maxEndsAt) - this.now()));
    lease.timer.unref?.();
  }
  purge() { for (const lease of this.sessions.values()) if (Math.min(lease.expiresAt, lease.maxEndsAt) <= this.now()) this.remove(lease); }
  start(input) {
    this.purge(); const sessionId = identity(input.sessionId, 'sessionId'), deviceId = identity(input.deviceId, 'deviceId');
    const existing = this.sessions.get(sessionId);
    if (existing) { if (existing.deviceId !== deviceId) throw new VoiceError('This conversation already has an active call on another device', 409); return this.public(existing); }
    if (this.sessions.size >= 16) throw new VoiceError('Active call limit reached', 429);
    const startedAt = this.now();
    const lease = { callId: randomUUID(), sessionId, deviceId, startedAt, expiresAt: startedAt + TTL, maxEndsAt: startedAt + MAX_DURATION, controller: new AbortController() };
    this.sessions.set(sessionId, lease); this.schedule(lease); return this.public(lease);
  }
  owned(input) {
    this.purge();
    const sessionId = identity(input.sessionId, 'sessionId'), deviceId = identity(input.deviceId, 'deviceId'), callId = identity(input.callId, 'callId');
    const lease = this.sessions.get(sessionId);
    if (!lease || lease.deviceId !== deviceId || lease.callId !== callId) throw new VoiceError('Voice call expired or belongs to another device', 409);
    return lease;
  }
  heartbeat(input) { const lease = this.owned(input); lease.expiresAt = Math.min(this.now() + TTL, lease.maxEndsAt); this.schedule(lease); return this.public(lease); }
  end(input) { const lease = this.owned(input); this.remove(lease); return { ended: true }; }
  media(callId) { this.purge(); const lease = [...this.sessions.values()].find(value => value.callId === callId); if (!lease) throw new VoiceError('Voice call has expired', 409); return lease.controller.signal; }
  clear() { for (const lease of this.sessions.values()) this.remove(lease); }
}
