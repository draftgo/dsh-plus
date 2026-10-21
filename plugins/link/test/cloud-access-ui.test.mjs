import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(new URL('../package.json', import.meta.url));
const source = await readFile(new URL('../client/cloud-access.jsx', import.meta.url), 'utf8');
const code = require('esbuild').transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(nodes)] : [];
const textOf = tree => typeof tree === 'object' ? (tree?.children || []).map(textOf).join('') : String(tree ?? '');
function fixture({ configured = true, ready = true, clipboard = async () => {}, initial, fail = () => false } = {}) {
  let cursor = 0, value = initial === undefined ? { configured, ready, enabled: false, origin: 'https://cloud.test' } : initial; const slots = [], calls = [], copied = [];
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== false && value != null) }), useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; }, useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; } };
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, Uint8Array, crypto: webcrypto, btoa, navigator: { clipboard: { writeText: async key => { copied.push(key); await clipboard(key); } } }, location: { origin: 'https://cloud.test' }, require: name => name === 'react' ? react : name.includes('api.mjs') ? { managementCall: async (action, input) => { calls.push({ action, input }); if (fail()) throw Error('暂时无法连接，请重试'); value = { ...value, enabled: input.operation !== 'disable' }; return { cloudAccess: value }; } } : {} });
  const render = props => { cursor = 0; return module.exports.CloudAccessSettings({ value, onChanged: next => { value = next.cloudAccess; }, ...props }); };
  const find = label => nodes(render()).find(node => node.type === 'button' && textOf(node) === label);
  return { render, calls, copied, find, module, keyInput: () => nodes(render()).find(node => node.type === 'input' && node.props['aria-label'] === '访问密钥'), saved: () => nodes(render()).find(node => node.type === 'input' && node.props.type === 'checkbox') };
}
test('unknown, failed and unready cloud access end loading and offer retry without deployment instructions', () => {
  for (const options of [{ configured: false }, { ready: false }, { initial: null }, { initial: { configured: true } }]) {
    const f = fixture(options), tree = f.render({ onRetry() {} });
    assert.match(textOf(tree), /暂不可用/);
    assert.doesNotMatch(textOf(tree), /读取中|Nginx|Cookie|DSH_LINK|派生值/);
    assert.equal(nodes(tree).some(node => node.type === 'form'), false);
    assert(nodes(tree).some(node => node.type === 'button' && textOf(node) === '重试'));
  }
});
test('generated key copies, requires saved confirmation, enables and clears only after success', async () => {
  const f = fixture(); f.find('生成密钥').props.onClick();
  const key = f.keyInput().props.value;
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.find('启用访问密钥').props.disabled, true);
  await f.find('复制密钥').props.onClick();
  assert.deepEqual(f.copied, [key]);
  assert.equal(f.find('启用访问密钥').props.disabled, true);
  f.saved().props.onChange({ target: { checked: true } });
  await nodes(f.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.at(-1).input.operation, 'enable');
  assert.equal(f.calls.at(-1).input.key, key);
  assert.equal(f.keyInput(), undefined);
  assert.match(textOf(f.render()), /访问密钥已启用/);
});
test('clipboard failure selects generated key without claiming it is copied or saved', async () => {
  const f = fixture({ clipboard: async () => { throw Error('denied'); } });
  f.find('生成密钥').props.onClick(); let focused = 0, selected = 0;
  f.keyInput().props.ref.current = { focus() { focused++; }, select() { selected++; } };
  await f.find('复制密钥').props.onClick();
  assert.equal(focused, 1); assert.equal(selected, 1);
  assert.match(textOf(f.render()), /复制失败，密钥已选中/);
  assert.equal(f.saved().props.checked, false);
});
test('failed rotation retains the draft, custom editing resets confirmation, cancellation and disable confirmation are explicit', async () => {
  let failing = false; const f = fixture({ fail: () => failing });
  const submit = async () => { nodes(f.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve)); };
  f.find('生成密钥').props.onClick(); f.saved().props.onChange({ target: { checked: true } }); await submit();
  f.find('生成新密钥').props.onClick(); const key = f.keyInput().props.value; f.saved().props.onChange({ target: { checked: true } }); failing = true; await submit();
  assert.equal(f.calls.at(-1).input.operation, 'rotate'); assert.equal(f.keyInput().props.value, key);
  f.find('自定义密钥').props.onClick(); f.keyInput().props.onChange({ target: { value: 'custom-long-access-key' } }); assert.equal(f.saved().props.checked, false);
  failing = false; f.saved().props.onChange({ target: { checked: true } }); await submit(); assert.equal(f.keyInput(), undefined);
  f.find('生成新密钥').props.onClick(); f.find('取消').props.onClick(); assert.equal(f.keyInput(), undefined);
  f.find('自定义密钥').props.onClick(); f.find('取消').props.onClick(); assert.equal(f.keyInput(), undefined);
  f.find('关闭密钥').props.onClick(); f.find('取消关闭').props.onClick(); assert.equal(f.find('确认关闭'), undefined);
  const count = f.calls.length; f.find('关闭密钥').props.onClick(); assert.equal(f.calls.length, count); await f.find('确认关闭').props.onClick();
  assert.equal(f.calls.at(-1).input.operation, 'disable'); assert.equal('key' in f.calls.at(-1).input, false);
});
test('generation uses secure random bytes and never persists secrets in storage or URLs', () => {
  const f = fixture(), values = new Set(Array.from({ length: 8 }, () => f.module.exports.generateAccessKey()));
  assert.equal(values.size, 8);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|searchParams\.set/);
});
