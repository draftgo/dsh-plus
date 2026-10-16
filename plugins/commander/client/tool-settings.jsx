import React, { useEffect, useRef, useState } from 'react';
import { Modal, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon } from './iconsax.jsx';
import { ToolBrandIcon } from './tool-brand-icon.jsx';
import { ProviderBrandIcon } from './provider-brand-icon.jsx';
import { activeJob, jobLabels, toolState, parseOverrides, profileDraft, eligibleProviders, previewChecksums } from './tool-settings-state.mjs';
import css from './tool-settings.css';

export function mountToolSettingsStyle(ctx) { const style = document.createElement('style'); style.textContent = css; document.head.append(style); ctx.effect(() => () => style.remove()); }
async function request(action, fields = {}, signal) {
  const response = await fetch(new URL('api/commander/tooling', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...fields }), signal });
  const value = await response.json();
  if (!response.ok || value.error) throw Error(value.error || '工具管理请求失败');
  return value;
}
const array = value => Array.isArray(value) ? value : Object.values(value || {});
const profileFor = (profiles, id) => Array.isArray(profiles) ? profiles.find(profile => profile.tool === id) : profiles?.[id];
const capabilityFor = (capabilities, id) => Array.isArray(capabilities) ? capabilities.find(item => item.tool === id || item.id === id) : capabilities?.[id];
function Hint({ label, children }) { return <Tooltip label={label} delayMs={450} portal>{children}</Tooltip>; }
function Select({ label, value, options, onChange, disabled, empty = '请选择' }) {
  const anchor = useRef(null), [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const selectedOption = options.find(item => item.value === value);
  const matches = options.filter(item => (item.label + ' ' + item.value).toLowerCase().includes(query.toLowerCase()));
  return <div className="cmd-tool-field"><span>{label}</span><button type="button" className="cmd-tool-select" ref={anchor} disabled={disabled} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => { setQuery(''); setOpen(current => !current); }}><span className="cmd-tool-option-label">{selectedOption?.icon}<span>{selectedOption?.label || value || empty}</span></span><UIIcon name="chevronDown" size={14} /></button><Menu open={open && !disabled} onClose={() => setOpen(false)} anchor={null} getAnchorRect={() => anchor.current?.getBoundingClientRect() ?? null} side="bottom" align="start" portal autoFocus listClassName="cmd-tool-select-menu"><input autoFocus aria-label={'搜索' + label} value={query} placeholder={'搜索' + label} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = event.currentTarget.closest('[role=menu]')?.querySelectorAll('[role=menuitem]'); if (buttons?.length) buttons[event.key === 'ArrowDown' ? 0 : buttons.length - 1].focus(); } if (event.key !== 'Escape') event.stopPropagation(); }} />{matches.map(item => <button role="menuitem" data-selected={item.value === value} key={item.value} type="button" onClick={() => { onChange(item.value); setOpen(false); }}><span className="cmd-tool-option-label">{item.icon}<span>{item.label}</span></span>{item.value === value && <UIIcon name="check" size={14} />}</button>)}{!matches.length && <p>没有可选项</p>}</Menu></div>;
}

