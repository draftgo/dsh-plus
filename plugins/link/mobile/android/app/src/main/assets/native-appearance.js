/* Native-only, read-only appearance probe. Device management is never exposed. */
(() => {
  if (window.top !== window || window.__xiaojiaoAppearance) return;
  let pending = false, previous = '', surface;
  const channel = window.XiaojiaoAppearance;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  const hex = color => {
    if (!color || !context) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = 'rgba(0,0,0,0)';
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const rgba = context.getImageData(0, 0, 1, 1).data;
    return rgba[3] === 255 ? '#' + [...rgba].slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('') : null;
  };
  const tokenProbe = document.createElement('span');
  tokenProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;background-color:var(--dsw-alias-bg-base,transparent)';
  const read = () => {
    if (!document.body) return null;
    const next = document.querySelector('.dc-root,.link-mobile-v3');
    if (next !== surface) { surface = next; watchSurface(); }
    if (!tokenProbe.isConnected) document.body.appendChild(tokenProbe);
    // Harness owns the palette token; modal scrims must not recolor native chrome.
    const token = hex(getComputedStyle(tokenProbe).backgroundColor);
    const page = getComputedStyle(surface || document.body);
    const background = token || hex(page.backgroundColor) || hex(getComputedStyle(document.documentElement).backgroundColor);
    if (!background) return null;
    return { href: location.href, background, foreground: hex(page.color) || (dark.matches ? '#ffffff' : '#222222') };
  };
  const publish = () => {
    pending = false;
    const value = read();
    if (!value) return;
    const message = JSON.stringify(value);
    if (message === previous) return;
    previous = message;
    channel?.postMessage(message);
  };
  const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(publish); } };
  const attributes = { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-ds-dark-theme', 'data-ds-theme-source'] };
  const surfaceObserver = new MutationObserver(schedule);
  function watchSurface() { surfaceObserver.disconnect(); if (surface) surfaceObserver.observe(surface, attributes); }
  const rootObserver = new MutationObserver(schedule);
  if (document.documentElement) rootObserver.observe(document.documentElement, attributes);
  const ready = () => {
    rootObserver.observe(document.documentElement, attributes);
    rootObserver.observe(document.body, attributes);
    const root = document.getElementById('root');
    if (root) rootObserver.observe(root, { childList: true });
    const headObserver = new MutationObserver(schedule);
    headObserver.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['media', 'href', 'content'] });
    schedule();
  };
  document.addEventListener('DOMContentLoaded', ready, { once: true });
  if (document.readyState !== 'loading') ready();
  document.addEventListener('load', schedule, true);
  document.addEventListener('transitionend', schedule, true);
  window.addEventListener('pageshow', schedule);
  dark.addEventListener('change', schedule);
  window.__xiaojiaoAppearance = { read };
})();
