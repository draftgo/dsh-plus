import { readJsonResponse } from './http-response.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon } from './iconsax.jsx';
import { ToolBrandIcon } from './tool-brand-icon.jsx';
import { ProviderBrandIcon } from './provider-brand-icon.jsx';
import { activeJob, jobLabels, toolState, parseOverrides, profileDraft, eligibleProviders, previewChecksums, setQuickSetting, nextToolTab, nativeOnlyDraft } from './tool-settings-state.mjs';
import { quickSettingsFor, validateQuickSettings } from '../shared/tool-quick-settings.mjs';
import { createTabDragScroll } from './tab-drag-scroll.mjs';
import css from './tool-settings.css';

export function mountToolSettingsStyle(ctx) { const style = document.createElement('style'); style.textContent = css; document.head.append(style); ctx.effect(() => () => style.remove()); }
async function request(action, fields = {}, signal) {
  const response = await fetch(new URL('api/commander/tooling', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...fields }), signal });
  const value = await readJsonResponse(response, new URL('api/commander/tooling', document.baseURI));
  if (value.error) throw Error(value.error || '工具管理请求失败');
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
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const trigger = <button type="button" className="cmd-tool-select" ref={anchor} disabled={disabled} aria-label={label} aria-haspopup="menu" aria-expanded={open && !disabled} onClick={() => { setQuery(''); setOpen(current => !current); }}><span className="cmd-tool-option-label">{selectedOption?.icon}<span>{selectedOption?.label || value || empty}</span></span><UIIcon name="chevronDown" size={14} /></button>;
  return <div className="cmd-tool-field"><span>{label}</span><Menu open={open && !disabled} onClose={() => setOpen(false)} anchor={trigger} className="cmd-tool-select-anchor" getAnchorRect={() => anchor.current?.getBoundingClientRect() ?? null} side="bottom" align="start" portal autoFocus listClassName="cmd-tool-select-menu"><input autoFocus aria-label={'搜索' + label} value={query} placeholder={'搜索' + label} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const buttons = event.currentTarget.closest('[role=menu]')?.querySelectorAll('[role=menuitem]'); if (buttons?.length) buttons[event.key === 'ArrowDown' ? 0 : buttons.length - 1].focus(); } if (event.key !== 'Escape') event.stopPropagation(); }} />{matches.map(item => <button role="menuitem" data-selected={item.value === value} key={item.value} type="button" onClick={() => { onChange(item.value); setOpen(false); }}><span className="cmd-tool-option-label">{item.icon}<span>{item.label}</span></span>{item.value === value && <UIIcon name="check" size={14} />}</button>)}{!matches.length && <p>没有可选项</p>}</Menu></div>;
}

function DownloadSource({ value, disabled, onChange }) {
  const options = [{ value: 'mirror', label: '国内加速' }, { value: 'official', label: '官方直连' }];
  const navigate = event => {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'mirror' : event.key === 'End' ? 'official' : value === 'mirror' ? 'official' : 'mirror';
    onChange(next); event.currentTarget.querySelector('[data-source="' + next + '"]')?.focus();
  };
  return <fieldset className="cmd-tool-download-source" disabled={disabled}><legend>下载源</legend><div role="radiogroup" aria-label="下载源" onKeyDown={navigate}>{options.map(item => <button key={item.value} type="button" role="radio" data-source={item.value} tabIndex={value === item.value ? 0 : -1} aria-checked={value === item.value} disabled={disabled} onClick={() => onChange(item.value)}>{item.label}</button>)}</div></fieldset>;
}

