import React, { useEffect, useRef, useState } from 'react';
import { UIIcon } from '../../commander/client/iconsax.jsx';
import { managementCall as call } from './api.mjs';
import { PairQr } from './qr.jsx';
import css from './style.css';


export function useLinkStyle() {
  useEffect(() => { if (document.getElementById('dsh-link-style')) return; const node = document.createElement('style'); node.id = 'dsh-link-style'; node.textContent = css; document.head.append(node); return () => node.remove(); }, []);
}
export function Button({ children, icon, onClick, disabled, kind = 'quiet', type = 'button' }) {
  return <button type={type} className={`link-button link-button-${kind}`} onClick={onClick} disabled={disabled}>{icon && <UIIcon name={icon} size={16} />}{children}</button>;
}
export function StatusDot({ state }) { return <span className={`link-status-dot link-status-${state}`} aria-hidden="true" />; }
export function ErrorText({ children }) { return children ? <p className="link-error" role="alert">{children}</p> : null; }

export function LinkSettings({ ctx }) {
  useLinkStyle();
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [pairing, setPairing] = useState(null);
  const [form, setForm] = useState({ enabled: false, host: '0.0.0.0', port: 48721, publicUrl: '' });
  const [busy, setBusy] = useState(false), [mode, setMode] = useState('lan'), [lanAddress, setLanAddress] = useState('');
  const refresh = async (syncForm = false, signal) => {
    const value = await call('status', {}, signal); setStatus(value);
    if (syncForm) setForm({ enabled: !!value.enabled, host: value.host || '0.0.0.0', port: value.port || 48721, publicUrl: value.publicUrl || '' });
  };
  useEffect(() => {
    const controller = new AbortController(); let timer;
    const poll = async (first = false) => { try { await refresh(first, controller.signal); } catch (e) { if (!controller.signal.aborted) setError(e.message); } finally { if (!controller.signal.aborted) timer = setTimeout(() => poll(), 1500); } };
    poll(true); return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const configure = async event => { event.preventDefault(); setBusy(true); setError(''); try { await call('configure', { ...form, port: Number(form.port) }); await refresh(true); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const beginPairing = async () => { setBusy(true); setError(''); try { setPairing(await call('pairing', { mode, ...(mode === 'lan' && lanAddress ? { address: lanAddress } : {}) })); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const confirm = async (id, action) => { setBusy(true); try { await call(action, { id }); setStatus(await call('status')); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  return <section className="link-settings" aria-label="Link 远程连接">
    <div className="link-heading"><span className="link-kicker">LINK / REMOTE</span><h2>让你的工作台，<em>在身边。</em></h2><p>把会话带到可信的设备上。局域网直连优先，公网地址由你掌握。</p></div>
    <form className="link-form" onSubmit={configure}>
      <div className="link-field link-toggle-field"><div><label htmlFor="link-enabled">启用 Link</label><small>配对设备可操作已注册项目、发送指令和审批；随时可撤销。</small></div><input id="link-enabled" type="checkbox" checked={form.enabled} onChange={e => setForm(v => ({ ...v, enabled: e.target.checked }))} /></div>
      <label className="link-field"><span>监听地址</span><input value={form.host} onChange={e => setForm(v => ({ ...v, host: e.target.value }))} placeholder="0.0.0.0" /></label>
      <label className="link-field"><span>端口</span><input inputMode="numeric" value={form.port} onChange={e => setForm(v => ({ ...v, port: e.target.value }))} /></label>
      <label className="link-field link-field-wide"><span>公网 HTTPS 地址 <small>可选</small></span><input value={form.publicUrl} onChange={e => setForm(v => ({ ...v, publicUrl: e.target.value }))} placeholder="https://desk.example.com" /></label>
      <div className="link-form-actions"><Button kind="primary" icon="tickCircle" disabled={busy} type="submit">保存连接</Button><Button icon="refresh" onClick={() => refresh().catch(e => setError(e.message))} disabled={busy}>刷新状态</Button></div>
    </form>
    <ErrorText>{error}</ErrorText>
    {status && <div className="link-status-panel"><div className="link-panel-head"><div><span className="link-kicker">HOST STATUS</span><h3>{status.hostName || '本机工作台'}</h3></div><span className="link-online"><StatusDot state={status.error ? 'failed' : status.enabled ? 'running' : 'idle'} />{status.error || (status.enabled ? '可连接' : '未启用')}</span></div><div className="link-addresses">{(status.addresses || []).map(address => <code key={address}>{address}</code>)}{status.publicUrl && <code>{status.publicUrl}</code>}</div></div>}
    <div className="link-pair-row"><div><span className="link-kicker">PAIRING</span><h3>连接一台新设备</h3><p>二维码只在短时间内有效，桌面确认后才会签发设备凭据。</p></div><div className="link-mode-actions">{mode === 'lan' && status?.addresses?.length > 1 && <select aria-label="局域网地址" value={lanAddress} onChange={e => setLanAddress(e.target.value)}><option value="">自动选择地址</option>{status.addresses.map(address => <option key={address} value={address}>{address}</option>)}</select>}<select aria-label="连接方式" value={mode} onChange={e => setMode(e.target.value)}><option value="lan">局域网 · Android App</option><option value="public" disabled={!status?.publicUrl}>公网 · HTTPS</option></select><Button kind="primary" icon="scan" onClick={beginPairing} disabled={busy || !status?.enabled}>生成配对码</Button></div></div>
    {pairing && <PairingDialog pairing={pairing} pending={status?.pending || []} onClose={() => setPairing(null)} onConfirm={confirm} busy={busy} />}
    {!!status?.pending?.length && !pairing && <div className="link-pending-list">{status.pending.map(device => <div className="link-device" key={device.id}><div><strong>{device.name || '新设备'}</strong><small>请求连接工作台</small></div><Button kind="primary" onClick={() => confirm(device.id, 'confirm')} disabled={busy}>允许</Button><Button onClick={() => confirm(device.id, 'reject')} disabled={busy}>拒绝</Button></div>)}</div>}
    <div className="link-device-list"><div className="link-panel-head"><div><span className="link-kicker">DEVICES</span><h3>已配对设备</h3></div><span>{status?.devices?.length || 0} 台</span></div>{status?.devices?.length ? status.devices.map(device => <div className="link-device" key={device.id}><StatusDot state="running" /><div><strong>{device.name || '未命名设备'}</strong><small>最近连接 {formatTime(device.lastSeenAt)}</small></div><Button icon="trash" onClick={() => confirm(device.id, 'revoke')} disabled={busy}>撤销</Button></div>) : <p className="link-empty">还没有配对设备。</p>}</div>
  </section>;
}
function PairingDialog({ pairing, pending, onClose, onConfirm, busy }) {
  const dialog = useRef(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.querySelector('button')?.focus();
    const keydown = event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const elements = [...dialog.current.querySelectorAll('button:not(:disabled), a[href]')];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown); return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return <div className="link-dialog-backdrop" role="presentation"><div ref={dialog} className="link-dialog" role="dialog" aria-modal="true" aria-label="设备配对"><button className="link-dialog-close" onClick={onClose} aria-label="关闭"><UIIcon name="closeCircle" size={20} /></button><span className="link-kicker">ONE-TIME PAIRING</span><h3>扫描，然后确认。</h3><p>让手机扫描此二维码；不要把它发给不认识的人。</p><PairQr value={pairing.webUrl || pairing.uri} />{pairing.webUrl && <a className="link-pair-open" href={pairing.webUrl} target="_blank" rel="noreferrer">打开配对页面</a>}<Button onClick={() => navigator.clipboard?.writeText(pairing.uri).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? 'App 地址已复制' : '复制 App 配对地址'}</Button><code className="link-pair-code">{pairing.code}</code><small className="link-expiry">有效期至 {formatTime(pairing.expiresAt)}</small><div className="link-pending-list">{pending.map(device => <div className="link-device" key={device.id}><div><strong>{device.name || '新设备'}</strong><small>等待桌面确认</small></div><div><Button kind="primary" onClick={() => onConfirm(device.id, 'confirm')} disabled={busy}>允许</Button><Button onClick={() => onConfirm(device.id, 'reject')} disabled={busy}>拒绝</Button></div></div>)}</div></div></div>;
}

function formatTime(value) { if (!value) return '刚刚'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
export function mountLinkSettings(ctx) { ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'link', order: 34, label: () => '远程连接', inject: () => ({ ctx }) }, LinkSettings)); }
