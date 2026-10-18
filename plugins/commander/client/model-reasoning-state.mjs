/** Keep the official llm-pi-ai vocabulary; wire values are provider-defined. */
export const reasoningLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const reasoningPresets = {
  standard: { off: null, low: 'low', medium: 'medium', high: 'high' },
  full: Object.fromEntries(reasoningLevels.map(level => [level, level === 'off' ? null : level])),
};

/** Undefined inherits the installed catalog; false declares a non-reasoning model. */
export function withModelReasoning(model, value) {
  const next = { ...model };
  if (value === undefined) delete next.reasoningEfforts;
  else next.reasoningEfforts = value;
  return next;
}

/** Match the adapter's runtime constraints, including those absent from its schema. */
export function reasoningError(value) {
  if (value === undefined || value === false) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '请选择思考档位，或恢复继承';
  const entries = Object.entries(value);
  if (!entries.length) return '至少启用一个思考档位，或恢复继承';
  for (const [level, wire] of entries) {
    if (!reasoningLevels.includes(level)) return '不支持的思考档位：' + level;
    if (wire === null && level === 'off') continue;
    if (typeof wire !== 'string' || !wire.trim()) return level + ' 的协议值不能为空；仅 off 可选择不发送';
  }
  if (!entries.some(([level]) => level !== 'off')) return '至少启用一个非 off 档位；不支持思考请选“非推理模型”';
  return undefined;
}

export function validateModelReasoning(models) {
  if (!Array.isArray(models)) return undefined;
  for (const [index, model] of models.entries()) {
    const error = reasoningError(model?.reasoningEfforts);
    if (error) return '模型 ' + (index + 1) + '：' + error;
  }
  return undefined;
}