function ToolTabs({ tools, selected, disabled, onChange }) {
  const dragScroll = useRef(null);
  if (!dragScroll.current) dragScroll.current = createTabDragScroll();
  return <nav className="cmd-tool-tabs" role="tablist" aria-label="Harness 工具" aria-orientation="horizontal" {...dragScroll.current} onKeyDown={event => {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const id = nextToolTab(tools, selected, event.key); onChange(id);
    event.currentTarget.querySelector('[data-tool="' + id + '"]')?.focus();
  }}>{tools.map(item => <button key={item.id} type="button" role="tab" id={'cmd-tool-tab-' + item.id} data-tool={item.id} aria-label={item.name} aria-selected={selected === item.id} aria-controls={'cmd-tool-panel-' + item.id} tabIndex={selected === item.id ? 0 : -1} disabled={disabled} onClick={() => onChange(item.id)}><ToolBrandIcon tool={item.id} size={22} /><span className="cmd-tool-tab-name">{item.name}</span><span className="cmd-tool-installed-dot" data-installed={item.installed} aria-hidden="true" /></button>)}</nav>;
}
function QuickSettings({ tool, values, disabled, onChange, isolated }) {
  const fields = quickSettingsFor(tool);
  return <div className="cmd-tool-quick-settings">{['通用配置', '快捷配置'].map(group => {
    const items = fields.filter(field => field.group === group);
    return items.length > 0 && <fieldset key={group}><legend>{group}</legend><div className="cmd-tool-fields">{items.map(field => <div key={field.key} className="cmd-tool-quick-field">{field.type === 'boolean' || field.type === 'select' ? <Select label={field.label} value={values[field.key] === undefined ? '' : String(values[field.key])} options={[{ value: '', label: '跟随工具默认' }, ...(field.type === 'boolean' ? [{ value: 'true', label: '开启' }, { value: 'false', label: '关闭' }] : field.options)]} disabled={disabled} onChange={value => onChange(field.key, value === '' ? undefined : field.type === 'boolean' ? value === 'true' : value)} /> : <label className="cmd-tool-field"><span>{field.label}</span><input type={field.type === 'number' ? 'number' : 'text'} min={field.min} max={field.max} step={field.type === 'number' ? 1 : undefined} placeholder="跟随工具默认" value={values[field.key] ?? ''} disabled={disabled} onChange={event => onChange(field.key, event.target.value === '' ? undefined : field.type === 'number' ? Number(event.target.value) : event.target.value)} /></label>}{field.description && <p className="cmd-tool-hint">{field.description}</p>}</div>)}</div></fieldset>;
  })}<p className="cmd-tool-hint">{fields.length ? isolated ? '未设置的选项跟随工具默认；保存后用于新的隔离会话。' : '快捷配置保存在 DSH+；此工具需另行预览并确认同步到本机。' : '此工具暂未提供已验证的快捷配置，可在高级选项中编辑支持的配置 JSON。'}</p></div>;
}

