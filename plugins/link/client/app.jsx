import { Select } from '../../shared/client/select.jsx';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UIIcon } from '../../commander/client/iconsax.jsx';
import { managementCall as call } from './api.mjs';
import { PairQr } from './qr.jsx';
import { connectionDefaults } from './connection-mode.mjs';
import { CloudAccessSettings } from './cloud-access.jsx';
import css from './style.css';
import { deviceIcon } from './device-state.mjs';
import { DeviceLoading } from './device-loading.jsx';


export function useLinkStyle() {
  useEffect(() => { if (document.getElementById('dsh-link-style')) return; const node = document.createElement('style'); node.id = 'dsh-link-style'; node.textContent = css; document.head.append(node); return () => node.remove(); }, []);
}
export function Button({ children, icon, onClick, disabled, kind = 'quiet', type = 'button' }) {
  return <button type={type} className={`link-button link-button-${kind}`} onClick={onClick} disabled={disabled}>{icon && <UIIcon name={icon} size={16} />}{children}</button>;
}
export function StatusDot({ state }) { return <span className={`link-status-dot link-status-${state}`} aria-hidden="true" />; }
export function ErrorText({ children }) { return children ? <p className="link-error" role="alert">{children}</p> : null; }

export function LinkSettings({ ctx, management = call, embedded = false }) {
  useLinkStyle();
  const defaults = useRef(connectionDefaults(globalThis.location)).current;
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [pairing, setPairing] = useState(null);
  const [form, setForm] = useState({ host: '0.0.0.0', port: 48721, publicUrl: defaults.publicUrl });
  const [busy, setBusy] = useState(''), [mode, setMode] = useState(defaults.mode), [lanAddress, setLanAddress] = useState('');
  const [statusError, setStatusError] = useState(''), [loading, setLoading] = useState(true), [diagnostic, setDiagnostic] = useState('');
  const request = useRef(0), initialized = useRef(false), retryPolling = useRef(null);
  const applyStatus = (value, syncForm = false) => {
    setStatus(value);
    if (!value.enabled) setPairing(null);
    if (syncForm || !initialized.current) {
      setForm({ host: value.host || '0.0.0.0', port: value.port ?? 48721, publicUrl: value.publicUrl || defaults.publicUrl });
      initialized.current = true;
    }
  };
  const refresh = async (syncForm = false, signal) => {
    const id = ++request.current, value = await management('status', {}, signal);
    if (id === request.current) { applyStatus(value, syncForm); setStatusError(''); setDiagnostic(''); setLoading(false); }
    return value;
  };
  useEffect(() => {
    const controller = new AbortController(); let timer;
    const poll = async () => {
      let succeeded = false;
      try { await refresh(false, controller.signal); succeeded = true; }
      catch (e) { if (!controller.signal.aborted) { setStatusError(e.message); setDiagnostic(e.detail || ''); setLoading(false); setPairing(null); } }
      finally { if (!controller.signal.aborted && succeeded) timer = setTimeout(poll, 10_000); }
    };
    const retry = async () => { clearTimeout(timer); await poll(); };
    retryPolling.current = retry;
    poll(); return () => { retryPolling.current = null; controller.abort(); clearTimeout(timer); };
  }, []);
  useEffect(() => { if (lanAddress && !status?.addresses?.includes(lanAddress)) setLanAddress(''); }, [status?.addresses, lanAddress]);
  const saveConfig = async (input, syncForm = false) => {
    setPairing(null);
    const value = await management('configure', input);
    ++request.current; applyStatus(value, syncForm);
    return value;
  };
  const configure = async event => { event.preventDefault(); setBusy('saving'); setError(''); try { await saveConfig({ ...form, port: Number(form.port) }, true); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const toggle = async enabled => { setBusy('toggle'); setError(''); try { await saveConfig({ enabled }); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const beginPairing = async () => {
    if (loading || !status || statusError) return;
    setBusy('pairing'); setError(''); setPairing(null);
    try {
      const publicUrl = status.publicUrl || defaults.publicUrl;
      const current = !status.enabled || (mode === 'public' && !status.publicUrl && publicUrl) ? await saveConfig({ enabled: true, ...(mode === 'public' && publicUrl ? { publicUrl } : {}) }) : status;
      const address = mode === 'lan' && current.addresses?.includes(lanAddress) ? lanAddress : '';
      setPairing(await management('pairing', { mode, ...(address ? { address } : {}) }));
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const confirm = async (id, action) => { setBusy(action); setError(''); try { const value = await management(action, { id }); ++request.current; applyStatus(value); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const refreshStatus = async () => { setBusy('refresh'); setLoading(true); setError(''); try { if (retryPolling.current) await retryPolling.current(); else await refresh(); } catch (e) { setStatusError(e.message); setDiagnostic(e.detail || ''); setPairing(null); } finally { setBusy(''); setLoading(false); } };
  const unavailable = !!busy || loading || !status || !!statusError;
  if (loading && !status && !statusError) return <section className="link-settings"><DeviceLoading label="正在读取连接状态…" skeleton /></section>;
  return <section className="link-settings" aria-label="Link 远程连接">
    {!embedded && <div className="link-heading"><h2>允许其他设备连接</h2></div>}
    <div className="link-status-panel"><div className="link-panel-head"><div><h3>{status?.hostName || globalThis.location?.hostname || '本机工作台'}</h3><span className="link-online" role="status"><StatusDot state={statusError || status?.error ? 'failed' : status?.enabled ? 'running' : 'idle'} />{loading ? '正在连接…' : statusError ? '服务待就绪' : status?.error ? '暂不可用' : status?.enabled ? '已启用' : '未启用'}</span></div><div className="link-host-actions">{statusError && <Button icon="refresh" onClick={refreshStatus} disabled={!!busy}>{loading ? '重试中…' : '重试'}</Button>}<div className="link-toggle-field"><label className="link-sr-only" htmlFor="link-enabled">启用 Link</label><input id="link-enabled" type="checkbox" checked={!!status?.enabled} disabled={unavailable} onChange={e => toggle(e.target.checked)} /></div></div></div></div>
    <div className="link-pair-row"><div><h3>允许其他设备连接</h3><p>{mode !== 'lan' ? '其他设备扫码或粘贴连接信息，回到这里批准。' : '同一网络内扫码或粘贴连接信息，回到这里批准。'}</p></div><Button kind="primary" icon="scan" onClick={beginPairing} disabled={unavailable || (mode === 'public' && !status.publicUrl && !defaults.publicUrl) || (mode === 'relay' && !status?.relay?.connected)}>{busy === 'pairing' ? '正在准备…' : '生成连接信息'}</Button></div>
    <ErrorText>{error || statusError || status?.error}</ErrorText>
    {diagnostic && <details className="link-error-detail"><summary>查看详情</summary><p>{diagnostic}</p></details>}
    <details className="link-advanced"><summary>高级设置</summary><p className="link-advanced-note">{defaults.mode === 'public' ? '已根据当前工作台域名优先使用 HTTPS 连接。也可手动改为同网络连接。' : '默认使用同网络 Android App 扫码，无需公网或手动选择地址。浏览器连接需可达的 HTTPS 地址。'}</p>
    {<CloudAccessSettings management={management} value={status?.cloudAccess} loading={loading} failed={!!statusError} onRetry={refreshStatus} onChanged={value => { ++request.current; applyStatus(value); }} disabled={unavailable} />}
      <form className="link-form" onSubmit={configure}>
        <label className="link-field"><span>监听地址</span><input value={form.host} onChange={e => setForm(v => ({ ...v, host: e.target.value }))} placeholder="0.0.0.0" disabled={unavailable} /></label>
        <label className="link-field"><span>端口</span><input inputMode="numeric" value={form.port} onChange={e => setForm(v => ({ ...v, port: e.target.value }))} disabled={unavailable} /></label>
        <label className="link-field link-field-wide"><span>公网 HTTPS 地址 <small>可选，需自行配置有效证书，并确保手机可以访问。</small></span><input value={form.publicUrl} onChange={e => setForm(v => ({ ...v, publicUrl: e.target.value }))} placeholder="https://desk.example.com" disabled={unavailable} /></label>
        <div className="link-form-actions"><Button kind="primary" icon="check" disabled={unavailable} type="submit">{busy === 'saving' ? '正在保存…' : '保存高级设置'}</Button></div>
      </form>
      <div className="link-advanced-controls"><label className="link-field"><span>连接方式</span><Select aria-label="连接方式" value={mode} disabled={unavailable} onChange={e => { setMode(e.target.value); setPairing(null); }}><option value="lan">同网络 · Android Link App</option><option value="public" disabled={!status?.publicUrl && !defaults.publicUrl}>公网 · HTTPS 浏览器</option>{status?.relay?.configured && <option value="relay" disabled={!status.relay.connected}>自有中继 · HTTPS 浏览器</option>}</Select></label>
        {mode === 'lan' && status?.addresses?.length > 1 && <label className="link-field"><span>手动指定连接地址 <small>通常保持自动即可；连接失败时再尝试其他地址。</small></span><Select aria-label="局域网地址" value={lanAddress} disabled={unavailable} onChange={e => { setLanAddress(e.target.value); setPairing(null); }}><option value="">自动选择地址</option>{status.addresses.map(address => <option key={address} value={address}>{address}</option>)}</Select></label>}
      </div>
      <div className="link-diagnostics"><div className="link-panel-head"><h4>连接诊断</h4><Button icon="refresh" onClick={refreshStatus} disabled={!!busy}>{busy === 'refresh' ? '正在刷新…' : '刷新状态'}</Button></div><p>Link 运行在哪台电脑，就连接哪台电脑。云服务器不属于手机本地局域网，请使用受信任的 HTTPS 地址；本地连接失败时，检查同一 Wi-Fi、网络隔离和电脑防火墙。</p>{status?.relay?.configured && <p role="status">自有中继：{status.relay.connected ? '主机通道已连接（需从访问端验证可达性）' : status.relay.lastError || '正在连接…'}</p>}<div className="link-addresses">{(status?.addresses || []).map(address => <code key={address}>{address}</code>)}{status?.publicUrl && <code>{status.publicUrl}</code>}{status && !status.addresses?.length && <span>未发现可用连接地址，请检查网络或指定监听地址。</span>}</div></div>
    </details>
    {pairing && <PairingDialog pairing={pairing} pending={status?.pending || []} onClose={() => setPairing(null)} onConfirm={confirm} busy={busy} />}
    {!!status?.pending?.length && !pairing && <div className="link-pending-list">{status.pending.map(device => <div className="link-device" key={device.id}><div><strong>{device.name || '新设备'}</strong><small>请求连接工作台</small></div><Button kind="primary" icon="check" onClick={() => confirm(device.id, 'confirm')} disabled={unavailable}>允许</Button><Button icon="close" onClick={() => confirm(device.id, 'reject')} disabled={unavailable}>拒绝</Button></div>)}</div>}
    <div className="link-device-list"><div className="link-panel-head"><div><h3>已授权访问此设备</h3></div><span>{status ? `${status.devices?.length || 0} 台` : '—'}</span></div>{status?.devices?.length ? status.devices.map(device => <div className="link-device" key={device.id}><UIIcon name={deviceIcon(device)} size={18} /><div><strong>{device.name || '未命名设备'}</strong><small>最近连接 {formatTime(device.lastSeenAt)}</small></div><Button icon="trash" onClick={() => confirm(device.id, 'revoke')} disabled={unavailable}>撤销</Button></div>) : <p className="link-empty">{loading ? '正在连接…' : statusError ? '暂不可用' : '还没有配对设备'}</p>}</div>
  </section>;
}
export function PairingDialog({ pairing, pending, onClose, onConfirm, busy }) {
  const dialog = useRef(null), close = useRef(onClose);
  close.current = onClose;
  const titleId = useId(), descriptionId = useId();
  const [feedback, setFeedback] = useState(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector('button')?.focus();
    const keydown = event => {
      if (event.isComposing || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) close.current();
      }
      if (event.key === 'Tab' && dialog.current) {
        // This is a body portal above the settings modal; keep its keyboard
        // listener from pulling focus back into the settings behind it.
        event.stopPropagation();
        const elements = [...dialog.current.querySelectorAll('button:not(:disabled), a[href], summary, [tabindex="0"]')].filter(element => !element.closest('details:not([open])') || element.tagName === 'SUMMARY');
        const first = elements[0] || dialog.current, last = elements.at(-1) || first;
        if (!dialog.current.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  const publicPairing = pairing.mode === 'public' || pairing.mode === 'relay';
  const copy = async (value, label) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setFeedback({ ok: true, text: label + '已复制' });
    } catch { setFeedback({ ok: false, text: '复制失败，请检查浏览器剪贴板权限后重试。' }); }
  };
  return createPortal(<div className="link-dialog-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="link-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <button type="button" className="link-dialog-close" onClick={onClose} aria-label="关闭配对窗口"><UIIcon name="close" size={20} /></button>
      <span className="link-dialog-symbol"><UIIcon name="scan" size={24} /></span>
      <h3 id={titleId}>连接此设备</h3>
      <p id={descriptionId}>{publicPairing ? '在其他设备扫码打开，或粘贴连接信息，再回到这里允许连接。' : '在同一网络的设备上扫码，或复制连接信息到设备中心，再回到这里允许连接。'}</p>
      <PairQr value={publicPairing ? pairing.webUrl : pairing.uri} size={224} />
      {publicPairing && pairing.webUrl && <a className="link-pair-open" href={pairing.webUrl} target="_blank" rel="noreferrer">打开配对页面 <UIIcon name="external" size={14} /></a>}
      <small className="link-expiry">有效期至 {formatTime(pairing.expiresAt)}</small>
      <p className="link-pair-warning">仅授权你信任的设备，不要分享此二维码。</p>
      <div className="link-pair-backup">
        <p className="link-pair-backup-note">在其他设备的“添加设备”中粘贴连接信息。短码需结合主机地址使用。</p>
        <code className="link-pair-code" aria-label="配对码预览">{pairing.code}</code>
        <div className="link-pair-backup-actions"><Button icon="copy" onClick={() => copy(pairing.code, '完整配对码')}>复制完整配对码</Button><Button icon="link" onClick={() => copy(publicPairing ? pairing.webUrl || pairing.uri : pairing.uri, '连接信息')}>复制连接信息</Button></div>
        <p className={feedback?.ok === false ? 'link-copy-feedback link-error' : 'link-copy-feedback'} role="status" aria-live="polite">{feedback?.text || '配对码仅在本次有效期内可用。'}</p>
      </div>
      {!!pending.length && <div className="link-pending-list">{pending.map(device => <div className="link-device" key={device.id}><div className="link-device-info"><strong>{device.name || '新设备'}</strong><small>等待此设备确认</small></div><div className="link-device-actions"><Button kind="primary" icon="check" onClick={() => onConfirm(device.id, 'confirm')} disabled={!!busy}>允许</Button><Button icon="close" onClick={() => onConfirm(device.id, 'reject')} disabled={!!busy}>拒绝</Button></div></div>)}</div>}
    </div>
  </div>, document.body);
}

function formatTime(value) { if (!value) return '刚刚'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
