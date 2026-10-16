export function formatTokens(value) {
  if (value == null || !Number.isFinite(Number(value))) return '未提供';
  const count = Number(value), magnitude = Math.abs(count);
  if (magnitude >= 1_000_000_000) return (count / 1_000_000_000).toFixed(2) + 'B';
  if (magnitude >= 1_000_000) return (count / 1_000_000).toFixed(2) + 'M';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(count);
}
