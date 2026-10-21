import React, { useRef, useState } from 'react';
import { managementCall } from './api.mjs';
import { readJsonResponse } from '../../commander/client/http-response.mjs';

export function generateAccessKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function CloudAccessSettings({ value, onChanged, disabled, loading = false, failed = false, onRetry, management = managementCall }) {
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [confirmDisable, setConfirmDisable] = useState(false);
  const [saved, setSaved] = useState(false), [manual, setManual] = useState(false), [revealed, setRevealed] = useState(false);
  const input = useRef(null), inFlight = useRef(false);
  const unavailable = disabled || busy || !value?.configured || value?.ready !== true || failed || loading;
  const updateKey = next => { setKey(next); setSaved(false); setRevealed(false); setError(''); setMessage(''); };
  const generate = () => {
    if (unavailable) return;
    try { updateKey(generateAccessKey()); setManual(false); } catch { setError('无法生成密钥，请使用自定义密钥'); setManual(true); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(key); setMessage('已复制，请保存后勾选确认'); }
    catch { input.current?.focus(); input.current?.select(); setMessage('复制失败，密钥已选中，请手动复制并保存'); }
  };
  const change = async operation => {
    if (unavailable || inFlight.current || (operation !== 'disable' && (!saved || key.length < 16 || key.length > 512))) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const next = await management('cloud-access', { operation, ...(operation === 'disable' ? {} : { key }) });
      setKey(''); setSaved(false); setManual(false); setConfirmDisable(false); onChanged(next);
      setMessage(operation === 'disable' ? '访问密钥已关闭' : operation === 'rotate' ? '密钥已更换，其他设备需重新登录' : '访问密钥已启用');
    } catch (reason) { setError(reason.message); } finally { inFlight.current = false; setBusy(false); }
  };
  const logout = async () => {
    if (unavailable || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const url = new URL('/__dsh_access/session', location.origin);
      const response = await fetch(url, { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-dsh-access': '1' }, credentials: 'same-origin', signal: AbortSignal.timeout(10_000) });
      await readJsonResponse(response, url); location.assign('/__dsh_access/login');
    } catch { setError('退出失败，请重试'); setBusy(false); } finally { inFlight.current = false; }
  };
  const state = loading ? '正在连接…' : failed || !value?.configured || value?.ready !== true ? '暂不可用' : value.enabled ? '已启用' : '未启用';
  return <section className="link-cloud-access" aria-labelledby="link-cloud-access-title">
    <div className="link-panel-head"><div><h3 id="link-cloud-access-title">云端访问密钥</h3><p className="link-cloud-description">保护当前小角的管理入口</p></div><span className={`link-cloud-state${value?.enabled ? ' is-enabled' : ''}`} role="status">{state}</span></div>
    {!value?.configured || value?.ready !== true || failed ? <div className="link-cloud-unavailable"><p>服务待就绪</p>{onRetry && <button type="button" className="link-button link-button-quiet" disabled={loading || busy} onClick={onRetry}>重试</button>}</div> : <>
      <p className="link-cloud-note">{value.enabled ? '管理入口已保护。已配对设备进入工作台无需重复输入。' : '启用后，浏览器访问管理入口时需要登录；设备配对仍独立进行。'}</p>
      <form className="link-key-form" onSubmit={event => { event.preventDefault(); void change(value.enabled ? 'rotate' : 'enable'); }}>
        <div className="link-form-actions"><button type="button" className="link-button link-button-quiet" disabled={unavailable} onClick={generate}>{key ? '重新生成' : value.enabled ? '生成新密钥' : '生成密钥'}</button><button type="button" className="link-button link-button-quiet" disabled={unavailable} onClick={() => setManual(true)}>自定义密钥</button></div>
        {(key || manual) && <div className="link-key-draft"><label className="link-field"><span>{value.enabled ? '新密钥' : '访问密钥'}</span><input ref={input} aria-label="访问密钥" type={revealed ? 'text' : 'password'} autoComplete="new-password" minLength={16} maxLength={512} value={key} readOnly={!manual} onChange={event => updateKey(event.target.value)} disabled={unavailable} /></label><div className="link-key-tools"><button type="button" className="link-button link-button-quiet" disabled={unavailable || !key} onClick={copy}>复制密钥</button><button type="button" className="link-button link-button-quiet" aria-pressed={revealed} disabled={unavailable || !key} onClick={() => setRevealed(value => !value)}>{revealed ? '隐藏密钥' : '显示密钥'}</button></div><label className="link-key-saved"><input type="checkbox" checked={saved} disabled={unavailable || key.length < 16} onChange={event => setSaved(event.target.checked)} />我已保存密钥</label>{manual && <small>16–512个字符</small>}</div>}
        <div className="link-form-actions"><button className="link-button link-button-primary" type="submit" disabled={unavailable || !saved || key.length < 16 || key.length > 512}>{busy ? '处理中…' : value.enabled ? '更换密钥' : '启用访问密钥'}</button>{(key || manual) && <button type="button" className="link-button link-button-quiet" disabled={busy} onClick={() => { updateKey(''); setManual(false); }}>取消</button>}{value.enabled && <button className="link-button link-button-quiet" type="button" disabled={unavailable} onClick={() => setConfirmDisable(true)}>关闭密钥</button>}{value.enabled && globalThis.location?.origin === value.origin && <button className="link-button link-button-quiet" type="button" disabled={unavailable} onClick={logout}>退出当前登录</button>}</div>
      </form>
    </>}
    {confirmDisable && <div className="link-key-confirm"><p>关闭后，管理入口不再要求此访问密钥。已有设备配对不受影响。</p><button type="button" className="link-button link-button-quiet" disabled={busy} onClick={() => setConfirmDisable(false)}>取消关闭</button><button type="button" className="link-button link-button-primary" disabled={busy} onClick={() => change('disable')}>确认关闭</button></div>}
    {(value?.error || value?.readinessError) && <details className="link-error-detail"><summary>查看详情</summary><p>{value.error || value.readinessError}</p></details>}
    {error && <p className="link-error" role="alert">{error}</p>}{message && <p className="link-cloud-note" role="status">{message}</p>}
  </section>;
}
