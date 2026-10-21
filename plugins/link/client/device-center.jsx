import { Select } from '../../shared/client/select.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { UIIcon } from '../../commander/client/iconsax.jsx';
import { deviceRuntime } from './device-runtime.mjs';
import { deviceIcon, deviceKind, deviceStatus, jobFailed, jobFinished, sshInput, workbenchUrl } from './device-state.mjs';
import { workbenchNavigationMessage } from './device-navigation.mjs';
import { LinkSettings, useLinkStyle } from './app.jsx';
import css from './device-center.css';
import { DeviceLoading } from './device-loading.jsx';

function Button({ children, icon, primary, danger, ...props }) { return <button type="button" className={`dc-button ${primary ? 'dc-primary' : ''} ${danger ? 'dc-danger' : ''}`} {...props}>{icon && <UIIcon name={icon} size={16} />}{children}</button>; }
function ErrorLine({ error }) { return error ? <p className="dc-error" role="alert">{error}</p> : null; }
function Field({ label, children, full }) { return <label className={`dc-field ${full ? 'dc-field-full' : ''}`}><span>{label}</span>{children}</label>; }

function Sheet({ title, children, onClose, busy }) {
  const box = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    box.current?.querySelector('input,button,textarea,select')?.focus();
    const key = event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const items = [...box.current.querySelectorAll('button,input,textarea,select,a[href]')].filter(item => !item.disabled && item.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus?.(); };
  }, [onClose, busy]);
  return <div className="dc-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="dc-sheet" role="dialog" aria-modal="true" aria-labelledby="dc-dialog-title" ref={box}><header><h2 id="dc-dialog-title">{title}</h2><Button icon="close" aria-label="关闭" onClick={onClose} disabled={busy} /></header>{children}</section></div>;
}

function AddComputer({ runtime, onAdded }) {
  const [uri, setUri] = useState(''), [error, setError] = useState(''), [phase, setPhase] = useState('idle');
  const operation = useRef(0), timer = useRef(), mounted = useRef(true), lastScan = useRef(''), inFlight = useRef('');
  const connect = useCallback(async input => {
    if (!input.trim()) { setError('请粘贴目标设备的连接信息'); return; }
    if (inFlight.current === input.trim()) return;
    inFlight.current = input.trim();
    const generation = ++operation.current; clearTimeout(timer.current); setError(''); setPhase('sending'); setUri(input);
    try {
      const result = await runtime.call('pair', { uri: input.trim(), name: runtime.clientName() });
      if (!mounted.current || operation.current !== generation) return;
      setPhase('pending');
      const poll = async () => {
        try {
          const status = await runtime.call('pairStatus', { requestId: result.requestId });
          if (!mounted.current || operation.current !== generation) return;
          if (status.status === 'approved') { setPhase('approved'); await onAdded(status.device); return; }
          if (['rejected', 'expired', 'revoked'].includes(status.status)) throw new Error(status.status === 'rejected' ? '目标设备未允许连接，请生成新的连接信息' : '配对已过期，请重新扫码或粘贴地址');
          timer.current = setTimeout(poll, 1500);
        } catch (reason) { if (mounted.current && operation.current === generation) { inFlight.current = ''; setError(reason.message); setPhase('failed'); } }
      };
      timer.current = setTimeout(poll, 700);
    } catch (reason) { if (mounted.current && operation.current === generation) { inFlight.current = ''; setError(reason.message); setPhase('failed'); } }
  }, [runtime, onAdded]);
  useEffect(() => {
    mounted.current = true;
    const scanned = () => {
      const identity = runtime.bootstrap?.();
      if (!identity?.code || identity.token) return;
      const next = runtime.contextUri(identity);
      if (!next || lastScan.current === next) return;
      lastScan.current = next; void connect(next);
    };
    window.addEventListener('link:bootstrap', scanned); scanned();
    return () => { mounted.current = false; operation.current++; clearTimeout(timer.current); window.removeEventListener('link:bootstrap', scanned); };
  }, [connect, runtime]);
  const waiting = ['sending', 'pending', 'approved'].includes(phase);
  return <><p className="dc-note">在目标设备的设备中心切换到“连接”，生成连接信息。连接需由对方批准。</p><form onSubmit={event => { event.preventDefault(); if (!waiting) void connect(uri); }}><Field label="连接信息"><textarea autoCapitalize="off" autoCorrect="off" spellCheck={false} rows={3} placeholder="dshlink://pair?…" value={uri} disabled={waiting} onChange={event => { setUri(event.target.value); setError(''); }} /></Field><ErrorLine error={error} />{waiting && <p className="dc-progress-message" role="status"><i className="dc-spinner" />{phase === 'sending' ? '正在发送连接请求…' : phase === 'approved' ? '已允许，正在打开…' : '请在目标设备上允许连接'}</p>}<div className="dc-actions">{runtime.isNative() && <Button icon="scan" onClick={() => runtime.scan()} disabled={phase === 'sending'}>扫码连接</Button>}<Button type="submit" primary disabled={waiting || !uri.trim()}>{phase === 'failed' ? '重试连接' : '连接设备'}</Button></div></form></>;
}

