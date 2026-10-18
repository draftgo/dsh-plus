import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as reasoning from '../client/model-reasoning-state.mjs';

const code = transformSync(readFileSync(new URL('../client/model-reasoning.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment') };
const module = { exports: {} };
runInNewContext(code, { module, exports: module.exports, require: id => id === 'react' ? react : reasoning });
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
function editor(initial = { id: 'model' }, disabled = false) {
  let model = initial;
  return {
    get model() { return model; },
    render() { return module.exports.ModelReasoningEditor({ model, disabled, position: 2, styles: {}, onChange: next => { model = next; } }); },
    find(label) { return nodes(this.render()).find(node => node.props?.['aria-label'] === label); },
    select(mode) { this.find('模型 2 思考档位').props.onChange({ target: { value: mode } }); },
  };
}

test('reasoning inherits by omission, disables explicitly, and preserves unrelated model settings', () => {
  const model = { id: 'm', input: ['text', 'image'], compat: { supportsReasoningEffort: true }, reasoningEfforts: { high: 'deep' } };
  const reset = reasoning.withModelReasoning(model, undefined);
  assert(!Object.hasOwn(reset, 'reasoningEfforts'));
  assert.equal(model.reasoningEfforts.high, 'deep');
  assert.deepEqual(reset.input, model.input);
  assert.deepEqual(reset.compat, model.compat);
  assert.equal(reasoning.withModelReasoning(reset, false).reasoningEfforts, false);
});

test('reasoning validates official adapter constraints before a settings write', () => {
  for (const value of [undefined, false, reasoning.reasoningPresets.standard, reasoning.reasoningPresets.full, { off: 'none', low: 'basic', high: 'deep' }]) {
    assert.equal(reasoning.reasoningError(value), undefined);
  }
  for (const value of [null, true, [], {}, { off: null }, { off: 'off' }, { high: null }, { high: '' }, { high: ' ' }, { ultra: 'deep' }]) {
    assert.equal(typeof reasoning.reasoningError(value), 'string');
  }
  assert.match(reasoning.validateModelReasoning([{ id: 'a' }, { id: 'b', reasoningEfforts: { high: null } }]), /模型 2：/);
  assert.equal(reasoning.validateModelReasoning(undefined), undefined);
});

test('the editor changes model capability through controlled state and removes overrides on inherit', () => {
  const h = editor({ id: 'm', maxTokens: 32000, compat: { supportsReasoningEffort: true } });
  h.select('custom');
  assert.deepEqual(JSON.parse(JSON.stringify(h.model.reasoningEfforts)), reasoning.reasoningPresets.standard);
  h.find('模型 2 思考档位 high 协议值').props.onChange({ target: { value: 'deep' } });
  assert.equal(h.model.reasoningEfforts.high, 'deep');
  h.find('模型 2 思考档位 启用 medium').props.onChange({ target: { checked: false } });
  assert(!Object.hasOwn(h.model.reasoningEfforts, 'medium'));
  h.select('disabled');
  assert.equal(h.model.reasoningEfforts, false);
  h.select('inherit');
  assert(!Object.hasOwn(h.model, 'reasoningEfforts'));
  assert.equal(h.model.maxTokens, 32000);
  assert.deepEqual(h.model.compat, { supportsReasoningEffort: true });
});

test('off maps to omission or an explicit wire value and empty declarations surface an error', () => {
  const h = editor({ id: 'm', reasoningEfforts: { off: null, high: 'deep' } });
  assert.equal(h.find('模型 2 思考档位 off 协议值'), undefined);
  h.find('模型 2 思考档位 off 不发送协议值').props.onChange({ target: { checked: false } });
  assert.equal(h.model.reasoningEfforts.off, 'off');
  h.find('模型 2 思考档位 off 协议值').props.onChange({ target: { value: 'none' } });
  assert.equal(h.model.reasoningEfforts.off, 'none');
  h.find('模型 2 思考档位 off 不发送协议值').props.onChange({ target: { checked: true } });
  assert.equal(h.model.reasoningEfforts.off, null);
  h.find('模型 2 思考档位 启用 high').props.onChange({ target: { checked: false } });
  assert(nodes(h.render()).some(node => node.props?.role === 'alert'));
  h.select('inherit');
  assert(!nodes(h.render()).some(node => node.props?.role === 'alert'));
  assert.equal(editor({ id: 'm' }, true).render().props.disabled, true);
});
