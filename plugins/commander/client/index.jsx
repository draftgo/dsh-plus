import { mountLinkSettings } from '../../link/client/app.jsx';
import { mountShellUi } from './shell-ui.jsx';
import { projectWorkspaces, recentRows, startSidebarSession, isSidebarSessionSelected, sidebarWorkspaces, ensureSidebarWorkspace, workspaceActivity, sidebarSessionStatus } from './sidebar-state.mjs';
import { apply as applyVoice } from '../voice/client/index.jsx';
import { applyMobileWorkbench } from './mobile-workbench.jsx';
import { UsageLauncher, UsageDialog, mountUsageStyle } from './usage.jsx';
import { ThemeLauncher, createThemeSource } from './theme-launcher.jsx';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import icons from './icons.json';
import { FishLogo, Tooltip, Modal, Menu, IconPinOutlineRegular, IconPinFillRegular, IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './style.css';
import fontCss from './fonts.css';
import { UIIcon } from './iconsax.jsx';
import { mountModelPicker } from './model-picker.jsx';
import { mountProviderSettings } from './provider-settings.jsx';
import { ProjectPicker } from './project-picker.jsx';
import { ToolSettingsSection, mountToolSettingsStyle } from './tool-settings.jsx';
import { conversationInfo, copyConversationInfo } from './session-info.mjs';
import { startSidebarPolling } from './sidebar-refresh.mjs';
import { UpdateLauncher, mountUpdatesStyle } from './updates.jsx';
import { mountBrand } from '../../link/client/brand.jsx';

const names = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi', opencode: 'OpenCode', gemini: 'Gemini CLI', hermes: 'Hermes', grok: 'Grok Build', mcode: 'MiniMax Code', deepseek: 'DeepSeek' };
const liveStates = new Set(['running', 'connecting', 'waiting']);
const states = { idle: '就绪', completed: '已完成 · 未读', running: '运行中', connecting: '连接中', disconnected: '未连接', waiting: '等待回复或授权', failed: '失败', closed: '已关闭' };
const listeners = new Set();
let defaultWorkspaceId;
let data = { projects: [], sessions: [], selected: null, projectId: null, error: '', loaded: false };
const NO_FORK_ACCESS = { getSnapshot: () => false, subscribe: () => () => {} };
const STATE_TIMEOUT_MS = 45_000;
const connectionMessage = error => {
  const message = String(error?.message || error || '');
  if (error?.name === 'TimeoutError' || /timed out|timeout|failed to fetch|network error|load failed/i.test(message)) return '工作台响应较慢，正在自动重试…';
  return message;
};
function update(patch) { if(patch.projects)patch={...patch,projects:patch.projects.map(project=>({...project,isDefault:project.id===defaultWorkspaceId}))};data = { ...data, ...patch }; for (const fn of listeners) fn(); }
function useData() { return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => data); }
async function api(action, args = {}, signal) {
  const res = await fetch(new URL('api/commander', document.baseURI), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }), signal });
  const value = await res.json(); if (!res.ok) throw new Error(value.error ?? `HTTP ${res.status}`); return value;
}
let stateSignature;
async function refresh(signal) {
  const next = await api('state', {}, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(STATE_TIMEOUT_MS)]));
  const signature = JSON.stringify(next);
  if (signature === stateSignature && data.loaded && !data.error) return;
  stateSignature = signature; update({ ...next, loaded: true, error: '' });
}
function Icon({ provider, size = 18 }) {
  return <span className={`cmd-icon cmd-${provider}`} aria-label={names[provider]} style={{ width: size, height: size }}>{provider === 'deepseek' ? <FishLogo size={size} /> : icons[provider] ? <img width={size} height={size} src={`data:image/svg+xml,${encodeURIComponent(icons[provider])}`} alt="" /> : 'π'}</span>;
}
function Activity({ status, className = '' }) {
  if (!liveStates.has(status) && status !== 'failed' && status !== 'completed') return null;
  return <span className={`cmd-activity cmd-status-${status} ${className}`} role="img" aria-label={states[status]} title={states[status]}><i aria-hidden="true" /></span>;
}
function SessionIcon({ provider, status }) {
  return liveStates.has(status) || status === 'failed' || status === 'completed' ? <Activity status={status} /> : <Icon provider={provider} size={16} />;
}
function SettingsLauncher({ host, wide, settingsOpen, openSettings, settingsShortcut, theme }) {
  const d = useData();
  return <div className={`cmd-settings-row ${wide ? '' : 'cmd-settings-row-rail'}`}><Tooltip label="设置" side="right" delayMs={450} portal><button type="button" className="cmd-settings" aria-label="设置" aria-haspopup="dialog" aria-expanded={settingsOpen} aria-keyshortcuts={settingsShortcut?.aria} onClick={() => openSettings()}><UIIcon name="settings" size={16} selected={settingsOpen} /></button></Tooltip><ThemeLauncher theme={theme} /><UpdateLauncher host={host} wide={false} /><UsageLauncher /><UsageDialog /><Hint label={d.showArchived ? '返回最近对话' : '已归档对话'}><button type="button" className="cmd-archive-launcher" aria-label="查看归档" aria-pressed={!!d.showArchived} disabled={!!d.archiveTransitioning} onClick={() => document.dispatchEvent(new Event('commander:toggle-archive'))}><UIIcon name="archive" size={16} selected={!!d.showArchived} /></button></Hint></div>;
}
function Hint({ label, children }) { return <Tooltip label={label} delayMs={450} portal>{children}</Tooltip>; }
function ErrorLine({ message }) { return message ? <div className="cmd-error" role="alert">{message}</div> : null; }

