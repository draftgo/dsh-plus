import test from 'node:test';
import assert from 'node:assert/strict';
import { startSidebarPolling } from '../client/sidebar-refresh.mjs';
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
function fixture(refresh) {
  const listeners = new Map(), jobs = new Map(), errors = []; let sequence = 0, active = false;
  const page = { hidden: false, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const stop = startSidebarPolling({ refresh, onError: error => errors.push(error), isActive: () => active, document: page, schedule: (fn, ms) => { const id = ++sequence; jobs.set(id, { fn, ms }); return id; }, unschedule: id => jobs.delete(id) });
  return { page, listeners, jobs, errors, stop, active: value => { active = value; }, visibility(hidden) { page.hidden = hidden; listeners.get('visibilitychange')?.(); }, tick() { const [id, job] = jobs.entries().next().value; jobs.delete(id); void job.fn(); } };
}
test('sidebar polls slowly when idle, quickly when running, and suspends hidden tabs', async () => {
  let reads = 0; const f = fixture(async () => { reads++; }); await flush();
  assert.equal(reads, 1); assert.equal([...f.jobs.values()][0].ms, 10000);
  f.active(true); f.tick(); await flush(); assert.equal([...f.jobs.values()][0].ms, 2000);
  f.visibility(true); assert.equal(f.jobs.size, 0); assert.equal(reads, 2);
  f.visibility(false); await flush(); assert.equal(reads, 3); assert.equal(f.jobs.size, 1);
  f.stop(); assert.equal(f.jobs.size, 0); assert.equal(f.listeners.size, 0);
});
test('visibility changes never overlap requests and disposed failures do not notify', async () => {
  let reject, signal, reads = 0; const f = fixture(s => { reads++; signal = s; return new Promise((_, no) => { reject = no; }); });
  f.visibility(true); f.visibility(false); f.visibility(false); assert.equal(reads, 1);
  f.stop(); assert.equal(signal.aborted, true); reject(Error('aborted')); await flush();
  assert.equal(f.jobs.size, 0); assert.deepEqual(f.errors, []);
});
test('a failed visible request retries instead of stopping the sidebar', async () => {
  let reads = 0; const f = fixture(async () => { if (++reads === 1) throw Error('offline'); }); await flush();
  assert.equal(f.errors.length, 1); assert.equal(f.jobs.size, 1); f.tick(); await flush(); assert.equal(reads, 2); f.stop();
});
