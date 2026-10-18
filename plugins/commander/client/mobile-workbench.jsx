import React, { useEffect, useRef, useState } from 'react';
import { UIIcon } from './iconsax.jsx';
import css from './mobile-workbench.css';
import { trackFrameResize } from './resize-settling.mjs';

const MOBILE = '(max-width: 767px)';
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Responsive chrome around the real web workbench; no duplicate session/config state. */
export function MobileWorkbench({ ctx }) {
  const chrome = useRef(null), opener = useRef(null);
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE).matches);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(MOBILE);
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const frame = chrome.current?.closest('.cmd-shell-frame');
    if (!frame) return;
    const update = () => setOpen(!frame.hasAttribute('data-sidebar-collapsed'));
    const observer = new MutationObserver(update);
    observer.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] });
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const frame = chrome.current?.closest('.cmd-shell-frame');
    return trackFrameResize(frame, window.ResizeObserver);
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const viewport = window.visualViewport, root = document.documentElement;
    const previous = root.style.getPropertyValue('--cmd-mobile-viewport-height');
    let measuredHeight;
    const measure = () => {
      // Pinch zoom remains native; only keyboard/browser chrome resize the shell.
      if (!viewport || viewport.scale === 1) {
        const height = Math.round(viewport?.height ?? window.innerHeight);
        if (height !== measuredHeight) {
          measuredHeight = height;
          root.style.setProperty('--cmd-mobile-viewport-height', height + 'px');
        }
      }
    };
    measure();
    viewport?.addEventListener('resize', measure);
    window.addEventListener('resize', measure);
    return () => {
      viewport?.removeEventListener('resize', measure);
      window.removeEventListener('resize', measure);
      if (previous) root.style.setProperty('--cmd-mobile-viewport-height', previous);
      else root.style.removeProperty('--cmd-mobile-viewport-height');
    };
  }, [mobile]);
  useEffect(() => {
    if (!mobile || !open) return;
    const frame = chrome.current?.closest('.cmd-shell-frame');
    const drawer = frame?.querySelector('.cmd-shell-sidebar')?.parentElement;
    if (!frame || !drawer) return;
    const main = frame.querySelector('[class*="centerCol"]'), rightbar = frame.querySelector('[data-rightbar-col]');
    const blocked = [main, rightbar].filter(Boolean).map(node => [node, node.inert]);
    for (const [node] of blocked) node.inert = true;
    const attributes = ['role', 'aria-modal', 'aria-label'].map(name => [name, drawer.getAttribute(name)]);
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', '工作台导航');
    const close = () => { if (!frame.hasAttribute('data-sidebar-collapsed')) ctx.layout.toggleSidebar(); };
    const controls = () => [...drawer.querySelectorAll(FOCUSABLE)].filter(node => !node.closest('[inert]') && node.getClientRects().length);
    controls()[0]?.focus({ preventScroll: true });
    const onKey = event => {
      // Official settings/menus own focus and Escape when portalled above us.
      if ([...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(node => node !== drawer && node.getClientRects().length)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      const nodes = controls(), first = nodes[0], last = nodes.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !drawer.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !drawer.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const onNavigate = event => {
      const target = event.target.closest?.('button, a');
      if (!target) return;
      if (target.matches('.cmd-settings')) requestAnimationFrame(close);
      else if (target.matches('.cmd-session, .cmd-new-chat, .cmd-project-new, [class*="newSession"]') || target.closest('[class*="panelList"]')) queueMicrotask(close);
    };
    document.addEventListener('keydown', onKey, true);
    drawer.addEventListener('click', onNavigate);
    return () => {
      const restoreFocus = drawer.contains(document.activeElement);
      document.removeEventListener('keydown', onKey, true);
      drawer.removeEventListener('click', onNavigate);
      for (const [node, inert] of blocked) node.inert = inert;
      for (const [name, value] of attributes) { if (value === null) drawer.removeAttribute(name); else drawer.setAttribute(name, value); }
      if (restoreFocus) opener.current?.focus({ preventScroll: true });
    };
  }, [ctx, mobile, open]);
  return <div ref={chrome} className="cmd-mobile-workbench" hidden={!mobile}>
    <header className="cmd-mobile-toolbar">
      <button ref={opener} type="button" aria-label={open ? '收起侧边栏' : '打开侧边栏'} aria-expanded={open} aria-haspopup="dialog" onClick={() => ctx.layout.toggleSidebar()}><UIIcon name="collapse" className={!open ? 'cmd-mobile-sidebar-icon-open' : ''} size={21} /></button>
      <span>工作台</span>
      <button type="button" aria-label="新建对话" onClick={() => { ctx.uiWorkspace.startSession(); }}><UIIcon name="edit" size={21} /></button>
    </header>
    {mobile && open && <button type="button" className="cmd-mobile-drawer-mask" aria-label="关闭侧边栏" tabIndex={-1} onClick={() => ctx.layout.toggleSidebar()} />}
  </div>;
}

export function applyMobileWorkbench(ctx) {
  const style = document.createElement('style');
  style.dataset.commanderMobileWorkbench = '';
  style.textContent = css; document.head.append(style);
  ctx.effect(() => () => style.remove());
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'commander-mobile-workbench', order: -100, inject: () => ({ ctx }),
  }, MobileWorkbench));
}