export const inject = ['slots', 'layout', 'uiWorkspace', 'uiSession', 'sessions', 'locale', 'remote', 'remote.session', 'workspaces', 'modelDirectories', 'conversation', 'theme'];
export function apply(ctx) {
  mountBrand(ctx);
  applyVoice(ctx);
  mountLinkSettings(ctx);
  mountShellUi(ctx);
  applyMobileWorkbench(ctx);
  mountUsageStyle(ctx);
  mountUpdatesStyle(ctx);
  mountModelPicker(ctx);
  mountProviderSettings(ctx);
  mountToolSettingsStyle(ctx);
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'harness-tools', order: 32, label: () => 'Harness 工具', inject: () => ({ ctx }) }, ToolSettingsSection));
  const style = document.createElement('style'); style.textContent = fontCss + css; document.head.append(style); ctx.effect(() => () => style.remove());
  let ensuringRecent;
  const ensureRecent = () => {
    if (ensuringRecent) return ensuringRecent;
    ensuringRecent = (async () => {
      const workspace = await ensureSidebarWorkspace(ctx, args => api('ensureRecent', args));
      defaultWorkspaceId = workspace.workspaceId;
      update({ projects: data.projects });
      return workspace;
    })().finally(() => { ensuringRecent = undefined; });
    return ensuringRecent;
  };
  void ensureRecent().catch(error=>update({error:error.message}));
  const stopPolling = startSidebarPolling({ refresh, onError: error => update({ error: connectionMessage(error) }), isActive: () => data.sessions.some(session => liveStates.has(session.status)) });
  ctx.effect(() => () => { stopPolling(); stateSignature = undefined; listeners.clear(); });
  const opening = new Map();
  const open = id => {
    if (opening.has(id)) return opening.get(id);
    const operation = (async () => {
      const native = data.sessions.find(s => s.id === id);
      if (!native) throw new Error('会话不存在，请刷新后重试');
      if (!native.ownerSessionId?.startsWith('commander-web:') && (!native.parentId || native.harnessAdopted)) { update({ selected: id, projectId: native.projectId }); ctx.uiWorkspace.openSession(native.ownerSessionId); return; }
      if (['running', 'connecting', 'waiting'].includes(native.status)) throw new Error('旧版会话仍在运行，请先完成或中断后迁移到官方界面');
      const harnessId = await ctx.sessions.create({ workspaceId: native.projectId });
      await ctx.sessions.using(harnessId, { source: 'workspaceOperation' }, async reference => {
        await reference.ready;
        const selected = await ctx.remote.session.selectModel({ sessionId: harnessId, provider: `commander-${native.provider}`, model: native.model || 'native-default' });
        if (!selected.ok) throw new Error(selected.error.message);
        await api('adopt', { id, harnessSessionId: harnessId });
        update({ selected: id, projectId: native.projectId });
        ctx.uiWorkspace.openSession(harnessId);
      });
      await refresh();
    })();
    opening.set(id, operation);
    operation.finally(() => opening.delete(id)).catch(() => { /* The caller displays the original failure. */ });
    return operation;
  };
  const newSession = projectId => { void startSidebarSession(ctx, data.projects, projectId, defaultWorkspaceId, ensureRecent).then(target => update({ projectId: target, selected: null, error: '' })).catch(error => update({ error: error.message })); };
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark', priority: -10 }, () => null));
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', priority: -10 }, () => null));
  for (const name of ['conversation.hero.brand.mark']) ctx.slots.inject(name, () => ctx.slots.register({ name, priority: -10 }, () => null));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'desktop-onboarding', priority: -10 }, () => null));
  for (const [id, name] of [['plugins','plugins'], ['schedules','schedules']]) ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, priority: -10, order: id === 'plugins' ? 0 : 10, label: () => id === 'plugins' ? '插件' : '自动化任务' }, ({ active }) => <UIIcon name={name} size={16} selected={active} />));
  const theme = createThemeSource(ctx);
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher', priority: -10, inject: () => ({ host: ctx, theme }) }, SettingsLauncher));
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({ name: 'sidebar.workspaces', priority: -10, inject: () => ({ host: ctx, open, newSession }) }, Projects));
}

