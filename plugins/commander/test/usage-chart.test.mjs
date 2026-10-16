import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { formatTokens } from '../client/usage-state.mjs';
const { transformSync } = createRequire(import.meta.url)('esbuild');
const code = transformSync(readFileSync(new URL('../client/usage-chart.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const react = { createElement(type, props, ...children) { return typeof type === 'function' ? type(props) : { type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }; } };
const module = { exports: {} };
runInNewContext(code, { module, exports: module.exports, Date, Intl, require: id => id === 'react' ? react : { formatTokens } });
const nodes = value => value && typeof value === 'object' ? [value, ...value.children.flatMap(nodes)] : [];
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : value?.children.map(text).join('') || '';

test('combined chart shows both full-interval series and makes unknown counts accessible', () => {
  const timeline = { interval: 'day', timeZone: 'Asia/Shanghai', buckets: [
    { time: '2026-10-16', calls: 120, measuredCalls: 119, totalTokens: 4567 },
    { time: '2026-10-17', calls: 2, measuredCalls: 0, totalTokens: null },
  ] };
  const tree = module.exports.UsageCharts({ timeline }), all = nodes(tree);
  assert.match(text(tree), /共 122 条记录/);
  assert.equal(all.filter(node => node.type === 'figure').length, 1);
  const columns = all.filter(node => node.props.className === 'cmd-usage-chart-column');
  assert.equal(columns.length, 2);
  assert.equal(all.filter(node => node.props.className === 'cmd-usage-chart-bar').length, 2);
  assert.equal(all.filter(node => node.props.className === 'cmd-usage-chart-point').length, 2);
  assert.equal(all.filter(node => node.props.className === 'cmd-usage-chart-line').length, 1);
  assert.match(text(tree), /Token 用量 · 左轴/);
  assert.match(text(tree), /记录数量 · 右轴/);
  assert.match(columns[0].props['aria-label'], /120 条记录.*4,567.*1 条未提供/);
  assert.match(columns[1].props['aria-label'], /未提供.*2 条未提供/);
  assert.equal(all.filter(node => node.props.className === 'cmd-usage-chart-missing').length, 2);
});

test('charts distinguish a temporarily unavailable response from an empty interval', () => {
  assert.match(text(module.exports.UsageCharts({})), /暂未提供/);
  assert.match(text(module.exports.UsageCharts({ timeline: { interval: 'hour', buckets: [] } })), /还没有用量记录/);
});
