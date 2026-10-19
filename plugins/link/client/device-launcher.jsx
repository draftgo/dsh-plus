import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../commander/client/iconsax.jsx';

/** The desktop shell keeps its local page and unsent drafts mounted. */
export function DeviceLauncher() {
  const [url, setUrl] = useState(''), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const dialog = useRef(null), frame = useRef(null), gate = useRef(false);
  const remote = Boolean(globalThis.__DSH_TRANSPORT__);
  useEffect(() => {
    if (!dialog.current) return;
    if (open && !dialog.current.open) dialog.current.showModal();
    else if (!open && dialog.current.open) dialog.current.close();
  }, [open]);
  useEffect(() => {
    if (!url) return;
    const returned = event => {
      if (event.source !== frame.current?.contentWindow || event.origin !== new URL(url).origin) return;
      if (event.data?.type === 'dsh-devices:return-local') setOpen(false);
    };
    window.addEventListener('message', returned);
    return () => window.removeEventListener('message', returned);
  }, [url]);
  const launch = async () => {
    if (gate.current) return;
    setOpen(true); setError('');
    if (url) return;
    gate.current = true; setBusy(true);
    try {
      const response = await fetch(new URL('api/commander-devices', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'launch', parentOrigin: location.origin }) });
      const value = await response.json().catch(() => ({}));
      if (!response.ok || value.error) throw new Error(value.error || '设备中心暂时无法打开');
      const target = new URL(value.url);
      if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('本机设备中心地址无效');
      target.searchParams.set('parentOrigin', location.origin); setUrl(target.href);
    } catch (reason) { setError(reason.message); } finally { gate.current = false; setBusy(false); }
  };
  if (remote) return null;
  return <><button type="button" className="cmd-search-toggle" aria-label="设备" title="设备" aria-haspopup="dialog" onClick={launch}><UIIcon name="link" size={16} /></button>{createPortal(<dialog ref={dialog} className="dsh-device-dialog" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}><style>{'.dsh-device-dialog{position:fixed;inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#fffdf8;color:inherit}.dsh-device-dialog::backdrop{background:#10182088}.dsh-device-dialog[open]{display:flex;flex-direction:column}.dsh-device-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;min-height:38px;padding:5px max(14px,env(safe-area-inset-right)) 5px max(14px,env(safe-area-inset-left));border-bottom:1px solid #8883;background:var(--dsr-bg,#fffdf8);font-size:12px;line-height:1.5;font-family:inherit}.dsh-device-dialog-header button,.dsh-device-dialog-error button{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer}.dsh-device-dialog-header button:hover{background:#8882}.dsh-device-dialog iframe{display:block;flex:1;width:100%;min-height:0;border:0}.dsh-device-dialog-error{display:grid;justify-items:center;align-content:center;flex:1;padding:24px;gap:12px;font-size:13px}.dsh-device-dialog-error p{max-width:420px;overflow-wrap:anywhere}.dsh-device-dialog-error button{border:1px solid #8884}.dsh-device-dialog :focus-visible{outline:2px solid #2c6ee8;outline-offset:2px}@media(prefers-color-scheme:dark){.dsh-device-dialog{background:#171b1d;color:#edf2f0}.dsh-device-dialog-header{background:#171b1d}}'}</style><header className="dsh-device-dialog-header"><span>设备中心</span><button type="button" aria-label="返回本机工作台" onClick={() => setOpen(false)}><UIIcon name="close" size={14} />返回本机</button></header>{url ? <iframe ref={frame} src={url} title="小角设备中心" allow="clipboard-read; clipboard-write; microphone" referrerPolicy="no-referrer" /> : <div className="dsh-device-dialog-error"><p role={error ? 'alert' : 'status'}>{error || (busy ? '正在打开设备中心…' : '准备打开设备中心')}</p>{error && <button type="button" onClick={launch} disabled={busy}>重试</button>}</div>}</dialog>, document.body)}</>;
}