function Projects({ host, open, newSession, expandSidebar, wide = true }) {
  const harness = useSyncExternalStore(fn => host.sessions.list.subscribe(fn), () => host.sessions.list.getSnapshot());
  const workspaces = useSyncExternalStore(fn => host.workspaces.list.subscribe(fn), () => host.workspaces.list.getSnapshot());
  const statuses = useSyncExternalStore(fn => host.uiSession.sessionStatus.subscribe(fn), () => host.uiSession.sessionStatus.getSnapshot());
  const archivedIds = new Set(workspaces.archivedSessionIds ?? []);
  const d = useData();
  const workspaceProjects = sidebarWorkspaces(workspaces, d.projects, defaultWorkspaceId);
  const projectsLoaded = workspaces.phase === 'ready' || workspaceProjects.length > 0 || d.loaded;
  const [actionSession, setActionSession] = useState(null), [confirmDelete, setConfirmDelete] = useState(null);
  const actionAnchor = useRef(null);
  const [busy, setBusy] = useState(false), [copyStatus, setCopyStatus] = useState('');
  const [sections, setSections] = useState(() => {
    try { return { projects: true, recent: true, ...JSON.parse(localStorage.getItem('commander.sidebar.sections') || '{}') }; }
    catch { return { projects: true, recent: true }; }
  });
  const toggleSection = name => setSections(value => {
    const next = { ...value, [name]: !value[name] };
    try { localStorage.setItem('commander.sidebar.sections', JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
    return next;
  });
  const [adding, setAdding] = useState(false), [error, setError] = useState('');
  const [renameTarget, setRenameTarget] = useState(null);
  const [filter, setFilter] = useState(''), [searching, setSearching] = useState(false), [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [archivePhase, setArchivePhase] = useState('idle');
  const archiveTimers = useRef([]), archiveSwitching = useRef(false);
  useEffect(() => () => archiveTimers.current.forEach(clearTimeout), []);
  const switchArchive = () => {
    if (archiveSwitching.current) return;
    setSections(value => ({ ...value, recent: true }));
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShowArchived(value => !value); return; }
    archiveSwitching.current = true;
    setArchivePhase('out');
    archiveTimers.current = [setTimeout(() => {
      setShowArchived(value => !value); setArchivePhase('in');
      archiveTimers.current.push(setTimeout(() => { setArchivePhase('idle'); archiveSwitching.current = false; }, 190));
    }, 110)];
  };

  useEffect(() => { update({ showArchived, archiveTransitioning: archivePhase !== 'idle' }); }, [showArchived, archivePhase]);
  useEffect(() => {
    const toggle = () => { if (!wide) expandSidebar?.(); switchArchive(); };
    document.addEventListener('commander:toggle-archive', toggle);
    return () => document.removeEventListener('commander:toggle-archive', toggle);
  });

  const activeHarnessId = Object.keys(harness.byId).find(id => (harness.byId[id].retainedBy?.mainView ?? 0) > 0);
  const nativeFor = id => d.sessions.filter(s => s.ownerSessionId === id && (!s.parentId || s.harnessAdopted)).sort((a,b) => Number(b.updatedAt)-Number(a.updatedAt))[0];
  const matches = row => !filter || `${row.title} ${row.provider} ${row.model || ''}`.toLowerCase().includes(filter.toLowerCase());
  const rows = [
    ...d.sessions.filter(s => (!harness.byId[s.ownerSessionId] || (s.parentId && !s.harnessAdopted)) && (s.title || ['running', 'waiting', 'connecting', 'failed'].includes(s.status)) && (showArchived ? s.archived : !s.archived)).map(s => ({ ...s, status: sidebarSessionStatus(undefined, statuses.get(s.id), s), native: true })),
    ...workspaceProjects.flatMap(p => p.sessionIds.filter(id => harness.byId[id] && !harness.byId[id].blank && !(d.deletedHarnessIds ?? []).includes(id) && archivedIds.has(id) === showArchived).map(id => ({ id, archived: archivedIds.has(id), nativeId: nativeFor(id)?.id, projectId: p.id, title: harness.byId[id].displayTitle || harness.byId[id].title || '新对话', provider: nativeFor(id)?.provider ?? 'deepseek', model: nativeFor(id)?.model, status: sidebarSessionStatus(harness.byId[id], statuses.get(id), nativeFor(id)), updatedAt: harness.byId[id].updatedAt }))),
  ].filter(matches).sort((a, b) => Number(workspaces.pinnedSessionIds?.includes(b.id) ?? false) - Number(workspaces.pinnedSessionIds?.includes(a.id) ?? false)
    || (Number(b.updatedAt) || Date.parse(b.updatedAt) || 0) - (Number(a.updatedAt) || Date.parse(a.updatedAt) || 0));
  // Workspace activity includes collapsed projects and every live native delegate.
  const live = [
    ...d.sessions.filter(s => !s.archived && liveStates.has(s.status)).map(s => ({ ...s, native: true })),
    ...Object.values(harness.byId).filter(s => !archivedIds.has(s.id) && !(d.deletedHarnessIds ?? []).includes(s.id) && (statuses.get(s.id)?.pendingInteraction || (statuses.get(s.id)?.running ?? s.running)) && !nativeFor(s.id)).map(s => ({ ...s, provider: 'deepseek', status: statuses.get(s.id)?.pendingInteraction ? 'waiting' : 'running' })),
  ];
  const projects = projectWorkspaces(workspaceProjects);
  const recents = recentRows(rows, workspaceProjects);
  const recentActivity = workspaceActivity(workspaceProjects.find(p => p.isDefault), live);
  const currentActionSession = actionSession && (rows.find(session => session.id === actionSession.id) || actionSession);
  const forkAccess = host.get?.('remoteAccess')?.source('session', currentActionSession?.id || '', 'session/fork') || NO_FORK_ACCESS;
  const canFork = useSyncExternalStore(forkAccess.subscribe, forkAccess.getSnapshot, forkAccess.getSnapshot);
  const operate = async (s, action) => {
    setBusy(true); setError('');
    try {
      if (action === 'delete') {
        if (!s.native) { await host.workspaces.archiveSession(s.id); await api('dismiss', { harnessSessionId: s.id }); }
        if (s.native || s.nativeId) await api('delete', { id: s.native ? s.id : s.nativeId });
        if (isSidebarSessionSelected(s, activeHarnessId)) newSession(s.projectId);
        setConfirmDelete(null);
      } else {
        if (s.native) await api('archive', { id: s.id, archived: !showArchived });
        else {
          await (showArchived ? host.workspaces.unarchiveSession(s.id) : host.workspaces.archiveSession(s.id));
          if (s.nativeId) await api('archive', { id: s.nativeId, archived: !showArchived });
        }
      }
      setActionSession(null); await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const row = s => {
    const selected = isSidebarSessionSelected(s, activeHarnessId);
    return <div key={s.id} className={`cmd-session-row ${selected ? 'is-selected' : ''}`}>
    <button type="button" aria-label={wide ? undefined : `${names[s.provider]} · ${s.title || "对话"}`} className={`cmd-session ${liveStates.has(s.status) ? 'cmd-is-active' : ''} ${selected ? 'cmd-selected' : ''}`} aria-current={selected ? 'page' : undefined} onClick={() => { setActionSession(null); if(s.native) open(s.id).catch(e => setError(e.message)); else { update({ selected: null, projectId: s.projectId }); host.uiWorkspace.openSession(s.id); } }}><SessionIcon provider={s.provider} status={s.status} />{wide && <span>{s.title || names[s.provider]}</span>}</button>
    {wide && <Tooltip label="对话操作" delayMs={450} portal><button type="button" className="cmd-session-more" aria-label={'对话操作：' + (s.title || names[s.provider])} aria-expanded={actionSession?.id === s.id} aria-haspopup="menu" onClick={event => { actionAnchor.current = event.currentTarget; setActionSession(actionSession?.id === s.id ? null : s); setCopyStatus(''); setError(''); }}><UIIcon name="more" size={16} /></button></Tooltip>}
  </div>;
  };
  return <section className={`cmd-projects ${wide ? '' : 'cmd-narrow'}`} aria-label="项目与对话">
    <nav className="cmd-sidebar-nav" aria-label="快捷工具栏">
      <Tooltip label="新聊天" delayMs={450} portal><button type="button" className="cmd-new-chat" onClick={() => newSession()} aria-label="创建新聊天"><UIIcon name="edit" size={16} /></button></Tooltip>
      <Tooltip label="搜索对话" delayMs={450} portal><button type="button" className="cmd-search-toggle" onClick={() => { if (!wide) expandSidebar?.(); if (wide && searching) setFilter(''); setSearching(!wide || !searching); }} aria-label="搜索对话" aria-expanded={searching} aria-pressed={searching}><UIIcon name="search" size={16} /></button></Tooltip>
    </nav>
    {wide && searching && <div className="cmd-search-panel"><label className="cmd-search-field"><UIIcon name="search" size={16} /><input autoFocus className="cmd-search" placeholder="搜索对话…" aria-label="搜索对话内容" value={filter} onChange={e => setFilter(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setSearching(false); setFilter(''); } }} /><Hint label="关闭搜索"><button type="button" aria-label="关闭搜索" onClick={() => { setSearching(false); setFilter(''); }}><UIIcon name="plus" size={14} className="cmd-search-close" /></button></Hint></label></div>}
    <div className="cmd-sidebar-content">
    <div className="cmd-section-title">{wide && <button type="button" className="cmd-section-toggle" aria-expanded={sections.projects} aria-controls="cmd-project-section" onClick={() => toggleSection('projects')}><span>项目</span><UIIcon name="chevronDown" size={12} /></button>}<Hint label="添加项目"><button aria-label="添加项目目录" onClick={() => { if (!wide) expandSidebar?.(); setAdding(!wide || !adding); }}><UIIcon name="plus" size={16} /></button></Hint></div>
    {adding && <ProjectPicker host={host} api={api} onClose={() => setAdding(false)} onSelected={async project => { await refresh(); setAdding(false); newSession(project.id); }} />}

    <ErrorLine message={d.error || error} />
    <div id="cmd-project-section" className="cmd-section-body" data-open={!wide || sections.projects} inert={wide && !sections.projects ? '' : undefined}><div className="cmd-section-inner">
    {!projectsLoaded && wide && <p className="cmd-sidebar-empty">正在读取项目…</p>}
    {projects.map(p => {
      const activity = workspaceActivity(p, live);
      return <div className="cmd-project" key={p.id}><div className="cmd-project-name"><button aria-label={wide ? undefined : activity ? `${p.title}，${states[activity]}` : p.title} aria-expanded={!!expanded[p.id]} onClick={() => { if (!wide) expandSidebar?.(); setExpanded(v => ({ ...v, [p.id]: !wide || !v[p.id] })); }}><UIIcon name="folder" size={16} selected={!!expanded[p.id]} />{wide && <span>{p.title}</span>}{activity && <Activity status={activity} className="cmd-project-activity" />}{wide && <UIIcon name="chevronDown" className={expanded[p.id] ? 'cmd-project-chevron cmd-rotated' : 'cmd-project-chevron'} size={12} />}</button><Hint label="新聊天"><button className="cmd-project-new" onClick={() => newSession(p.id)} aria-label={`在 ${p.title} 新聊天`}><UIIcon name="plus" size={16} /></button></Hint></div>{wide && expanded[p.id] && <div className="cmd-project-children">{rows.filter(s => s.projectId === p.id || s.cwd === p.path).map(row)}{!rows.some(s => s.projectId === p.id || s.cwd === p.path) && <p className="cmd-sidebar-empty">还没有对话</p>}</div>}</div>;
    })}
    {wide && projectsLoaded && !projects.length && <p className="cmd-sidebar-empty">暂无项目</p>}
    </div></div>
    <div className="cmd-section-title cmd-recent-title">{wide && <button type="button" className="cmd-section-toggle" aria-expanded={sections.recent} aria-controls="cmd-recent-section" onClick={() => toggleSection('recent')}><span className="cmd-section-label">{showArchived ? '已归档' : '最近'}{!showArchived && recentActivity && <Activity status={recentActivity} />}</span><UIIcon name="chevronDown" size={12} /></button>}<Hint label="新聊天"><button type="button" aria-label="最近新聊天" onClick={() => newSession()}><UIIcon name="plus" size={16} /></button></Hint></div>
    <div id="cmd-recent-section" className="cmd-section-body" data-open={!wide || sections.recent} inert={wide && !sections.recent ? '' : undefined}><div className="cmd-section-inner"><div className="cmd-recents" data-transition={archivePhase}>{recents.map(row)}{wide && d.loaded && !recents.length && (filter || showArchived) && <p className="cmd-sidebar-empty">{filter ? '没有找到对话' : '暂无归档对话'}</p>}</div></div></div>
    </div>
    <Menu open={!!actionSession} onClose={() => { if(!busy)setActionSession(null); }} anchor={null} getAnchorRect={() => actionAnchor.current?.getBoundingClientRect() ?? null} side="right" align="end" portal autoFocus compact listClassName="cmd-actions-popover">
      {currentActionSession && <>
        <div className="cmd-session-details"><Icon provider={currentActionSession.provider} size={16} /><span>{names[currentActionSession.provider] || currentActionSession.provider}{currentActionSession.model ? ' · ' + currentActionSession.model : ''}</span></div>
        <div className="cmd-session-actions">
          {!currentActionSession.native && !showArchived && <button type="button" role="menuitem" disabled={busy} onClick={async () => {
            setBusy(true); setError('');
            try {
              const pinned = workspaces.pinnedSessionIds?.includes(currentActionSession.id);
              if (pinned) await host.uiWorkspace.unpinSession(currentActionSession.id);
              else await host.uiWorkspace.pinSession(currentActionSession.id);
              setActionSession(null);
            } catch (e) { setError(e.message); }
            finally { setBusy(false); }
          }}>{workspaces.pinnedSessionIds?.includes(currentActionSession.id) ? <IconPinFillRegular size={16} /> : <IconPinOutlineRegular size={16} />}<span>{workspaces.pinnedSessionIds?.includes(currentActionSession.id) ? '取消置顶' : '置顶会话'}</span></button>}
          {!currentActionSession.native && <button type="button" role="menuitem" disabled={busy} onClick={() => {
            setRenameTarget(currentActionSession); setActionSession(null); setError('');
          }}><UIIcon name="edit" size={16} /><span>重命名</span></button>}
          {!currentActionSession.native && canFork && <button type="button" role="menuitem" disabled={busy || ['running', 'waiting', 'connecting', 'stopping'].includes(currentActionSession.status)} onClick={async () => {
            setBusy(true); setError('');
            try { await host.uiWorkspace.forkSession(currentActionSession.id, undefined, { allowMigration: false }); setActionSession(null); }
            catch (e) { setError(e.message); }
            finally { setBusy(false); }
          }}><IconBranchOutlineRegular size={16} /><span>分叉会话</span></button>}
          <div className="cmd-session-action-divider" role="separator" />
          <button type="button" role="menuitem" disabled={busy} onClick={() => void operate(currentActionSession, 'archive')}><UIIcon name="archive" size={16} /><span>{showArchived ? '取消归档' : '归档对话'}</span></button>
          <div className="cmd-session-action-divider" role="separator" />
          <button type="button" role="menuitem" disabled={busy} onClick={async () => {
            setBusy(true); setCopyStatus('');
            try {
              const current = data.sessions.find(item => item.id === (currentActionSession.native ? currentActionSession.id : currentActionSession.nativeId));
              const project = workspaceProjects.find(item => item.id === currentActionSession.projectId);
              await copyConversationInfo(conversationInfo(currentActionSession, current, project));
              setCopyStatus('已复制完整会话信息');
            } catch { setCopyStatus('复制失败，请手动复制下方信息'); }
            finally { setBusy(false); }
          }}><UIIcon name="link" size={16} /><span>复制对话 ID</span></button>
          <button type="button" role="menuitem" className="cmd-danger" disabled={busy} onClick={() => { setConfirmDelete(actionSession); setActionSession(null); }}><UIIcon name="trash" size={16} /><span>删除对话</span></button>
        </div>
        {copyStatus && <p className="cmd-copy-status" role="status">{copyStatus}</p>}
        {copyStatus.startsWith('复制失败') && <textarea className="cmd-copy-fallback" aria-label="完整会话信息" readOnly value={JSON.stringify(conversationInfo(currentActionSession, data.sessions.find(item => item.id === (currentActionSession.native ? currentActionSession.id : currentActionSession.nativeId)), workspaceProjects.find(item => item.id === currentActionSession.projectId)), null, 2)} onFocus={event => event.target.select()} />}
        <ErrorLine message={error} />
      </>}
    </Menu>
    <SessionRenameDialog target={renameTarget} host={host} onClose={() => setRenameTarget(null)} onRenamed={refresh} />
    <Modal open={!!confirmDelete} onClose={() => { if(!busy)setConfirmDelete(null); }} title="删除这条对话？" closeLabel="关闭" description="从对话列表移除，并释放 DSH-Plus 管理记录。服务器日志、原生工具历史和项目文件会保留。" footer={<><button className="cmd-dialog-button" disabled={busy} onClick={() => setConfirmDelete(null)}>取消</button><button className="cmd-dialog-button cmd-danger" disabled={busy} onClick={() => void operate(confirmDelete, 'delete')}>{busy ? '删除中…' : '删除对话'}</button></>}><ErrorLine message={error} /></Modal>
  </section>;
}

function SessionRenameDialog({ target, host, onClose, onRenamed }) {
  const [title, setTitle] = useState(target?.title || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setTitle(target?.title || ''); setError(''); }, [target?.id]);
  const submit = async event => {
    event?.preventDefault();
    const nextTitle = title.trim();
    if (!target || !nextTitle || busy) return;
    setBusy(true); setError('');
    try {
      const result = await host.sessions.using(target.id, { source: 'workspaceOperation' }, reference => reference.binding.session.rename(nextTitle));
      if (!result.ok) throw new Error(result.error.message);
      await onRenamed(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Modal open={!!target} onClose={() => { if (!busy) onClose(); }} title="重命名会话" closeLabel="关闭" footer={<><button className="cmd-dialog-button" disabled={busy} onClick={onClose}>取消</button><button className="cmd-dialog-button cmd-dialog-primary" disabled={busy || !title.trim()} onClick={submit}>{busy ? '保存中…' : '保存'}</button></>}>
    <form className="cmd-rename-form" onSubmit={submit}><label htmlFor="cmd-session-rename">会话名称</label><input id="cmd-session-rename" autoFocus value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /><ErrorLine message={error} /></form>
  </Modal>;
}
