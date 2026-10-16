const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Translate reported native counters to Harness's disjoint billing buckets. */
export function harnessUsage(provider, value = {}, convention) {
  const input = count(value.inputTokens ?? value.input_tokens ?? value.input);
  const outputTokens = count(value.outputTokens ?? value.output_tokens ?? value.output);
  const cacheReadTokens = count(value.cacheReadTokens ?? value.cachedInputTokens ?? value.cache_read_input_tokens ?? value.cacheRead ?? value.cache?.read);
  const cacheWriteTokens = count(value.cacheWriteTokens ?? value.cache_creation_input_tokens ?? value.cacheWrite ?? value.cache?.write);
  if (input === undefined || outputTokens === undefined) return undefined;
  // Codex's prompt includes cached input; its protocol has no cache-write bucket.
  const inclusive = convention === 'inclusive' || provider === 'codex';
  if (inclusive && (cacheReadTokens === undefined || cacheReadTokens > input)) return undefined;
  const inputTokens = inclusive ? input - cacheReadTokens : input;
  const usage = { inputTokens, outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
  const reportedTotal = count(value.totalTokens ?? value.total_tokens ?? value.total);
  if (reportedTotal !== undefined && reportedTotal >= inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)) usage.totalTokens = reportedTotal;
  const reasoningTokens = count(value.reasoningTokens ?? value.reasoningOutputTokens ?? value.reasoning_output_tokens ?? value.reasoning);
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  return usage;
}

/** Only one identifiable request can safely occupy one Harness adapter step. */
export function singleRequestUsage(provider, samples) {
  if (samples.size !== 1) return undefined;
  if (String(samples.keys().next().value).startsWith('unidentified:')) return undefined;
  const sample = samples.values().next().value;
  return harnessUsage(provider, sample.usage, sample.convention);
}
