import React from 'react';
import { reasoningLevels, reasoningPresets, reasoningError, withModelReasoning } from './model-reasoning-state.mjs';

/** A controlled extension of the official per-model draft and save flow. */
export function ModelReasoningEditor({ model, position, disabled, onChange, styles }) {
  const value = model.reasoningEfforts;
  const mode = value === undefined ? 'inherit' : value === false ? 'disabled' : 'custom';
  const mapping = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const error = reasoningError(value);
  const update = next => onChange(withModelReasoning(model, next));
  const patch = (level, wire) => update({ ...mapping, [level]: wire });
  const prefix = '模型 ' + position + ' 思考档位';
  return <fieldset disabled={disabled} className={styles.modelInputTypes}>
    <legend className={styles.modelFieldLabel}>思考档位</legend>
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <select className={styles.input} aria-label={prefix} value={mode} onChange={event => update(event.target.value === 'inherit' ? undefined : event.target.value === 'disabled' ? false : { ...reasoningPresets.standard })}>
        <option value="inherit">继承模型默认能力</option>
        <option value="disabled">非推理模型</option>
        <option value="custom">自定义档位与协议值</option>
      </select>
      <p className={styles.advancedHint}>每个模型单独配置；仅启用接口支持的档位。继承会移除本模型的覆盖配置。</p>
      {mode === 'custom' && <>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
          <span className={styles.modelFieldLabel}>填入模板</span>
          <button type="button" className={styles.linkButton} onClick={() => update({ ...reasoningPresets.standard })}>标准三档</button>
          <button type="button" className={styles.linkButton} onClick={() => update({ ...reasoningPresets.full })}>完整七档</button>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {reasoningLevels.map(level => {
            const selected = Object.hasOwn(mapping, level);
            const omitted = level === 'off' && mapping.off === null;
            return <div key={level} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <label className={styles.modelFieldLabel} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 86 }}>
                <input type="checkbox" checked={selected} aria-label={prefix + ' 启用 ' + level} onChange={event => {
                  if (event.target.checked) patch(level, level === 'off' ? null : level);
                  else { const next = { ...mapping }; delete next[level]; update(next); }
                }} />{level}
              </label>
              {selected && <>
                {level === 'off' && <label className={styles.modelFieldLabel} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={omitted} aria-label={prefix + ' off 不发送协议值'} onChange={event => patch('off', event.target.checked ? null : 'off')} />不发送协议值
                </label>}
                {!omitted && <input className={styles.input} style={{ flex: '1 1 140px', minWidth: 100 }} value={typeof mapping[level] === 'string' ? mapping[level] : ''} aria-label={prefix + ' ' + level + ' 协议值'} aria-invalid={typeof mapping[level] !== 'string' || !mapping[level].trim()} placeholder="接口实际接收的值" onChange={event => patch(level, event.target.value)} />}
              </>}
            </div>;
          })}
        </div>
        <p className={styles.advancedHint}>按接口文档填写实际协议值；模板不代表模型支持这些档位。多个档位可映射到同一值；off 选“不发送协议值”表示不发送该档位的协议值，具体开关由适配器处理。</p>
      </>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>
  </fieldset>;
}