export function ToolSettingsSection({ close }) {
  const [data, setData] = useState(null), [providers, setProviders] = useState([]), [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState(() => profileDraft()), [models, setModels] = useState([]), [modelLoading, setModelLoading] = useState(false), [modelError, setModelError] = useState(''), [modelRevision, setModelRevision] = useState(0);
  const [job, setJob] = useState(null), [confirm, setConfirm] = useState(null), [preview, setPreview] = useState(null);
  const [downloadSource, setDownloadSource] = useState('mirror');
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
  const providerAccess = data?.providerAccess || [];
  const providerIdentity = providerAccess.find(item => item.id === draft.providerId) || providers.find(item => item.id === draft.providerId);
  const subscription = providerIdentity?.authMode === 'subscription';
  useEffect(() => { setDraft(profileDraft(profile)); setPreview(null); setModelError(''); setJob(tool?.job || null); }, [selected, profile]);
  useEffect(() => { setJob(tool?.job || null); }, [selected, tool?.job]);
  useEffect(() => { if (activeJob(job) && ['mirror', 'official'].includes(job.source)) setDownloadSource(job.source); }, [job?.id, job?.source, job?.status]);
  useEffect(() => {
    const controller = new AbortController(); setModels([]); setModelError(''); setModelLoading(false);
    if (!draft.providerId || subscription) return;
    setModelLoading(true); request('models', { providerId: draft.providerId }, controller.signal).then(value => { if (!controller.signal.aborted) setModels(value.models || []); }).catch(failure => { if (!controller.signal.aborted) setModelError(failure.message); }).finally(() => { if (!controller.signal.aborted) setModelLoading(false); });
    return () => controller.abort();
  }, [draft.providerId, subscription, modelRevision]);
  useEffect(() => {
    if (!activeJob(job)) return;
    const controller = new AbortController(); let timer;
    const poll = async () => { try { const value = await request('job', { id: job.id }, controller.signal); if (controller.signal.aborted) return; rememberJob(value.job); if (activeJob(value.job)) timer = setTimeout(poll, 1000); else setRevision(value => value + 1); } catch (failure) { if (!controller.signal.aborted) setError(failure.message); } };
    timer = setTimeout(poll, 650); return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status]);
  const run = async work => { setBusy(true); setError(''); setNotice(''); try { await work(); } catch (failure) { if (mounted.current) setError(failure.message); } finally { if (mounted.current) setBusy(false); } };
  const install = action => run(async () => { const value = await request(action, { tool: selected, ...(action !== 'uninstall' && tool?.installer === 'npm' ? { source: downloadSource } : {}) }); rememberJob(value.job); setConfirm(null); });
  const saveDefault = () => run(async () => {
    const overrides = parseOverrides(draft.overrides);
    const quickSettings = validateQuickSettings(selected, draft.quickSettings);
    if (subscription) throw Error('订阅登录请在模型选择器中使用对应工具，本机登录会保留');
    if (!draft.providerId || !draft.model.trim()) throw Error('请选择供应商和模型');
    const value = await request('saveProfile', { tool: selected, providerId: draft.providerId, model: draft.model.trim(), ...(draft.protocol ? { protocol: draft.protocol } : {}), quickSettings, overrides, ...(draft.revision !== undefined ? { expectedRevision: draft.revision } : {}) });
    setDraft(profileDraft(value.profile));
    setData(current => ({ ...current, profiles: array(current.profiles).filter(item => item.tool !== selected).concat(value.profile) }));
    const nativeOnly = tool.routeSupported === false || Object.keys(overrides).length > 0;
    if (!nativeOnly) await request('setDefault', { tool: selected, revision: value.profile.revision });
    setNotice(nativeOnly ? '配置方案已保存；本机未修改，可预览后单独确认同步。' : '默认方案已保存，新会话生效。本机配置未修改。'); setRevision(value => value + 1);
  });
  const change = (key, value) => { setDraft(current => ({ ...current, [key]: value, ...(key === 'providerId' ? { model: '' } : {}) })); setPreview(null); setNotice(''); };
  const bindings = data?.bindings || {}, available = eligibleProviders(providers, bindings, selected, providerAccess);
  const tools = data?.tools || [];
  const native = array(data?.native).find(item => item.tool === selected);
  const subscriptions = available.filter(item => (providerAccess.find(access => access.id === item.id) || item).authMode === 'subscription');
  const chooseTool = id => { if (!busy) { setNotice(''); setSelected(id); } };
  const hasManaged = tool?.managedInstalled || tool?.canReinstall || tool?.canUninstall;
  const nativeOnly = nativeOnlyDraft(tool, draft.overrides);
  const backups = array(data?.backups).filter(item => item.tool === selected || item.toolId === selected);
  return <section className="cmd-tool-settings" aria-busy={loading}>
    <header className="cmd-tool-heading"><div><h2>Harness 工具</h2><p>使用已有工具与登录，独立管理 DSH+ 的新会话方案。</p></div><Hint label="重新检测"><button type="button" className="cmd-tool-icon" disabled={loading || busy} aria-label="重新检测工具" onClick={() => setRevision(value => value + 1)}><UIIcon name="refresh" size={16} /></button></Hint></header>
    {error && <p className="cmd-tool-error" role="alert">{error}</p>}{notice && <p className="cmd-tool-notice" role="status">{notice}</p>}
    {loading && !data ? <p className="cmd-tool-empty" role="status">正在检测已安装工具…</p> : !data ? <button type="button" className="cmd-tool-button" onClick={() => setRevision(value => value + 1)}>重新加载</button> : <>
    <div className="cmd-tool-workbench"><ToolTabs tools={tools} selected={selected} disabled={busy} onChange={chooseTool} />
    {tool && <main className="cmd-tool-detail" role="tabpanel" id={'cmd-tool-panel-' + selected} aria-labelledby={'cmd-tool-tab-' + selected}><div className="cmd-tool-detail-heading"><div><h3><ToolBrandIcon tool={tool.id} size={22} />{tool.name}</h3><div className="cmd-tool-badges"><span data-ready={state.installed}>{state.installation}{tool.version ? ' · ' + tool.version : ''}</span><span data-ready={state.chatSupported}>{state.chatSupported ? '可对话' : '仅配置'}</span>{hasManaged && <span data-ready={tool.managedInstalled}>独立副本{tool.managedVersion ? ' · ' + tool.managedVersion : ''}</span>}</div></div><div className="cmd-tool-install-actions">{!hasManaged && <button type="button" className="cmd-tool-button" disabled={!state.canInstall || busy || activeJob(job)} title={tool.installReason || undefined} onClick={() => void install('install')}>{tool.systemExecutable || tool.source === 'external' ? '安装独立副本' : '安装'}</button>}{hasManaged && <><button type="button" className="cmd-tool-button" disabled={!state.canUpdate || busy || activeJob(job)} title={tool.updateReason || undefined} onClick={() => void install('update')}>更新副本</button><button type="button" className="cmd-tool-button" disabled={!state.canReinstall || busy || activeJob(job)} title={tool.reinstallReason || undefined} onClick={() => setConfirm({ kind: 'reinstall' })}>重装</button><button type="button" className="cmd-tool-button" disabled={!state.canUninstall || busy || activeJob(job)} title={tool.uninstallReason || undefined} onClick={() => setConfirm({ kind: 'uninstall' })}>卸载副本</button></>}</div></div>
      {tool.installer === 'npm' && <div className="cmd-tool-download"><DownloadSource value={downloadSource} onChange={setDownloadSource} disabled={busy || activeJob(job)} /><p className="cmd-tool-hint">{tool.runtimeNotice || '缺少 Node.js / npm 时自动准备，无需手动安装。'}</p></div>}
      <div className="cmd-tool-native-status"><UIIcon name="check" size={15} /><div><strong>{native?.hasConfiguration ? '已发现本机配置，保持原样' : '已有登录与本机配置由原工具管理'}</strong><p>保存方案只写入 DSH+。安装独立副本不会替换系统工具，卸载也保留配置与历史记录。</p></div></div>
      {(tool.systemExecutable || tool.managedExecutable) && <details className="cmd-tool-paths"><summary>安装位置{tool.systemExecutable && ' · 优先使用系统工具'}</summary>{tool.systemExecutable && <p><span>系统工具</span><code>{tool.systemExecutable}</code></p>}{tool.managedExecutable && <p><span>DSH+ 独立副本</span><code>{tool.managedExecutable}</code></p>}</details>}
      {!hasManaged && !tool.canInstall && tool.installReason && <p className="cmd-tool-hint">{tool.id === 'claude-desktop' ? 'Claude Desktop 需要使用官方平台安装器手动安装。' : tool.installReason}</p>}{state.installed && !tool.canUninstall && tool.uninstallReason && <p className="cmd-tool-hint">{tool.uninstallReason}</p>}
      {job && <div className="cmd-tool-job" role="status"><div><strong>{jobLabels[job.status] || job.status}</strong><span>{job.message}</span>{activeJob(job) && <button className="cmd-tool-button" type="button" disabled={busy} onClick={() => void run(async () => rememberJob((await request('cancel', { id: job.id })).job))}>取消任务</button>}</div>{activeJob(job) && <div className="cmd-tool-progress" aria-label="任务正在执行"><span /></div>}{job.error && <p className="cmd-tool-error">{job.error}</p>}{job.logs?.length > 0 && <details><summary>执行日志</summary><pre>{job.logs.join(String.fromCharCode(10))}</pre></details>}</div>}
      {state.configSupported ? <div className="cmd-tool-editor"><div className="cmd-tool-config"><div className="cmd-tool-config-heading"><h4>{tool.routeSupported === false ? '配置方案' : '新会话默认方案'}</h4><span>{tool.routeSupported === false ? '仅保存到 DSH+' : '独立于本机配置'}</span></div>
      <div className="cmd-tool-current-provider" aria-label="当前生效方案"><span className="cmd-tool-route-status">{defaultProfile && <UIIcon name="check" size={13} />}{defaultProfile ? '已生效' : '未设置'}</span>{defaultProfile && <ProviderBrandIcon id={currentProvider?.id || defaultProfile.providerId} name={currentProvider?.name || defaultProfile.providerId} declared={currentProvider?.declared} size={22} />}<div><strong>{defaultProfile ? currentProvider?.name || defaultProfile.providerId : '请选择供应商和模型'}</strong>{defaultProfile?.model && <small>{defaultProfile.model}</small>}</div></div>
      {providers.length > 0 && !available.length && <p className="cmd-tool-empty">请在「模型」设置中，为供应商启用此工具。</p>}{!providers.length && <p className="cmd-tool-empty">请先在「模型」设置中添加供应商。</p>}
      {tool.routeSupported === false && <p className="cmd-tool-hint">{tool.routeReason || '此工具暂不支持独立供应商配置'}。可保存方案，再单独预览同步到本机。</p>}{subscriptions.length > 0 && <div className="cmd-tool-subscription"><strong>订阅登录仅限 {tool.name}</strong><p>本机登录保持原样。在对话的模型选择器中选择此订阅及对应工具；尚未登录时请先在原工具中完成登录。</p>{subscriptions.map(item => <span key={item.id}>{item.name || item.id}</span>)}{close && <button type="button" className="cmd-tool-link" onClick={close}>返回对话选择模型</button>}</div>}<div className="cmd-tool-fields"><Select label="供应商" value={draft.providerId} options={available.map(item => ({ value: item.id, label: (item.name || item.id) + ((providerAccess.find(access => access.id === item.id) || item).authMode === 'subscription' ? ' · 订阅登录' : ''), icon: <ProviderBrandIcon id={item.id} name={item.name || item.id} declared={item.declared} size={18} /> }))} onChange={value => change('providerId', value)} disabled={busy || !available.length} empty="选择供应商" /><Select label={modelLoading ? '模型 · 加载中' : '模型'} value={subscription ? '' : draft.model} options={models.map(item => ({ value: item.id, label: item.name || item.id }))} onChange={value => change('model', value)} disabled={busy || modelLoading || !draft.providerId || subscription} empty={subscription ? '在对话模型选择器中使用' : '选择模型'} /></div>
      {modelError && <p className="cmd-tool-error" role="alert">模型加载失败：{modelError} <button type="button" className="cmd-tool-link" onClick={() => setModelRevision(value => value + 1)}>重试</button></p>}
      <QuickSettings key={selected} tool={selected} values={draft.quickSettings} disabled={busy || subscription} isolated={['claude', 'codex'].includes(selected)} onChange={(key, value) => change('quickSettings', setQuickSetting(draft.quickSettings, key, value))} />
      <div className="cmd-tool-footer"><span>{subscription ? '本机订阅登录保持原样，请从对话模型选择器使用。' : nativeOnly ? '高级 JSON 仅保存供本机同步，当前新会话默认不变。' : '沿用「模型」中的配置，本机记录不受影响。'}</span><button type="button" className="cmd-tool-button cmd-tool-primary" disabled={busy || subscription || !draft.providerId || !draft.model.trim()} onClick={() => void saveDefault()}>{busy ? '保存中…' : nativeOnly ? '保存配置方案' : '保存默认方案'}</button></div>
      <details className="cmd-tool-advanced"><summary>高级选项</summary><label className="cmd-tool-field"><span>自定义模型 ID</span><input value={draft.model} disabled={busy || subscription} placeholder="手动填写模型 ID" onChange={event => change('model', event.target.value)} /></label>
      {capability.protocols?.length > 0 && <Select label="协议" value={draft.protocol} options={[{ value: '', label: '自动选择' }, ...capability.protocols.map(protocol => ({ value: protocol, label: protocol }))]} disabled={busy || subscription} onChange={value => change('protocol', value)} />}
      <details className="cmd-tool-advanced"><summary>配置 JSON</summary><p className="cmd-tool-hint">填写 config / settings / auth / profile / meta 覆盖项，仅用于显式同步本机；隔离会话使用上方已验证的快捷配置。密钥与接口地址在「模型」设置中维护。</p><textarea spellCheck={false} aria-label={tool.name + ' 高级配置 JSON'} value={draft.overrides} disabled={busy || subscription} onChange={event => change('overrides', event.target.value)} /></details>
      <div className="cmd-tool-native-sync"><button type="button" className="cmd-tool-link" disabled={busy || subscription || !profile} onClick={() => void run(async () => { const result = await request('preview', { tool: selected }); setPreview(result.preview); })}>预览同步已保存方案到本机…</button><small>此操作会改写本机供应商配置，可能切换现有登录使用的接口。需单独确认并自动备份。</small></div>{native?.files?.length > 0 && <details className="cmd-tool-paths"><summary>本机配置文件</summary>{native.files.map(file => <p key={file.path}><span>{file.unavailable ? '无法检测' : file.exists ? '已存在' : '未创建'}</span><code>{file.path}</code></p>)}</details>}</details>
      {backups.length > 0 && <details className="cmd-tool-backups"><summary>配置备份 <small>{backups.length}</small></summary>{backups.map(backup => <div key={backup.id || backup.backupId}><span>{backup.createdAt ? new Date(backup.createdAt).toLocaleString('zh-CN') : backup.id || backup.backupId}</span><button type="button" className="cmd-tool-button" disabled={busy} onClick={() => setConfirm({ kind: 'restore', backupId: backup.id || backup.backupId })}>恢复</button></div>)}</details>}
      </div></div> : <p className="cmd-tool-empty">此工具暂不支持配置。</p>}
    </main>}</div></>}
    <Modal open={!!preview} onClose={() => { if (!busy) setPreview(null); }} title="确认同步到本机 CLI" closeLabel="关闭" className="cmd-tool-modal" description="此操作会修改下面列出的本机工具配置并创建备份，不修改历史记录。只设置新会话默认无需执行此操作。" footer={<><button type="button" className="cmd-tool-button" disabled={busy} onClick={() => setPreview(null)}>返回编辑</button><button type="button" className="cmd-tool-button cmd-tool-primary" disabled={busy || !preview?.files?.length} onClick={() => void run(async () => { await request('apply', { tool: selected, confirmNativeWrite: true, revision: preview.revision, checksums: previewChecksums(preview) }); setPreview(null); setNotice('配置已备份并应用'); setRevision(value => value + 1); })}>{busy ? '应用中…' : '备份并应用'}</button></>}>
      <div className="cmd-tool-preview">{preview?.files?.map(file => <div key={file.path}><code>{file.path}</code><span>{!file.exists ? '新建' : file.changed ? '更新' : '无变化'}</span></div>)}{!preview?.files?.length && <p>没有需要写入的配置文件。</p>}{preview?.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}{error && <p className="cmd-tool-error" role="alert">{error}</p>}</div>
    </Modal>
    <Modal className="cmd-tool-modal" open={!!confirm} onClose={() => { if (!busy) setConfirm(null); }} title={confirm?.kind === 'restore' ? '恢复这个备份？' : (confirm?.kind === 'reinstall' ? '重装 ' : '卸载 ') + (tool?.name || '') + ' 独立副本？'} closeLabel="关闭" description={confirm?.kind === 'restore' ? '将备份写回工具配置文件。请先结束正在运行的工具。' : confirm?.kind === 'reinstall' ? '重新下载并替换 DSH+ 管理的独立副本。系统安装、本机登录、配置与历史记录保留。' : '只移除由本插件管理的安装，系统工具、配置和历史记录保留。'} footer={<><button type="button" className="cmd-tool-button" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button type="button" className="cmd-tool-button" disabled={busy} onClick={() => confirm.kind === 'uninstall' || confirm.kind === 'reinstall' ? void install(confirm.kind) : void run(async () => { await request('restore', { backupId: confirm.backupId, confirmNativeWrite: true }); setConfirm(null); setNotice('配置备份已恢复'); setRevision(value => value + 1); })}>{busy ? '处理中…' : '确认'}</button></>}>{error && <p className="cmd-tool-error" role="alert">{error}</p>}</Modal>
  </section>;
}
