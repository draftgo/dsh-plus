import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../commander/client/iconsax.jsx';
import { readJsonResponse } from '../../commander/client/http-response.mjs';
import { connectDeviceNavigation, deviceLauncherMode } from './device-navigation.mjs';
import { observeHostTheme, readHostTheme } from './device-theme.mjs';
import { DeviceLoading } from './device-loading.jsx';

/** The desktop shell keeps its local page and unsent drafts mounted. */
export function DeviceLauncher({ compact = false, label = '' }) {
  const [url, setUrl] = useState(''), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const dialog = useRef(null), frame = useRef(null), gate = useRef(false);
  const [navigation, setNavigation] = useState(null);
  const [integratedNavigation, setIntegratedNavigation] = useState(false);
  const navigationController = useRef(null);
  const mode = deviceLauncherMode();
  const [frameReady, setFrameReady] = useState(false);
  const [theme, setTheme] = useState(() => readHostTheme());
  useEffect(() => observeHostTheme(setTheme), []);
  const syncTheme = () => { if (url) frame.current?.contentWindow?.postMessage({ type: 'dsh-devices:theme', theme, background: globalThis.getComputedStyle?.(dialog.current)?.backgroundColor }, new URL(url).origin); };
  useEffect(syncTheme, [url, theme]);
  useEffect(() => {
    const controller = connectDeviceNavigation({ onChange: setNavigation, ready: compact });
    navigationController.current = controller;
    return () => { controller.dispose(); navigationController.current = null; };
  }, [compact]);
  useEffect(() => {
    if (!dialog.current) return;
    if (open && !dialog.current.open) dialog.current.showModal();
    else if (!open && dialog.current.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    if (!url) return;
    const returned = event => {
      if (event.source !== frame.current?.contentWindow || event.origin !== new URL(url).origin) return;
      if (event.data?.type === 'dsh-devices:theme-ready') syncTheme();
      if (event.data?.type === 'dsh-devices:return-local') setOpen(false);
      if (event.data?.type === 'dsh-devices:workbench-navigation') setIntegratedNavigation(event.data.ready === true);
    };
    window.addEventListener('message', returned);
    return () => window.removeEventListener('message', returned);
  }, [url, theme]);
  const launch = async () => {
    if (gate.current) return;
    if (navigation) { navigationController.current?.showDevices(); return; }
    setOpen(true); setError('');
    if (url) return;
    gate.current = true; setBusy(true);
    try {
      const requestUrl = new URL('api/commander-devices', document.baseURI);
      const response = await fetch(requestUrl, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch', parentOrigin: location.origin }) });
      const value = await readJsonResponse(response, requestUrl);
      if (value.error) throw new Error(typeof value.error === 'string' ? value.error : value.error.message || '设备中心暂时无法打开');
      const target = new URL(value.url, location.origin);
      const local = target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
      const hosted = target.origin === location.origin && target.protocol === 'https:' && target.pathname.startsWith('/devices/');
      if (!(mode === 'cloud' ? hosted : local || hosted)) throw new Error('设备中心地址无效');
      target.searchParams.set('parentOrigin', location.origin); target.searchParams.set('theme', theme); setUrl(target.href);
    } catch (reason) { setError(reason.message); } finally { gate.current = false; setBusy(false); }
  };
  if (mode === 'remote' && !navigation) return null;
  return <><button type="button" className={`cmd-search-toggle dsh-device-launcher${compact ? ' dsh-device-launcher-compact' : ''}`} aria-label={navigation ? `切换设备：${navigation.name}` : '设备中心'} title={navigation?.name || '设备中心'} aria-haspopup={navigation ? undefined : 'dialog'} onClick={launch}><UIIcon name="link" size={16} />{label}{compact && <UIIcon name="chevronDown" size={10} />}</button>{createPortal(<dialog ref={dialog} className="dsh-device-dialog" data-theme={theme} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}><style>{'.dsh-device-dialog{position:fixed;inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#202020);color-scheme:light}.dsh-device-dialog::backdrop{background:#10182088}.dsh-device-dialog[open]{display:flex;flex-direction:column}.dsh-device-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;min-height:38px;padding:5px max(14px,env(safe-area-inset-right)) 5px max(14px,env(safe-area-inset-left));border-bottom:1px solid #8883;background:inherit;font-size:12px;line-height:1.5;font-family:inherit}.dsh-device-dialog-header button,.dsh-device-dialog-error button{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer}.dsh-device-dialog-header button:hover{background:#8882}.dsh-device-dialog iframe{display:block;flex:1;width:100%;min-height:0;border:0}.dsh-device-dialog-error{display:grid;justify-items:center;align-content:center;flex:1;padding:24px;gap:12px;font-size:13px}.dsh-device-dialog-error p{max-width:420px;overflow-wrap:anywhere}.dsh-device-dialog-error button{border:1px solid #8884}.dsh-device-dialog :focus-visible{outline:2px solid #2c6ee8;outline-offset:2px}@media(max-width:767px){.dsh-device-dialog-header.dsh-device-dialog-integrated{display:none}}.dsh-device-dialog[data-theme=dark]{background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#ededed);color-scheme:dark}'}</style><header className={`dsh-device-dialog-header${integratedNavigation ? ' dsh-device-dialog-integrated' : ''}`}><span>设备中心</span><button type="button" aria-label="关闭设备中心" onClick={() => setOpen(false)}><UIIcon name="close" size={14} />返回工作台</button></header>{url ? <><div hidden={frameReady}><DeviceLoading label="正在打开设备中心…" /></div><iframe ref={frame} style={frameReady ? undefined : { position: 'absolute', visibility: 'hidden' }} src={url} title="小角设备中心" allow="clipboard-read; clipboard-write; microphone" referrerPolicy="no-referrer" onLoad={() => { setFrameReady(true); setIntegratedNavigation(false); syncTheme(); }} /></> : <div className="dsh-device-dialog-error">{!error && <DeviceLoading label="正在打开设备中心…" />}<p hidden={!error} role={error ? 'alert' : 'status'}>{error || (busy ? '正在打开设备中心…' : '准备打开设备中心')}</p>{error && mode !== 'remote' && <button type="button" onClick={launch} disabled={busy}>重试</button>}</div>}</dialog>, document.body)}</>;
}