export function ToolSettingsSection({ ctx }) {
  const [data, setData] = useState(null), [providers, setProviders] = useState([]), [selected, setSelected] = useState(''), [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState(() => profileDraft()), [models, setModels] = useState([]), [modelLoading, setModelLoading] = useState(false), [modelError, setModelError] = useState(''), [modelRevision, setModelRevision] = useState(0);
  const [job, setJob] = useState(null), [confirm, setConfirm] = useState(null), [preview, setPreview] = useState(null);
  const mounted = useRef(true);
  const rememberJob = value => { setJob(value); if (value) setData(current => current ? ({ ...current, tools: current.tools.map(item => item.id === value.toolId ? { ...item, job: value } : item) }) : current); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    Promise.all([request('catalog', {}, controller.signal), request('providers', {}, controller.signal)]).then(([catalog, providerData]) => {
      if (controller.signal.aborted) return; setData(catalog); setProviders(providerData.providers || []); setSelected(current => catalog.tools?.some(tool => tool.id === current) ? current : catalog.tools?.[0]?.id || '');
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const tool = data?.tools?.find(item => item.id === selected), capability = capabilityFor(data?.capabilities, selected) || {}, state = tool ? toolState(tool, capability) : {};
  const profile = profileFor(data?.profiles, selected), defaultProfile = profileFor(data?.defaults, selected);
  const currentProvider = providers.find(item => item.id === defaultProfile?.providerId);
  useEffect(() => { setDraft(profileDraft(profile)); setPreview(null); setModelError(''); setJob(tool?.job || null); }, [selected, profile]);
  useEffect(() => { setJob(tool?.job || null); }, [selected, tool?.job]);
  useEffect(() => {
    const controller = new AbortController(); setModels([]); setModelError(''); setModelLoading(false);
    if (!draft.providerId) return;
    setModelLoading(true); request('models', { providerId: draft.providerId }, controller.signal).then(value => { if (!controller.signal.aborted) setModels(value.models || []); }).catch(failure => { if (!controller.signal.aborted) setModelError(failure.message); }).finally(() => { if (!controller.signal.aborted) setModelLoading(false); });
    return () => controller.abort();
  }, [draft.providerId, modelRevision]);
  useEffect(() => {
    if (!activeJob(job)) return;
    const controller = new AbortController(); let timer;
    const poll = async () => { try { const value = await request('job', { id: job.id }, controller.signal); if (controller.signal.aborted) return; rememberJob(value.job); if (activeJob(value.job)) timer = setTimeout(poll, 1000); else setRevision(value => value + 1); } catch (failure) { if (!controller.signal.aborted) setError(failure.message); } };
    timer = setTimeout(poll, 650); return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status]);
  const run = async work => { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (failure) { if (mounted.current) setError(failure.message); } finally { if (mounted.current) setBusy(false); } };
  const install = action => run(async () => { const value = await request(action, { tool: selected }); rememberJob(value.job); setConfirm(null); });
  const saveDefault = () => run(async () => {
    const overrides = parseOverrides(draft.overrides);
    if (!draft.providerId || !draft.model.trim()) throw Error('请选择供应商和模型');
    const value = await request('saveProfile', { tool: selected, providerId: draft.providerId, model: draft.model.trim(), ...(draft.protocol ? { protocol: draft.protocol } : {}), overrides, ...(draft.revision !== undefined ? { expectedRevision: draft.revision } : {}) });
    setDraft(profileDraft(value.profile));
    setData(current => ({ ...current, profiles: array(current.profiles).filter(item => item.tool !== selected).concat(value.profile) }));
    await request('setDefault', { tool: selected, revision: value.profile.revision }); setNotice('默认方案已保存，新会话生效。'); setRevision(value => value + 1);
  });
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value, ...(key === 'providerId' ? { model: '' } : {}) })); setPreview(null); setNotice(''); };
  const bindings = data?.bindings || {}, available = eligibleProviders(providers, bindings, selected);
  const tools = (data?.tools || []).filter(item => (item.name + ' ' + item.id).toLowerCase().includes(query.toLowerCase()));
  const backups = array(data?.backups).filter(item => item.tool === selected || item.toolId === selected);
  return <section className="cmd-tool-settings" aria-busy={loading}>
    <header className="cmd-tool-heading"><div><h2>工具管理</h2></div><Hint label="重新检测"><button type="button" className="cmd-tool-icon" disabled={loading || busy} aria-label="重新检测工具" onClick={() => setRevision(value => value + 1)}><UIIcon name="search" size={16} /></button></Hint></header>
    {error && <p className="cmd-tool-error" role="alert">{error}</p>}{notice && <p className="cmd-tool-notice" role="status">{notice}</p>}
    {loading && !data ? <p className="cmd-tool-empty" role="status">正在检测已安装工具…</p> : !data ? <button type="button" className="cmd-tool-button" onClick={() => setRevision(value => value + 1)}>重新加载</button> : <>
    <div className="cmd-tool-workbench"><aside className="cmd-tool-list"><label className="cmd-tool-search"><UIIcon name="search" size={15} /><input aria-label="搜索工具" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索工具" /></label>{tools.map(item => <button type="button" key={item.id} aria-pressed={selected === item.id} onClick={() => { if (!busy) { setNotice(''); setSelected(item.id); } }}><ToolBrandIcon tool={item.id} size={20} /><span><strong>{item.name}</strong><small>{activeJob(item.id === selected ? job : item.job) ? '正在处理…' : item.installed ? '已安装' : '未安装'}</small></span><UIIcon name="chevronDown" size={12} /></button>)}{!tools.length && <p className="cmd-tool-empty">没有匹配的工具</p>}</aside>
    {tool && <main className="cmd-tool-detail" key={selected}><div className="cmd-tool-detail-heading"><div><h3 style={{ display: 'flex', alignItems: 'center', gap: 9 }}><ToolBrandIcon tool={tool.id} size={22} />{tool.name}</h3><div className="cmd-tool-badges"><span data-ready={state.installed}>{state.installation}{tool.version ? ' · ' + tool.version : ''}</span><span data-ready={state.chatSupported}>{state.chatSupported ? '可对话' : '仅配置'}</span></div></div><div className="cmd-tool-install-actions"><button type="button" className="cmd-tool-button" disabled={!state.canInstall || busy || activeJob(job)} onClick={() => void install('install')}>{state.installed ? '重新安装' : '安装'}</button>{(state.installed || tool.canUninstall) && <button type="button" className="cmd-tool-button" disabled={!state.canUninstall || busy || activeJob(job)} onClick={() => setConfirm({ kind: 'uninstall' })}>卸载</button>}</div></div>
      {!tool.canInstall && tool.installReason && <p className="cmd-tool-hint">{tool.id === 'claude-desktop' ? 'Claude Desktop 需要使用官方平台安装器手动安装。' : tool.installReason}</p>}{state.installed && !tool.canUninstall && tool.uninstallReason && <p className="cmd-tool-hint">{tool.uninstallReason}</p>}
      {job && <div className="cmd-tool-job" role="status"><div><strong>{jobLabels[job.status] || job.status}</strong><span>{job.message}</span>{activeJob(job) && <button className="cmd-tool-button" type="button" disabled={busy} onClick={() => void run(async () => rememberJob((await request('cancel', { id: job.id })).job))}>取消任务</button>}</div>{activeJob(job) && <div className="cmd-tool-progress" aria-label="任务正在执行"><span /></div>}{job.error && <p className="cmd-tool-error">{job.error}</p>}{job.logs?.length > 0 && <details><summary>执行日志</summary><pre>{job.logs.join(String.fromCharCode(10))}</pre></details>}</div>}
      {state.configSupported ? <div className="cmd-tool-config"><div className="cmd-tool-config-heading"><h4>默认方案</h4><span>仅用于新会话</span></div>
      <div className="cmd-tool-current-provider" aria-label="当前生效方案"><span className="cmd-tool-route-status">{defaultProfile && <UIIcon name="check" size={13} />}{defaultProfile ? '已生效' : '未设置'}</span>{defaultProfile && <ProviderBrandIcon id={currentProvider?.id || defaultProfile.providerId} name={currentProvider?.name || defaultProfile.providerId} declared={currentProvider?.declared} size={22} />}<div><strong>{defaultProfile ? currentProvider?.name || defaultProfile.providerId : '请选择供应商和模型'}</strong>{defaultProfile?.model && <small>{defaultProfile.model}</small>}</div></div>
      {providers.length > 0 && !available.length && <p className="cmd-tool-empty">请在「模型」设置中，为供应商启用此工具。</p>}{!providers.length && <p className="cmd-tool-empty">请先在「模型」设置中添加供应商。</p>}
      {tool.routeSupported === false && <p className="cmd-tool-hint">{tool.routeReason || '此工具暂不支持独立供应商配置'}，暂不能设为默认。</p>}<div className="cmd-tool-fields"><Select label="供应商" value={draft.providerId} options={available.map(item => ({ value: item.id, label: item.name || item.id, icon: <ProviderBrandIcon id={item.id} name={item.name || item.id} declared={item.declared} size={18} /> }))} onChange={value => change('providerId', value)} disabled={busy || !available.length} empty="选择供应商" /><Select label={modelLoading ? '模型 · 加载中' : '模型'} value={draft.model} options={models.map(item => ({ value: item.id, label: item.name || item.id }))} onChange={value => change('model', value)} disabled={busy || modelLoading || !draft.providerId} empty="选择模型" /></div>
      {modelError && <p className="cmd-tool-error" role="alert">模型加载失败：{modelError} <button type="button" className="cmd-tool-link" onClick={() => setModelRevision(value => value + 1)}>重试</button></p>}
      <div className="cmd-tool-footer"><span>沿用「模型」中的配置，本机记录不受影响。</span><button type="button" className="cmd-tool-button cmd-tool-primary" disabled={busy || tool.routeSupported === false || !draft.providerId || !draft.model.trim()} onClick={() => void saveDefault()}>{busy ? '保存中…' : '保存默认方案'}</button></div>
      <details className="cmd-tool-advanced"><summary>高级选项</summary><label className="cmd-tool-field"><span>自定义模型 ID</span><input value={draft.model} disabled={busy} placeholder="手动填写模型 ID" onChange={event => change('model', event.target.value)} /></label>
      {capability.protocols?.length > 0 && <Select label="协议" value={draft.protocol} options={[{ value: '', label: '自动选择' }, ...capability.protocols.map(protocol => ({ value: protocol, label: protocol }))]} disabled={busy} onChange={value => change('protocol', value)} />}
      <details className="cmd-tool-advanced"><summary>配置 JSON</summary><p className="cmd-tool-hint">填写 config / settings / auth / profile / meta 覆盖项。密钥与接口地址在「模型」设置中维护。</p><textarea spellCheck={false} aria-label={tool.name + ' 高级配置 JSON'} value={draft.overrides} disabled={busy} onChange={event => change('overrides', event.target.value)} /></details>
      <div className="cmd-tool-native-sync"><button type="button" className="cmd-tool-link" disabled={busy || !profile} onClick={() => void run(async () => { const result = await request('preview', { tool: selected }); setPreview(result.preview); })}>同步已保存方案到本机 CLI…</button><small>需单独确认，将备份并写入本机配置。</small></div></details>
      {backups.length > 0 && <details className="cmd-tool-backups"><summary>配置备份 <small>{backups.length}</small></summary>{backups.map(backup => <div key={backup.id || backup.backupId}><span>{backup.createdAt ? new Date(backup.createdAt).toLocaleString('zh-CN') : backup.id || backup.backupId}</span><button type="button" className="cmd-tool-button" disabled={busy} onClick={() => setConfirm({ kind: 'restore', backupId: backup.id || backup.backupId })}>恢复</button></div>)}</details>}
      </div> : <p className="cmd-tool-empty">此工具暂不支持配置。</p>}
    </main>}</div></>}
    <Modal open={!!preview} onClose={() => { if (!busy) setPreview(null); }} title="确认同步到本机 CLI" closeLabel="关闭" className="cmd-tool-modal" description="此操作会修改下面列出的本机工具配置并创建备份，不修改历史记录。只设置新会话默认无需执行此操作。" footer={<><button type="button" className="cmd-tool-button" disabled={busy} onClick={() => setPreview(null)}>返回编辑</button><button type="button" className="cmd-tool-button cmd-tool-primary" disabled={busy || !preview?.files?.length} onClick={() => void run(async () => { await request('apply', { tool: selected, confirmNativeWrite: true, revision: preview.revision, checksums: previewChecksums(preview) }); setPreview(null); setNotice('配置已备份并应用'); setRevision(value => value + 1); })}>{busy ? '应用中…' : '备份并应用'}</button></>}>
      <div className="cmd-tool-preview">{preview?.files?.map(file => <div key={file.path}><code>{file.path}</code><span>{!file.exists ? '新建' : file.changed ? '更新' : '无变化'}</span></div>)}{!preview?.files?.length && <p>没有需要写入的配置文件。</p>}{preview?.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}{error && <p className="cmd-tool-error" role="alert">{error}</p>}</div>
    </Modal>
    <Modal className="cmd-tool-modal" open={!!confirm} onClose={() => { if (!busy) setConfirm(null); }} title={confirm?.kind === 'restore' ? '恢复这个备份？' : '卸载 ' + (tool?.name || '') + '？'} closeLabel="关闭" description={confirm?.kind === 'restore' ? '将备份写回工具配置文件。请先结束正在运行的工具。' : '只移除由本插件管理的安装，工具配置和历史记录保留。'} footer={<><button type="button" className="cmd-tool-button" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button type="button" className="cmd-tool-button" disabled={busy} onClick={() => confirm.kind === 'uninstall' ? void install('uninstall') : void run(async () => { await request('restore', { backupId: confirm.backupId, confirmNativeWrite: true }); setConfirm(null); setNotice('配置备份已恢复'); setRevision(value => value + 1); })}>{busy ? '处理中…' : '确认'}</button></>}>{error && <p className="cmd-tool-error" role="alert">{error}</p>}</Modal>
  </section>;
}
