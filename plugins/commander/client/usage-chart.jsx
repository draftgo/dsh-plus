import React from 'react';
import { formatTokens } from './usage-state.mjs';

const periods = { hour: '小时', day: '天', month: '月', year: '年' };
const count = value => new Intl.NumberFormat('zh-CN').format(value);
function label(bucket, timeline, full = false) {
  if (timeline.interval === 'hour') return new Date(bucket.time).toLocaleTimeString('zh-CN', { timeZone: timeline.timeZone, hour: '2-digit', minute: '2-digit', ...(full ? { timeZoneName: 'short' } : {}) });
  return full || timeline.interval !== 'day' ? bucket.time : bucket.time.slice(5);
}

export function UsageCharts({ timeline }) {
  const buckets = timeline?.buckets || [], calls = buckets.reduce((sum, bucket) => sum + bucket.calls, 0);
  return <section className="cmd-usage-charts" aria-label="数据图表">
    <div className="cmd-usage-chart-heading"><h3>数据图表</h3>{timeline && <span>按{periods[timeline.interval]}汇总 · 共 {count(calls)} 条记录</span>}</div>
    {!timeline ? <div className="cmd-usage-empty">图表数据暂未提供，请刷新重试</div> : !calls ? <div className="cmd-usage-empty">这个时间段还没有用量记录</div> : <>
      <UsageChart timeline={timeline} />
      <p className="cmd-usage-chart-note">包含所选日期内的全部记录，不受详细记录分页影响。柱形显示 Token 用量（左轴），折线显示记录数量（右轴）。Token 仅汇总已提供的计数，缺失记录以斜线标记；悬停或聚焦查看详情。</p>
    </>}
  </section>;
}

function UsageChart({ timeline }) {
  const { buckets } = timeline;
  const tokenMaximum = Math.max(1, ...buckets.map(bucket => bucket.totalTokens ?? 0));
  const callMaximum = Math.ceil(Math.max(1, ...buckets.map(bucket => bucket.calls)) / 2) * 2;
  const width = Math.max(680, buckets.length * 12 + 120), height = 240, left = 64, right = 56, top = 24, plotHeight = 174, plotWidth = width - left - right;
  const step = plotWidth / buckets.length, barWidth = Math.max(2, Math.min(24, step * .6));
  const tickEvery = Math.max(1, Math.ceil((buckets.length - 1) / 6));
  const points = buckets.map((bucket, index) => ({ x: left + step * (index + .5), y: top + plotHeight * (1 - bucket.calls / callMaximum) }));
  const line = points.map(({ x, y }, index) => (index ? 'L' : 'M') + x + ',' + y).join(' ');
  return <figure className="cmd-usage-chart"><figcaption className="cmd-usage-chart-legend"><span><i className="cmd-usage-chart-token-key" aria-hidden="true" />Token 用量 · 左轴</span><span><i className="cmd-usage-chart-call-key" aria-hidden="true" />记录数量 · 右轴</span></figcaption><div className="cmd-usage-chart-scroll" tabIndex={0} role="region" aria-label="Token 用量与记录数量时间图表，可横向滚动">
    <svg viewBox={'0 0 ' + width + ' ' + height} style={{ minWidth: width }} role="group" aria-label={'Token 用量柱形与记录数量折线，按' + periods[timeline.interval] + '汇总'}>
      {[0, .5, 1].map(ratio => {
        const y = top + plotHeight * (1 - ratio);
        return <g key={ratio} className="cmd-usage-chart-axis"><line x1={left} x2={width - right} y1={y} y2={y} /><text x={left - 8} y={y + 4} textAnchor="end" aria-label={'Token 用量 ' + formatTokens(tokenMaximum * ratio)}>{formatTokens(tokenMaximum * ratio)}</text><text x={width - right + 8} y={y + 4} textAnchor="start" aria-label={'记录数量 ' + count(callMaximum * ratio)}>{count(callMaximum * ratio)}</text></g>;
      })}
      {buckets.map((bucket, index) => {
        const missing = bucket.measuredCalls < bucket.calls;
        const description = label(bucket, timeline, true) + '：' + count(bucket.calls) + ' 条记录，' + (missing ? '已知 Token ' : 'Token ') + formatTokens(bucket.totalTokens) + (missing ? '，' + count(bucket.calls - bucket.measuredCalls) + ' 条未提供' : '');
        const { x, y } = points[index], barHeight = (bucket.totalTokens ?? 0) / tokenMaximum * plotHeight;
        return <g key={bucket.time} className="cmd-usage-chart-column" tabIndex={0} role="img" aria-label={description}><title>{description}</title>
          <rect className="cmd-usage-chart-hit" x={x - step / 2} y={top} width={step} height={plotHeight} />
          <rect className="cmd-usage-chart-bar" x={x - barWidth / 2} y={top + plotHeight - barHeight} width={barWidth} height={barHeight} rx={2} />
          {missing && <path className="cmd-usage-chart-missing" d={'M' + (x - 3) + ',' + (top + plotHeight - Math.max(barHeight, 4) - 5) + 'l6,-6'} />}
          <circle className="cmd-usage-chart-point" cx={x} cy={y} r={3} />
          {(index % tickEvery === 0 || index === buckets.length - 1) && <text className="cmd-usage-chart-tick" x={x} y={height - 12} textAnchor="middle">{label(bucket, timeline)}</text>}
        </g>;
      })}
      <path className="cmd-usage-chart-line" d={line} aria-hidden="true" />
    </svg>
  </div></figure>;
}
