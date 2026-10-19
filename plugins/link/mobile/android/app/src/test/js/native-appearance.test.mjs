import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../main/assets/native-appearance.js', import.meta.url), 'utf8');
function page() {
  const messages = [], observers = [], frames = [], events = new Map();
  const body = { backgroundColor: 'transparent', color: '#222222', appendChild(node) { node.isConnected = true; } };
  const html = { backgroundColor: 'transparent' }, root = {}, head = {};
  const surface = { backgroundColor: '#fffdf8', color: '#1d292e' };
  let activeSurface = surface;
  const media = { matches: false, addEventListener(name, callback) { events.set('media:' + name, callback); } };
  const style = { cssText: '' }, probe = { style, isConnected: false };
  let fill = '#000000', rgba;
  const context = {
    clearRect() { rgba = [0, 0, 0, 0]; },
    set fillStyle(value) { fill = value; },
    fillRect() { rgba = /^#[0-9a-f]{6}$/i.test(fill) ? [1, 3, 5].map(index => parseInt(fill.slice(index, index + 2), 16)).concat(255) : [0, 0, 0, 0]; },
    getImageData() { return { data: rgba }; },
  };
  const document = {
    body, documentElement: html, head, readyState: 'complete',
    createElement(tag) { return tag === 'canvas' ? { getContext: () => context } : probe; },
    getElementById() { return root; }, querySelector() { return activeSurface; },
    addEventListener(name, callback) { events.set(name, callback); },
  };
  const window = { XiaojiaoAppearance: { postMessage: raw => messages.push(JSON.parse(raw)) }, addEventListener(name, callback) { events.set(name, callback); } };
  window.top = window; window.window = window;
  const state = { token: 'transparent' };
  const sandbox = { window, document, location: { href: 'https://work.example/link/workbench/' }, matchMedia: () => media,
    getComputedStyle: node => node === probe ? { backgroundColor: state.token } : node,
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} },
    requestAnimationFrame: callback => { frames.push(callback); },
  };
  vm.runInNewContext(source, sandbox);
  const flush = () => { while (frames.length) frames.shift()(); };
  flush();
  return { messages, body, surface, media, state, events, window, flush, mutate() { observers.forEach(observer => observer.callback()); flush(); }, setSurface(value) { activeSurface = value; this.mutate(); } };
}
test('local actual surface controls bars and duplicate events do not post again', () => {
  const p = page();
  assert.equal(p.messages.at(-1).background, '#fffdf8');
  assert.equal(p.messages.at(-1).foreground, '#1d292e');
  p.mutate(); assert.equal(p.messages.length, 1);
  p.surface.backgroundColor = '#171b1d'; p.surface.color = '#edf2f0'; p.mutate();
  assert.equal(p.messages.at(-1).background, '#171b1d');
});
test('manual dark/light overrides system auto; restoring auto follows later media changes', () => {
  const p = page();
  p.media.matches = true; p.events.get('media:change')(); p.flush();
  assert.equal(p.messages.at(-1).background, '#fffdf8');
  p.surface.backgroundColor = '#171b1d'; p.mutate(); // Explicit dark or auto-resolved dark.
  assert.equal(p.messages.at(-1).background, '#171b1d');
  p.media.matches = false; p.events.get('media:change')(); p.flush();
  assert.equal(p.messages.at(-1).background, '#171b1d'); // Explicit dark persists.
  p.surface.backgroundColor = '#fffdf8'; p.mutate(); // Upstream auto presenter resolves light.
  assert.equal(p.messages.at(-1).background, '#fffdf8');
  p.media.matches = true; p.surface.backgroundColor = '#171b1d'; p.events.get('media:change')(); p.flush();
  assert.equal(p.messages.at(-1).background, '#171b1d');
});
test('Harness base token takes precedence over overlays and device page uses own surface', () => {
  const p = page(); p.state.token = '#f8f9fb'; p.body.backgroundColor = '#000000'; p.mutate();
  assert.equal(p.messages.at(-1).background, '#f8f9fb');
  p.state.token = '#171b1d'; p.mutate(); assert.equal(p.messages.at(-1).background, '#171b1d');
  p.state.token = 'transparent'; p.setSurface({ backgroundColor: '#ffffff', color: '#202020' });
  assert.equal(p.messages.at(-1).background, '#ffffff');
});
test('subframes cannot install an appearance reporter', () => {
  const window = { top: {} }; vm.runInNewContext(source, { window });
  assert.equal(window.__xiaojiaoAppearance, undefined);
});