const emptyServer = () => ({ name: '', host: '', port: '22', username: '', auth: 'password', password: '', privateKey: '', passphrase: '', source: 'mirror' });
function Credentials({ form, setForm, disabled }) {
  const field = key => ({ value: form[key], disabled, onChange: event => setForm(value => ({ ...value, [key]: event.target.value })) });
  return <><Field label="认证方式" full><Select {...field('auth')}><option value="password">密码</option><option value="key">SSH 私钥</option></Select></Field>{form.auth === 'password' ? <Field label="密码" full><input type="password" autoComplete="off" {...field('password')} /></Field> : <><Field label="SSH 私钥" full><textarea rows={4} autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" {...field('privateKey')} /></Field><Field label="私钥口令（可选）" full><input type="password" autoComplete="off" {...field('passphrase')} /></Field></>}</>;
}
function JobProgress({ job }) {
  return <div className="dc-job" aria-live="polite"><ol>{(job.steps || []).map((step, index) => { const item = typeof step === 'string' ? { label: step } : step; return <li key={item.id || index} data-state={item.state || item.status || 'pending'}><span className="dc-step-icon">{['done', 'completed', 'success'].includes(item.state || item.status) ? <UIIcon name="check" size={14} /> : index + 1}</span><div>{item.label || item.name || item.title || item.id}{item.message && <small>{item.message}</small>}</div></li>; })}</ol>{!jobFinished(job) && <p className="dc-progress-message"><i className="dc-spinner" />正在准备服务器工作台…</p>}<ErrorLine error={job.error} /></div>;
}
function useJob(runtime, job, setJob, setError, attempt = 0) {
  useEffect(() => {
    if (!job?.id || jobFinished(job)) return;
    let closed = false, timer;
    const poll = async () => {
      try {
        const next = await runtime.call('job', { jobId: job.id });
        if (!closed) { setError(''); setJob({ ...next, id: next.id || job.id }); if (!jobFinished(next)) timer = setTimeout(poll, 1000); }
      } catch (reason) { if (!closed) setError(reason.message); }
    };
    timer = setTimeout(poll, 400); return () => { closed = true; clearTimeout(timer); };
  }, [runtime, job?.id, job?.state, setJob, setError, attempt]);
}
function AddDevice({ runtime, onAdded, sshAvailable }) {
  const [path, setPath] = useState('existing');
  return <><div className="dc-add-actions" role="group" aria-label="添加方式"><Button primary={path === 'existing'} onClick={() => setPath('existing')}>连接已有设备</Button><Button primary={path === 'server'} disabled={!sshAvailable} onClick={() => setPath('server')}>安装到服务器</Button></div>{!sshAvailable && <p className="dc-footnote">此客户端暂不支持 SSH 安装，请使用桌面客户端。</p>}{path === 'existing' ? <AddComputer runtime={runtime} onAdded={onAdded} /> : <AddServer runtime={runtime} onAdded={onAdded} />}</>;
}
function AddServer({ runtime, onAdded }) {
  const [form, setForm] = useState(emptyServer), [fingerprint, setFingerprint] = useState(''), [job, setJob] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const gate = useRef(false), mounted = useRef(true);
  const [pollAttempt, setPollAttempt] = useState(0);
  useEffect(() => () => { mounted.current = false; }, []);
  useJob(runtime, job, setJob, setError, pollAttempt);
  const submit = async () => {
    if (gate.current) return; gate.current = true; setBusy(true); setError('');
    try {
      const input = sshInput(form);
      if (!fingerprint) { const result = await runtime.call('sshProbe', { host: input.host, port: input.port, username: input.username }); if (mounted.current) setFingerprint(result.fingerprint); }
      else { const result = await runtime.call('sshConnect', { ...input, fingerprint }); if (mounted.current) { setJob({ id: result.jobId, state: 'running', steps: [] }); setForm(value => ({ ...value, password: '', privateKey: '', passphrase: '' })); } }
    } catch (reason) { if (mounted.current) setError(reason.message); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const field = key => ({ value: form[key], disabled: busy, onChange: event => { setForm(value => ({ ...value, [key]: event.target.value })); setFingerprint(''); setError(''); } });
  if (job) return <><p className="dc-note">{form.name || form.host} · SSH 加密隧道</p><JobProgress job={job} />{job.device?.warning && <p className="dc-note" role="status">{job.device.warning}</p>}<ErrorLine error={error} /><p className="dc-footnote">关闭此面板不会中断安装。</p><div className="dc-actions">{jobFailed(job) ? <Button onClick={() => { setJob(null); setFingerprint(''); setError(''); }}>返回重试</Button> : jobFinished(job) ? <Button primary onClick={() => onAdded(job.device)}>打开工作台</Button> : error ? <Button onClick={() => { setError(''); setPollAttempt(value => value + 1); }}>重新检查进度</Button> : null}</div></>;
  return <><p className="dc-note">通过 SSH 安装或连接小角。默认使用加密隧道，无需开放工作台端口。</p><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="dc-form-grid"><Field label="名称（可选）" full><input placeholder="例如：开发服务器" maxLength={100} {...field('name')} /></Field><Field label="服务器地址"><input required placeholder="IP 或域名" autoCapitalize="off" autoCorrect="off" {...field('host')} /></Field><Field label="SSH 端口"><input required inputMode="numeric" type="number" min="1" max="65535" {...field('port')} /></Field><Field label="用户名" full><input required placeholder="例如：ubuntu" autoCapitalize="off" autoCorrect="off" autoComplete="off" {...field('username')} /></Field><Credentials form={form} setForm={setForm} disabled={busy} /><Field label="下载源" full><Select {...field('source')}><option value="mirror">国内加速（默认）</option><option value="github">官方直连</option></Select></Field></div><p className="dc-footnote">密码与私钥仅用于本次连接，不保存在设备列表。</p>{fingerprint && <div className="dc-fingerprint"><strong>确认服务器身份</strong><code>{fingerprint}</code><p>请核对服务器的 SSH 主机指纹。确认后才会认证和安装。</p></div>}<ErrorLine error={error} /><div className="dc-actions"><Button primary type="submit" disabled={busy}>{busy ? '处理中…' : fingerprint ? '确认指纹并连接' : '检查服务器'}</Button></div></form></>;
}

function ManageDevice({ device, runtime, onChanged, onRemoved, onCloseWorkbench, onOpenWorkbench }) {
  const [name, setName] = useState(device.name), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(''), [confirm, setConfirm] = useState(''), [credentials, setCredentials] = useState(emptyServer), [reconnecting, setReconnecting] = useState(false);
  const gate = useRef(false);
  const [job, setJob] = useState(null), [pollAttempt, setPollAttempt] = useState(0);
  useJob(runtime, job, setJob, setError, pollAttempt);
  const working = busy || Boolean(job && !jobFinished(job));
  useEffect(() => { if (job && jobFinished(job) && !jobFailed(job)) void Promise.resolve(onChanged()).catch(reason => setError(reason.message)); }, [job?.state, onChanged]);
  const execute = async (action, args = {}) => {
    if (gate.current) return; gate.current = true; setBusy(true); setError(''); setResult('');
    try {
      const value = await runtime.call(action, { deviceId: device.id, ...args });
      if (action === 'remove') { onRemoved(device.id); return; }
      if (value.jobId) { setJob({ id: value.jobId, state: 'running', steps: [] }); setConfirm(''); setResult(''); return; }
      setResult(typeof value === 'string' ? value : value.logs || value.output || value.message || (value.status ? `服务状态：${value.status}` : '操作已完成')); setConfirm(''); await onChanged();
    } catch (reason) { setError(reason.message); } finally { gate.current = false; setBusy(false); }
  };
  return <><p className="dc-note">{deviceKind(device)} · {deviceStatus(device)}</p><form onSubmit={event => { event.preventDefault(); void execute('rename', { name: name.trim() }); }}><Field label="设备名称"><input value={name} maxLength={100} onChange={event => setName(event.target.value)} disabled={working || device.kind === 'local'} /></Field>{device.kind !== 'local' && <div className="dc-actions"><Button type="submit" disabled={working || !name.trim() || name.trim() === device.name}>保存名称</Button></div>}</form>{device.kind === 'ssh' && <section className="dc-management"><h3>服务器</h3><div className="dc-service-actions">{[['status', '状态'], ['start', '启动'], ['restart', '重启'], ['stop', '停止'], ['logs', '日志'], ['update', '更新插件']].map(([operation, label]) => <Button key={operation} disabled={working} onClick={() => ['stop', 'restart', 'update'].includes(operation) ? setConfirm(operation) : void execute('serverAction', { operation })}>{label}</Button>)}</div><Button icon="refresh" disabled={working} onClick={() => setReconnecting(value => !value)}>重新连接隧道</Button>{reconnecting && <form onSubmit={event => { event.preventDefault(); void execute('reconnect', credentials.auth === 'key' ? { privateKey: credentials.privateKey, passphrase: credentials.passphrase } : { password: credentials.password }); setCredentials(emptyServer()); }}><div className="dc-form-grid"><Credentials form={credentials} setForm={setCredentials} disabled={working} /></div><div className="dc-actions"><Button primary type="submit" disabled={working}>连接</Button></div></form>}</section>}{confirm && confirm !== 'remove' && <div className="dc-confirm"><p>{confirm === 'stop' ? '停止服务器服务会中断远程工作台。' : confirm === 'restart' ? '重启时工作台会短暂断开。' : '更新服务器插件时工作台可能短暂断开。'}</p><Button disabled={working} onClick={() => setConfirm('')}>取消</Button><Button primary disabled={working} onClick={() => execute('serverAction', { operation: confirm })}>确认{confirm === 'stop' ? '停止' : confirm === 'restart' ? '重启' : '更新'}</Button></div>}{result && <pre className="dc-result" role="status">{String(result)}</pre>}<ErrorLine error={error} />{job && <><JobProgress job={job} />{jobFinished(job) && !jobFailed(job) && onOpenWorkbench && <div className="dc-actions"><Button primary onClick={() => onOpenWorkbench(job.device || device)}>重新打开工作台</Button></div>}{error && !jobFinished(job) && <Button onClick={() => { setError(''); setPollAttempt(value => value + 1); }}>重新检查进度</Button>}</>}{onCloseWorkbench && <section className="dc-management"><h3>工作台</h3><p className="dc-note">关闭页面会清除该页面尚未发送的内容，主机任务继续运行。</p><div className="dc-actions"><Button onClick={onCloseWorkbench}>关闭工作台页面</Button></div></section>}{device.kind !== 'local' && <section className="dc-remove"><h3>移除保存连接</h3><p className="dc-note">仅从此设备移除，不撤销授权，也不卸载或停止服务器。</p>{confirm === 'remove' ? <div className="dc-actions"><Button disabled={working} onClick={() => setConfirm('')}>取消</Button><Button danger disabled={working} onClick={() => execute('remove')}>确认移除</Button></div> : <Button danger icon="trash" disabled={working} onClick={() => setConfirm('remove')}>移除连接</Button>}</section>}</>;
}

export function DeviceCenter({ runtime = deviceRuntime }) {
  useLinkStyle();
  const [data, setData] = useState({ devices: [], capabilities: {} }), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(''), [modal, setModal] = useState(null), [showDevices, setShowDevices] = useState(true), [frames, setFrames] = useState([]), [activeId, setActiveId] = useState(null);
  const gate = useRef(false), frameElements = useRef(new Map());
  const [navigationReady, setNavigationReady] = useState([]);
  const [centerTab, setCenterTab] = useState('devices');
  useEffect(() => {
    const receive = event => {
      const message = workbenchNavigationMessage(event, frames.map(frame => ({ ...frame, window: frameElements.current.get(frame.id)?.contentWindow })));
      if (!message) return;
      if (message.type === 'dsh-devices:ready') {
        const frame = frames.find(item => item.id === message.id);
        const name = data.devices.find(item => item.id === message.id)?.name || frame.name;
        event.source.postMessage({ type: 'dsh-devices:init', name }, new URL(frame.url).origin);
        setNavigationReady(items => items.includes(message.id) ? items : [...items, message.id]);
      } else if (message.type === 'dsh-devices:unready') setNavigationReady(items => items.filter(id => id !== message.id));
      else if (message.id === activeId && navigationReady.includes(message.id)) { setShowDevices(true); setError(''); }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [frames, data.devices, activeId, navigationReady]);
  const integratedNavigation = !showDevices && !modal && !error && navigationReady.includes(activeId);
  useEffect(() => {
    const parentOrigin = globalThis.__DSH_DEVICE_PARENT_ORIGIN__;
    if (parentOrigin && parent !== window) parent.postMessage({ type: 'dsh-devices:workbench-navigation', ready: integratedNavigation }, parentOrigin);
    return () => { if (parentOrigin && parent !== window) parent.postMessage({ type: 'dsh-devices:workbench-navigation', ready: false }, parentOrigin); };
  }, [integratedNavigation]);
  const frameLoaded = frame => {
    setNavigationReady(items => items.filter(id => id !== frame.id));
    frameElements.current.get(frame.id)?.contentWindow?.postMessage({ type: 'dsh-devices:probe' }, new URL(frame.url).origin);
  };
  useEffect(() => { const node = document.createElement('style'); node.textContent = css; document.head.append(node); return () => node.remove(); }, []);
  const refresh = useCallback(async () => { const next = await runtime.call('list'); setData(next); setLoaded(true); return next; }, [runtime]);
  useEffect(() => { const scanned = () => { const identity = runtime.bootstrap?.(); if (identity?.code && !identity.token) setModal({ type: 'add' }); }; window.addEventListener('link:bootstrap', scanned); scanned(); return () => window.removeEventListener('link:bootstrap', scanned); }, [runtime]);
  useEffect(() => { let closed = false; runtime.call('list').then(next => { if (!closed) { setData(next); setLoaded(true); } }).catch(reason => { if (!closed) { setError(reason.message); setLoaded(true); } }); return () => { closed = true; }; }, [runtime]);
  const closeModal = useCallback(() => setModal(null), []);
  const select = useCallback(async device => {
    if (!device?.id || gate.current) return;
    if (!runtime.isNative() && device.kind !== 'local' && !frames.some(frame => frame.id === device.id) && frames.length >= 4) { setError('已保留 4 个工作台。请在设备设置中关闭暂不用的工作台页面，再打开新设备。'); return; }
    gate.current = true; setBusy(device.id); setError('');
    try {
      const value = await runtime.call('select', { deviceId: device.id });
      if (!runtime.isNative()) {
        if (value.device?.kind === 'local') {
          const parentOrigin = globalThis.__DSH_DEVICE_PARENT_ORIGIN__ || new URLSearchParams(location.search).get('parentOrigin');
          if (parentOrigin && parent !== window) parent.postMessage({ type: 'dsh-devices:return-local' }, parentOrigin);
          setActiveId(null); setShowDevices(true);
        } else {
          if (!value.url) throw new Error('设备未返回工作台地址，请重新连接');
          const url = workbenchUrl(value.url, location.origin);
          setFrames(items => items.some(item => item.id === device.id) ? items.map(item => item.id === device.id && new URL(item.url).origin !== new URL(url).origin ? { ...item, name: device.name, url } : item) : [...items, { id: device.id, name: device.name, url }]);
          setActiveId(device.id); setShowDevices(false);
        }
      }
      setModal(null); await refresh();
    } catch (reason) { setError(reason.message); setModal(null); } finally { gate.current = false; setBusy(''); }
  }, [runtime, refresh, frames]);
  const added = useCallback(async device => { const next = await refresh(); if (device?.id) await select(device); else { setModal(null); setShowDevices(true); setData(next); } }, [refresh, select]);
  const active = data.devices.find(item => item.id === activeId);
  const localDevice = data.devices.find(item => item.kind === 'local');
  const remoteDevices = data.devices.filter(item => item.kind !== 'local');
  const renderDevice = device => <article key={device.id} className={`dc-device ${activeId === device.id ? 'dc-selected' : ''}`}><button className="dc-device-open" disabled={!!busy} onClick={() => select(device)}><span className="dc-device-symbol"><UIIcon name={deviceIcon(device)} size={22} /></span><span className="dc-device-copy"><strong title={device.name}>{device.name}</strong><small>{deviceKind(device)}<span aria-hidden="true"> · </span><span data-status={device.status}>{busy === device.id ? '正在打开…' : activeId === device.id ? '当前工作台' : deviceStatus(device)}</span></small>{device.warning && <span className="dc-device-error">{device.warning}</span>}{device.lastError && <span className="dc-device-error">{device.lastError}</span>}</span><UIIcon name="external" size={16} /></button><Button icon="more" aria-label={`${device.name}设置`} onClick={() => setModal({ type: 'manage', device })} disabled={!!busy} /></article>;
  const switchTab = tab => { setCenterTab(tab); setShowDevices(true); setError(''); };
  const navigateTabs = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'connections' : event.key === 'End' ? 'devices' : centerTab === 'connections' ? 'devices' : 'connections';
    switchTab(next);
    event.currentTarget.parentElement.querySelector('#dc-tab-' + next)?.focus();
  };
  return <main className="dc-root">
    <header className={'dc-topbar' + (integratedNavigation ? ' dc-topbar-integrated' : '')}>
      <div className="dc-segment" role="tablist" aria-label="设备中心">
        {[['connections', 'link', '连接'], ['devices', 'devices', '设备']].map(([tab, icon, label]) => <button key={tab} type="button" id={'dc-tab-' + tab} role="tab" aria-selected={centerTab === tab && showDevices} aria-controls={'dc-panel-' + tab} tabIndex={centerTab === tab ? 0 : -1} className={'dc-segment-tab' + (centerTab === tab && showDevices ? ' is-active' : '')} onClick={() => switchTab(tab)} onKeyDown={navigateTabs}><UIIcon name={icon} size={16} />{label}</button>)}
      </div>
      {activeId && <div className="dc-topbar-workbench"><Button icon="external" onClick={() => { setShowDevices(false); setError(''); }} aria-label={'返回' + (active?.name || '当前') + '工作台'}>{active?.name || '工作台'}</Button><Button icon="more" aria-label="当前设备设置" onClick={() => setModal({ type: 'manage', device: active })} /></div>}
    </header>
    <div className="dc-surface" hidden={!showDevices}>
      <section className="dc-content">
        <div className="dc-heading"><div><span className="dc-eyebrow">设备中心</span><h1>{centerTab === 'connections' ? '连接此设备' : '我的设备'}</h1><p>{centerTab === 'connections' ? '让其他设备安全访问这里的工作台。' : '在熟悉的设备之间，继续手边的工作。'}</p></div><div className="dc-heading-actions">{centerTab === 'devices' && <><Button icon="refresh" aria-label="刷新设备" disabled={!!busy} onClick={() => { setError(''); refresh().catch(reason => setError(reason.message)); }} /><Button icon="plus" primary onClick={() => setModal({ type: 'add' })}>添加设备</Button></>}</div></div>
        <ErrorLine error={error} />
        {!loaded && <DeviceLoading label="正在读取设备…" skeleton />}
        <div id="dc-panel-connections" className="dc-tab-panel" role="tabpanel" aria-labelledby="dc-tab-connections" hidden={!loaded || centerTab !== 'connections'}>
          {data.capabilities?.hostAdmin ? <LinkSettings embedded management={runtime.hostCall} /> : loaded && <div className="dc-empty"><span className="dc-empty-symbol"><UIIcon name="link" size={30} /></span><h2>从另一台设备发起连接</h2><p>此客户端用于访问远程工作台。<br />在目标设备的“连接”页面生成连接信息，再添加到这里。</p><Button icon="plus" primary onClick={() => { setCenterTab('devices'); setModal({ type: 'add' }); }}>添加设备</Button></div>}
        </div>
        <div id="dc-panel-devices" className="dc-tab-panel" role="tabpanel" aria-labelledby="dc-tab-devices" hidden={!loaded || centerTab !== 'devices'}>
          <section className="dc-current-device" aria-label="当前设备" hidden={!localDevice}><div className="dc-section-heading"><h2>当前设备</h2><span>此刻所在的工作台</span></div>{localDevice && <div className="dc-device-list">{renderDevice(localDevice)}</div>}</section>
          <section className="dc-other-devices" aria-label="其他设备"><div className="dc-section-heading"><h2>其他设备 <span className="dc-count">{remoteDevices.length}</span></h2><span>选择设备，打开工作台</span></div><div className="dc-device-list">{remoteDevices.map(renderDevice)}</div>{loaded && !remoteDevices.length && !error && <div className="dc-empty"><span className="dc-empty-symbol"><UIIcon name="devices" size={30} /></span><h2>把工作台带到身边</h2><p>添加一台已有设备，<br />或通过 SSH 连接自己的服务器。</p></div>}</section>
          {data.capabilities?.ssh === false && <p className="dc-footnote">此客户端支持连接已有设备。SSH 安装请使用新版桌面或 Android 客户端。</p>}
          <p className="dc-footnote dc-bottom-note"><UIIcon name="check" size={14} />切换设备不会停止主机上运行的任务</p>
        </div>
      </section>
    </div>
    <div className="dc-workbenches" hidden={showDevices}>{frames.map(frame => <iframe key={frame.id} ref={element => { if (element) frameElements.current.set(frame.id, element); else frameElements.current.delete(frame.id); }} onLoad={() => frameLoaded(frame)} src={frame.url} title={frame.name + '工作台'} hidden={activeId !== frame.id} allow="clipboard-read; clipboard-write; microphone" referrerPolicy="no-referrer" />)}</div>
    {!showDevices && error && <div className="dc-workbench-error"><ErrorLine error={error} /><Button onClick={() => setShowDevices(true)}>返回设备</Button></div>}
    {modal && <Sheet title={modal.type === 'add' ? '添加设备' : modal.device.name} onClose={closeModal} busy={!!busy}>{modal.type === 'add' ? <AddDevice runtime={runtime} onAdded={added} sshAvailable={data.capabilities?.ssh !== false} /> : <ManageDevice device={modal.device} runtime={runtime} onChanged={refresh} onOpenWorkbench={select} onCloseWorkbench={(runtime.isNative() || frames.some(frame => frame.id === modal.device.id)) && modal.device.kind !== 'local' ? () => { if (runtime.isNative()) { void runtime.call('closeWorkbench', { deviceId: modal.device.id }).catch(reason => setError(reason.message)); } setFrames(items => items.filter(frame => frame.id !== modal.device.id)); if (activeId === modal.device.id) { setActiveId(null); setShowDevices(true); } setModal(null); } : undefined} onRemoved={id => { setFrames(items => items.filter(frame => frame.id !== id)); if (activeId === id) { setActiveId(null); setShowDevices(true); } setModal(null); void refresh().catch(reason => setError(reason.message)); }} />}</Sheet>}
  </main>;
}
