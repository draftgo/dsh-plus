import { readJsonResponse } from './http-response.mjs';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LinkIconMedium, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon } from './iconsax.jsx';
import css from './updates.css';
import { brandIcon } from '../../link/client/brand.jsx';

const activePhases = new Set(['checking', 'downloading']);
const sourceNames = { mirror: '国内加速', github: 'GitHub 直连', custom: '自定义镜像' };
const httpsUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } };

export function mountUpdatesStyle(ctx) {
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  ctx.effect(() => () => style.remove());
}

/** A host update changes the connected computer; it never updates a mobile APK. */
export function UpdateLauncher({ host, wide = true }) {
  const [open, setOpen] = useState(false), [data, setData] = useState(null), [error, setError] = useState(''), [pending, setPending] = useState('');
  const [source, setSource] = useState('mirror'), [mirrorUrl, setMirrorUrl] = useState('');
  const mounted = useRef(false), flight = useRef(null), controllers = useRef(new Set()), retryAction = useRef({ action: 'check' }), id = useId();
  const run = useCallback(async (action, args = {}) => {
    // A read must never lock a visible action or replace a newer command's response.
    if (flight.current) {
      if (action === 'status' || flight.current.action !== 'status') return null;
      flight.current.abort();
    }
    const controller = new AbortController(); controller.action = action;
    controllers.current.add(controller); flight.current = controller;
    if (mounted.current && action !== 'status') { setPending(action); setError(''); }
    try {
      const response = await fetch(new URL('api/commander/updates', document.baseURI), {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...args }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      });
      const value = await readJsonResponse(response, new URL('api/commander/updates', document.baseURI));
      if (mounted.current && !controller.signal.aborted) {
        setData(value);
        if (value.config) { setSource(value.config.source); setMirrorUrl(value.config.mirrorUrl || ''); }
      }
      return controller.signal.aborted ? null : value;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) { retryAction.current = { action, args }; setError(failure.name === 'TimeoutError' ? '更新请求超时，请重试。' : failure.message); }
      return null;
    } finally {
      controllers.current.delete(controller);
      if (flight.current === controller) { flight.current = null; if (mounted.current && action !== 'status') setPending(''); }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void (async () => { const current = await run('status'); if (mounted.current && current && !current.restartRequired && !activePhases.has(current.phase)) await run('check'); })();
    const show = () => setOpen(true); document.addEventListener('commander:updates', show);
    return () => { mounted.current = false; for (const controller of controllers.current) controller.abort(); flight.current = null; document.removeEventListener('commander:updates', show); };
  }, [run]);
  useEffect(() => { if (open) void run('status'); }, [open, run]);
  useEffect(() => {
    const awaitingInstall = open && data?.release?.plugin?.compatible && data.release.plugin.available !== false && data.release.plugin.version !== data?.current?.plugin && data?.managed && !data?.canInstall && !data?.restartRequired;
    if ((!activePhases.has(data?.phase) && !awaitingInstall) || error) return;
    const timer = setInterval(() => void run('status'), 2000); return () => clearInterval(timer);
  }, [data?.phase, data?.canInstall, data?.managed, data?.release?.plugin?.version, data?.release?.plugin?.available, data?.release?.plugin?.compatible, data?.current?.plugin, data?.restartRequired, open, error, run]);
  const working = !!pending || activePhases.has(data?.phase), restart = !!data?.restartRequired || data?.phase === 'ready';
  const unpublished = data?.phase === 'unpublished', serverDeployment = data?.installation === 'server', serverManaged = serverDeployment && data?.managed === false;
  const plugin = data?.release?.plugin, pluginAvailable = !!plugin && plugin.available !== false && plugin.version !== data?.current?.plugin;
  const offerPluginInstall = pluginAvailable && !serverManaged;
  const installBlockReason = !offerPluginInstall ? '' : data?.managed === false ? '当前安装方式需先升级应用。'
    : data?.busy ? '有任务正在运行，结束后即可更新。'
      : !plugin.compatible ? plugin.reason || '请先升级应用。'
        : !data?.canInstall && !working ? data?.installBlockReason || '更新状态尚未就绪，请重新检查。' : '';
  const app = data?.release?.app, appUrl = httpsUrl(app?.url), appAvailable = !!app && app.available !== false && app.version !== data?.current?.app;
  const desktopUpdates = globalThis.dshDesktop?.updates, canOpenAppUpdates = typeof desktopUpdates?.open === 'function';
  const newVersion = pluginAvailable || appAvailable;
  const status = restart ? '待重启' : working ? (data?.phase === 'downloading' || pending === 'install' ? '下载中' : '检查中') : newVersion ? '有更新' : '';
  const configure = async (nextSource, nextMirror = mirrorUrl) => {
    if (nextSource === 'custom' && !httpsUrl(nextMirror)) { setError('请输入有效的 HTTPS 镜像地址。'); return; }
    const saved = await run('configure', { source: nextSource, mirrorUrl: nextMirror.trim() });
    if (saved && !saved.restartRequired) await run('check');
  };
  const openAppUpdates = async () => {
    if (!canOpenAppUpdates || (flight.current && flight.current.action !== 'status') || activePhases.has(data?.phase)) return;
    flight.current?.abort();
    const operation = {}; flight.current = operation; setPending('app'); setError('');
    try { await desktopUpdates.open(); }
    catch (failure) { if (mounted.current) { retryAction.current = { action: 'app' }; setError(failure?.message || '无法打开应用更新，请重试。'); } }
    finally { if (flight.current === operation) { flight.current = null; if (mounted.current) setPending(''); } }
  };
  const retry = () => {
    const { action, args } = error ? retryAction.current : { action: ['install', 'rollback'].includes(data?.lastAction) ? data.lastAction : 'check' };
    if (action === 'status') setError('');
    return action === 'app' ? openAppUpdates() : run(action, args);
  };
  const close = () => setOpen(false);
  return <>
    <Tooltip label={status ? `更新 · ${status}` : '更新'} delayMs={450} portal>
      <button type="button" className={`cmd-update-launcher ${wide ? '' : 'cmd-update-launcher-rail'}`} aria-label={status ? `更新，${status}` : '更新'} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="cmd-update-icon"><UIIcon name="refresh" size={16} />{(newVersion || restart) && <i aria-hidden="true" />}</span>
        {wide && <><span>更新</span>{status && <small data-ready={restart}>{status}</small>}</>}
      </button>
    </Tooltip>
    <Modal open={open} headless onClose={close} title="更新" className="cmd-update-dialog">
      <header className="cmd-update-header"><div><h2>更新</h2><p>当前连接主机 · {globalThis.location?.hostname || '本机'}</p></div><button type="button" className="cmd-update-icon-button" aria-label="关闭更新" onClick={close}><UIIcon name="close" size={16} /></button></header>
      <div className="cmd-update-content">
        <section className="cmd-update-plugin" aria-labelledby={`${id}-plugin`}>
          <div className="cmd-update-card-heading"><span className="cmd-update-plugin-mark"><img src={brandIcon} width="38" height="38" alt="小角" /></span><div><h3 id={`${id}-plugin`}>DSH-Plus <small>插件</small></h3><p>{data?.current?.plugin ? `v${data.current.plugin}` : '读取版本中…'}{pluginAvailable && !restart && <><span aria-hidden="true"> → </span><strong>v{plugin.version}</strong></>}</p></div><span className="cmd-update-chip">界面与功能</span></div>
          <p className="cmd-update-description">{serverDeployment ? '主机更新后，刷新工作台即可使用新版。' : '日常更新只需升级插件，手机同步生效。'}</p>
          {restart ? <div className="cmd-update-notice" role="status"><UIIcon name="check" size={16} /><div><strong>已准备好，重启主机应用后生效</strong><p>先结束任务，再退出并重新打开主机上的小角。</p></div></div> : <>
            {pluginAvailable && !plugin.compatible && <p className="cmd-update-warning">{plugin.reason || (serverManaged ? '此插件与当前引擎不兼容，请由服务器部署更新。' : '此插件需要新版应用，请先升级应用。')}</p>}
            {data?.managed === false && <p className="cmd-update-warning">{serverManaged ? '此主机由服务器部署管理' : '当前安装方式不支持独立更新，请先安装新版应用。'}</p>}
            {data?.busy && <p className="cmd-update-warning" role="status">有任务正在运行，结束后即可更新。</p>}
            {installBlockReason && !data?.busy && data?.managed !== false && plugin.compatible && <p className="cmd-update-warning" role="status">{installBlockReason}</p>}
            <div className="cmd-update-actions"><span role="status">{working ? (data?.phase === 'downloading' || pending === 'install' ? '正在下载并校验…' : '正在检查…') : !data ? '尚未读取更新信息' : unpublished ? data.notice || '更新通道尚未就绪' : pluginAvailable ? '发现新版本' : data.phase === 'error' ? '暂时无法检查更新' : '插件已是最新版本'}</span><span className="cmd-update-action-buttons">{offerPluginInstall && <button type="button" className="cmd-update-text-button" disabled={working} onClick={() => void run('check')}>重新检查</button>}<button type="button" className={`cmd-update-button ${offerPluginInstall ? 'cmd-update-primary' : ''}`} title={installBlockReason || undefined} disabled={working || (!!offerPluginInstall && !!installBlockReason)} onClick={() => void run(offerPluginInstall ? 'install' : 'check')}>{pending === 'install' || data?.phase === 'downloading' ? '下载中…' : offerPluginInstall ? '更新插件' : '检查更新'}</button></span></div>
          </>}
          {data?.release?.notes && <details className="cmd-update-notes"><summary>更新内容</summary><p>{data.release.notes}</p></details>}
        </section>
        {canOpenAppUpdates ? <section className="cmd-update-app"><UIIcon name="external" size={17} /><div><h3>{appAvailable ? '应用有新版本' : '桌面应用'} <span>{appAvailable ? `v${app.version}` : data?.current?.app ? `v${data.current.app}` : ''}</span></h3><p>引擎或桌面能力升级时，才需更新应用。</p></div><span className="cmd-update-app-actions"><button type="button" className="cmd-update-text-button" disabled={working} onClick={() => void openAppUpdates()}>{pending === 'app' ? '正在打开…' : '检查应用更新'}</button>{appAvailable && appUrl && <a className="cmd-update-text-button" href={appUrl} target="_blank" rel="noopener noreferrer">下载安装包<UIIcon name="external" size={12} /></a>}</span></section> : data?.current?.app ? <p className="cmd-update-app-version">应用 v{data.current.app}{data.current.engine && ` · 引擎 ${data.current.engine}`}</p> : null}
        {(error || (!unpublished && data?.error)) && <div className="cmd-update-error" role="alert"><span>{error || data.error}</span><button type="button" className="cmd-update-text-button" disabled={!!pending || (working && retryAction.current.action !== 'status')} onClick={() => void retry()}>重试</button></div>}
        <section className="cmd-update-source" aria-labelledby={`${id}-source`}>
          <div className="cmd-update-source-row"><label htmlFor={`${id}-source-select`} id={`${id}-source`}><LinkIconMedium kind="url" href="https://github.com" size={16} />更新来源</label><select id={`${id}-source-select`} value={source} disabled={working || restart} onChange={event => { const value = event.target.value; setSource(value); setError(''); if (value !== 'custom') void configure(value); }}>{Object.entries(sourceNames).map(([value, label]) => <option key={value} value={value}>{label}{value === 'mirror' ? '（默认）' : ''}</option>)}</select></div>
          {source === 'custom' && <form className="cmd-update-custom" onSubmit={event => { event.preventDefault(); void configure('custom', event.currentTarget.elements.namedItem('mirrorUrl').value); }}><input name="mirrorUrl" type="url" required aria-label="自定义 HTTPS 镜像地址" placeholder="https://mirror.example.com/" value={mirrorUrl} disabled={working || restart} onChange={event => setMirrorUrl(event.target.value)} /><button type="submit" className="cmd-update-button" disabled={working || restart}>保存</button></form>}
          <p>从 GitHub 发布页获取；加速镜像仅用于下载。</p>
        </section>
      </div>
      <footer className="cmd-update-footer"><span>更新此主机，手机无需重装</span>{data?.canRollback && !restart && <button type="button" className="cmd-update-text-button" disabled={working || !!data?.busy} onClick={() => void run('rollback')}>回退上版</button>}</footer>
    </Modal>
  </>;
}
