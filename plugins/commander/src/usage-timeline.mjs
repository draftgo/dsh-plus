const hour = 3_600_000, day = 24 * hour;

/** Aggregate the filtered, deduplicated interval before history pagination. */
export function usageTimeline(rows, { start, end, timeZone = 'UTC' }) {
  const from = Date.parse(start), to = Date.parse(end);
  const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDate = time => formatter.format(new Date(time));
  const firstDate = localDate(from), lastDate = localDate(to - 1);
  const interval = firstDate === lastDate ? 'hour' : to - from <= 90 * day ? 'day' : to - from <= 3660 * day ? 'month' : 'year';
  const periodKey = time => interval === 'hour' ? String(Math.floor((time - from) / hour)) : localDate(time).slice(0, interval === 'day' ? 10 : interval === 'month' ? 7 : 4);
  const buckets = new Map();
  const add = (key, time) => buckets.set(key, { time, calls: 0, measuredCalls: 0, totalTokens: null });
  if (interval === 'hour') {
    for (let time = from; time < to; time += hour) add(periodKey(time), new Date(time).toISOString());
  } else {
    const first = new Date(firstDate + 'T00:00:00Z'), last = new Date(lastDate + 'T00:00:00Z');
    if (interval !== 'day') { first.setUTCDate(1); last.setUTCDate(1); }
    if (interval === 'year') { first.setUTCMonth(0); last.setUTCMonth(0); }
    for (let cursor = first; cursor <= last;) {
      const key = cursor.toISOString().slice(0, interval === 'day' ? 10 : interval === 'month' ? 7 : 4);
      add(key, key);
      if (interval === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
      else if (interval === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      else cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
    }
  }
  for (const row of rows) {
    const bucket = buckets.get(periodKey(Date.parse(row.time)));
    if (!bucket) continue;
    bucket.calls++;
    if (row.totalTokens !== null && row.totalTokens !== undefined) {
      bucket.measuredCalls++; bucket.totalTokens = (bucket.totalTokens ?? 0) + row.totalTokens;
    }
  }
  return { interval, timeZone, buckets: [...buckets.values()].map(bucket => bucket.calls ? bucket : { ...bucket, totalTokens: 0 }) };
}
