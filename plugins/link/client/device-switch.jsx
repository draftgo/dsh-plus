import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../commander/client/iconsax.jsx';
import { readJsonResponse } from '../../commander/client/http-response.mjs';
import { deviceIcon, deviceKind, deviceStatus, workbenchUrl } from './device-state.mjs';
import { deviceSwitchState } from './device-switch.mjs';

const switchStyle = `.dsh-device-switch{position:fixed;z-index:1200;top:0;right:148px;display:flex;align-items:center;justify-content:flex-end;height:var(--dsh-windows-titlebar-height,40px);max-width:min(240px,calc(100vw - var(--dsh-windows-menu-start,48px) - 168px));-webkit-app-region:no-drag;font:13px/1.4 var(--dsw-font-family,system-ui);color:var(--dsw-alias-label-secondary,#666)}
.dsh-device-switch-trigger{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:28px;padding:0 8px 0 9px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:default}
.dsh-device-switch-trigger:hover,.dsh-device-switch-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#8882);color:var(--dsw-alias-label-primary,#202020)}
.dsh-device-switch-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#2c6ee8);outline-offset:-2px}
html[data-input-modality=pointer] .dsh-device-switch-trigger:focus-visible{outline-color:transparent}
.dsh-device-switch-trigger>span:first-of-type{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-device-switch-menu{position:fixed;z-index:1201;display:grid;gap:2px;min-width:220px;max-width:min(320px,calc(100vw - 24px));max-height:min(360px,calc(100dvh - 56px));margin:0;padding:5px;overflow:auto;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#202020);box-shadow:0 12px 36px #0002;font:13px/1.4 var(--dsw-font-family,system-ui)}
.dsh-device-switch-menu button{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:default}
.dsh-device-switch-menu button:hover,.dsh-device-switch-menu button[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.dsh-device-switch-menu button[aria-current=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#2c6ee8) 12%,transparent)}
.dsh-device-switch-menu button:disabled{opacity:.55;cursor:default}
.dsh-device-switch-copy{display:grid;min-width:0;flex:1}.dsh-device-switch-copy strong,.dsh-device-switch-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-device-switch-copy small{color:var(--dsw-alias-label-secondary,#777);font-size:11px;font-weight:400}
.dsh-device-switch-error{margin:2px 4px 0;color:#b34845;font-size:11px;line-height:1.5}
.dsh-device-switch-stage{position:fixed;z-index:30;inset:var(--dsh-windows-titlebar-height,40px) 0 0;display:none;background:var(--dsw-alias-bg-base,#fff)}
html[data-dsh-remote-workbench] .dsh-device-switch-stage{display:block}
.dsh-device-switch-stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:inherit}
.dsh-device-switch-stage[hidden],.dsh-device-switch-stage iframe[hidden]{display:none!important}`;

function ownerRequest(action, args = {}) {
  const url = new URL('api/commander-devices', document.baseURI);
  return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) }).then(response => readJsonResponse(response, url));
}

