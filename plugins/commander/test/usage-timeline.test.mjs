import test from 'node:test';
import assert from 'node:assert/strict';
import { usageTimeline } from '../src/usage-timeline.mjs';
import { UsageLedger } from '../src/usage.mjs';

test('timeline includes all deduplicated records independently of history pagination', () => {
  const ledger = new UsageLedger('/unused');
  for (let i = 0; i < 123; i++) ledger.put({ id: String(i), tool: 'codex', time: '2026-10-16T01:00:00Z', totalTokens: 10 });
  ledger.put({ id: 'outside', time: '2026-10-17T00:00:00Z', totalTokens: 9999 });
  const range = { start: '2026-10-16', end: '2026-10-17' };
  const first = ledger.query(range), last = ledger.query({ ...range, page: 3 });
  assert.equal(first.records.length, 50); assert.equal(last.records.length, 23);
  assert.deepEqual(first.timeline, last.timeline);
  assert.equal(first.timeline.buckets.reduce((sum, bucket) => sum + bucket.calls, 0), 123);
  assert.equal(first.timeline.buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0), 1230);
  assert.equal(first.timeline.buckets.length, 24);
  ledger.rows.clear();
  ledger.managed = () => new Map([['managed', 'codex:native']]);
  ledger.put({ id: 'live', sessionId: 'managed', tool: 'codex', time: '2026-10-16T01:00:00Z', totalTokens: 10 });
  ledger.put({ id: 'import', source: 'machine', nativeId: 'native', tool: 'codex', time: '2026-10-16T01:00:00Z', totalTokens: 10 });
  assert.equal(ledger.query(range).timeline.buckets.reduce((sum, bucket) => sum + bucket.calls, 0), 1);
});

test('daily bins use the selected timezone and preserve missing versus zero tokens', () => {
  const result = usageTimeline([
    { time: '2026-10-15T17:00:00Z', totalTokens: 5 },
    { time: '2026-10-16T16:00:00Z', totalTokens: null },
    { time: '2026-10-16T17:00:00Z', totalTokens: 0 },
    { time: '2026-10-17T17:00:00Z', totalTokens: null },
  ], { start: '2026-10-15T16:00:00Z', end: '2026-10-19T16:00:00Z', timeZone: 'Asia/Shanghai' });
  assert.equal(result.interval, 'day');
  assert.deepEqual(result.buckets, [
    { time: '2026-10-16', calls: 1, measuredCalls: 1, totalTokens: 5 },
    { time: '2026-10-17', calls: 2, measuredCalls: 1, totalTokens: 0 },
    { time: '2026-10-18', calls: 1, measuredCalls: 0, totalTokens: null },
    { time: '2026-10-19', calls: 0, measuredCalls: 0, totalTokens: 0 },
  ]);
});

test('hourly bins handle both daylight saving transitions without losing repeated hours', () => {
  for (const [start, end, expected] of [
    ['2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 23],
    ['2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 25],
  ]) {
    const timeline = usageTimeline([], { start, end, timeZone: 'America/New_York' });
    assert.equal(timeline.interval, 'hour'); assert.equal(timeline.buckets.length, expected);
    assert.equal(new Set(timeline.buckets.map(bucket => bucket.time)).size, expected);
  }
});

test('long custom ranges remain bounded and count every record', () => {
  const timeline = usageTimeline([{ time: '2026-07-16T00:00:00Z', totalTokens: 12 }], { start: '2026-01-01', end: '2027-01-01' });
  assert.equal(timeline.interval, 'month'); assert.equal(timeline.buckets.length, 12);
  assert.equal(timeline.buckets[6].totalTokens, 12);
  assert.throws(() => usageTimeline([], { start: '2026-01-01', end: '2026-02-01', timeZone: 'invalid' }));
});
