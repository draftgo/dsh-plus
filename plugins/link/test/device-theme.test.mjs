import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDeviceTheme, initialDeviceTheme, observeHostTheme, readHostTheme } from '../client/device-theme.mjs';

function fixture({ dark = false, theme = '', embedded = false } = {}) {
  const listeners = new Map(), attrs = new Map(), rootAttrs = new Map(), messages = [];
  let mutate, disconnected = false;
  const media = { matches: dark, addEventListener(name, fn) { listeners.set('media:' + name, fn); }, removeEventListener(name) { listeners.delete('media:' + name); } };
  const host = {
    location: { search: theme ? '?theme=' + theme : '' },
    document: {
      documentElement: { style: {}, getAttribute: key => rootAttrs.get(key), setAttribute: (key, value) => rootAttrs.set(key, value) },
      body: { hasAttribute: key => attrs.has(key), toggleAttribute(key, force) { if (force) attrs.set(key, ''); else attrs.delete(key); } },
    },
    MutationObserver: class { constructor(fn) { mutate = fn; } observe() {} disconnect() { disconnected = true; } },
    matchMedia: () => media,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    __DSH_DEVICE_PARENT_ORIGIN__: 'https://workbench.test',
  };
  host.parent = embedded ? { postMessage(data, origin) { messages.push({ data, origin }); } } : host;
  return { host, messages, attrs, rootAttrs, listeners, mutate: () => mutate(), get disconnected() { return disconnected; }, system(value) { media.matches = value; listeners.get('media:change')?.(); }, receive(data, source = host.parent, origin = host.__DSH_DEVICE_PARENT_ORIGIN__) { listeners.get('message')?.({ data, source, origin }); } };
}

test('host resolved light palette overrides a dark operating system and follows live changes', () => {
  const env = fixture({ dark: true }), values = [];
  env.host.document.documentElement.style.colorScheme = 'light';
  assert.equal(readHostTheme(env.host), 'light');
  const dispose = observeHostTheme(value => values.push(value), env.host);
  env.system(false); assert.deepEqual(values, ['light']);
  env.host.document.documentElement.style.colorScheme = 'dark'; env.mutate();
  assert.deepEqual(values, ['light', 'dark']);
  dispose(); assert(env.disconnected); assert.equal(env.listeners.size, 0);
});

test('standalone device centre follows operating system changes and cleans subscriptions', () => {
  const env = fixture(), values = [];
  const dispose = connectDeviceTheme(value => values.push(value), env.host);
  assert.equal(initialDeviceTheme(env.host), 'light');
  env.system(true); assert.deepEqual(values, ['light', 'dark']);
  assert.equal(env.host.document.documentElement.style.colorScheme, 'dark');
  assert.equal(env.rootAttrs.get('data-dsh-device-theme'), 'dark');
  assert(env.attrs.has('data-ds-dark-theme'));
  env.system(false); assert.equal(env.attrs.has('data-ds-dark-theme'), false);
  dispose(); assert.equal(env.listeners.size, 0);
});

test('embedded device centre accepts only its trusted parent appearance and ignores system afterwards', () => {
  const env = fixture({ dark: true, theme: 'light', embedded: true }), values = [];
  const dispose = connectDeviceTheme(value => values.push(value), env.host);
  assert.deepEqual(values, ['light']);
  assert.deepEqual(env.messages, [{ data: { type: 'dsh-devices:theme-ready' }, origin: 'https://workbench.test' }]);
  env.receive({ type: 'dsh-devices:theme', theme: 'dark' }, {});
  env.receive({ type: 'dsh-devices:theme', theme: 'dark' }, env.host.parent, 'https://other.test');
  env.receive({ type: 'dsh-devices:theme', theme: 'system' });
  assert.deepEqual(values, ['light']);
  env.receive({ type: 'dsh-devices:theme', theme: 'dark' });
  env.system(false); assert.deepEqual(values, ['light', 'dark']);
  env.receive({ type: 'dsh-devices:theme', theme: 'light' });
  assert.deepEqual(values, ['light', 'dark', 'light']);
  dispose();
});