/** The caption reuses the same one-use centre entry as the sidebar, then keeps that session. */
async function openCenter() {
  const value = await ownerRequest('launch', { parentOrigin: location.origin });
  if (value.error) throw new Error(typeof value.error === 'string' ? value.error : value.error.message || '设备暂时无法打开');
  const target = new URL(value.url, location.origin);
  const local = target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  if (!local || !target.pathname.endsWith('/enter')) throw new Error('设备中心地址无效');
  const entered = await fetch(target, { credentials: 'same-origin', redirect: 'manual' });
  const next = entered.headers.get('location');
  if (!next) throw new Error('设备暂时无法打开');
  const base = new URL(next, target);
  if (base.origin !== target.origin || !/^\/s\/[A-Za-z0-9_-]{43}\/$/.test(base.pathname)) throw new Error('设备中心地址无效');
  return async (action, args = {}) => {
    const url = new URL('api/devices', base);
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { origin: base.origin, 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
    const result = await readJsonResponse(response, url);
    if (result.error) throw new Error(typeof result.error === 'string' ? result.error : result.error.message || '设备暂时无法打开');
    return result;
  };
}

/** Direct device changes for the Windows caption. Hidden when only this computer exists. */
export function DeviceSwitch() {
  const root = useRef(null), menu = useRef(null), frames = useRef(new Map());
  const [devices, setDevices] = useState([]), [activeId, setActiveId] = useState(null), [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [urls, setUrls] = useState({});
  const api = useRef(null);
  const windows = typeof document !== 'undefined' && document.documentElement?.hasAttribute('data-windows-titlebar');
  const state = deviceSwitchState({ devices, activeId, open, busy, error });
  const refresh = () => ownerRequest('devices').then(value => { if (!value.error && Array.isArray(value.devices)) setDevices(value.devices); }).catch(() => {});
  useEffect(() => { if (windows) void refresh(); }, [windows]);
  useEffect(() => {
    if (!state.open) return undefined;
    const close = event => { if (!root.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false); };
    const key = event => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [state.open]);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-dsh-remote-workbench', Boolean(activeId && activeId !== 'local'));
    return () => document.documentElement.removeAttribute('data-dsh-remote-workbench');
  }, [activeId]);
  if (!windows || !state.multiple) return null;
  const choose = async device => {
    if (!device?.id || busy) return;
    if (device.id === 'local' || device.kind === 'local') { setActiveId(null); setOpen(false); setError(''); return; }
    setBusy(device.id); setError(''); setOpen(false);
    try {
      if (!urls[device.id]) {
        api.current ??= await openCenter();
        const value = await api.current('select', { deviceId: device.id });
        const url = workbenchUrl(value.url, location.origin);
        setUrls(current => ({ ...current, [device.id]: url }));
      }
      setActiveId(device.id); void refresh();
    } catch (reason) { setError(reason.message); setOpen(true); }
    finally { setBusy(''); }
  };
  const box = root.current?.getBoundingClientRect();
  return <>
    <style>{switchStyle}</style>
    <div className="dsh-device-switch" ref={root}>
      <button type="button" className="dsh-device-switch-trigger" aria-haspopup="menu" aria-expanded={state.open} aria-label={'当前工作台：' + state.active.name} title={state.active.name} disabled={!!busy} onClick={() => { setOpen(value => !value); if (!open) void refresh(); }}>
        <UIIcon name={deviceIcon(state.active)} size={15} />
        <span>{busy ? '正在打开…' : state.active.name}</span>
        <UIIcon name="chevronDown" size={12} />
      </button>
    </div>
    {state.open && createPortal(<div ref={menu} className="dsh-device-switch-menu" role="menu" aria-label="切换设备" style={box ? { top: box.bottom + 4, left: Math.max(8, Math.min(box.left, window.innerWidth - 236)) } : { top: 40, left: 148 }}>
      {state.items.map(device => <button key={device.id} type="button" role="menuitemradio" aria-checked={state.active.id === device.id} aria-current={state.active.id === device.id} disabled={!!busy} onClick={() => void choose(device)}>
        <UIIcon name={deviceIcon(device)} size={16} selected={state.active.id === device.id} />
        <span className="dsh-device-switch-copy"><strong>{device.name}</strong><small>{deviceKind(device)} · {busy === device.id ? '正在打开…' : state.active.id === device.id ? '当前工作台' : deviceStatus(device)}</small></span>
      </button>)}
      {error && <p className="dsh-device-switch-error" role="alert">{error}</p>}
    </div>, document.body)}
    {createPortal(<div className="dsh-device-switch-stage" hidden={!activeId}>{Object.entries(urls).map(([id, url]) => <iframe key={id} ref={node => { if (node) frames.current.set(id, node); else frames.current.delete(id); }} src={url} title={(devices.find(item => item.id === id)?.name || '设备') + '工作台'} hidden={activeId !== id} allow="clipboard-read; clipboard-write; microphone" referrerPolicy="no-referrer" />)}</div>, document.body)}
  </>;
}
