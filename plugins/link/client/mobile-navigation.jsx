import React, { useEffect, useRef } from 'react';
import { UIIcon } from '../../commander/client/iconsax.jsx';
import { StatusDot } from './app.jsx';
import { recentSessions, sessionGroups } from './mobile-state.mjs';

export function SessionSearch({ value, onChange, label = '搜索会话或项目' }) {
  return <label className="link-session-search"><UIIcon name="search" size={18} /><input type="search" aria-label={label} placeholder="搜索会话或项目" value={value} onChange={event => onChange(event.target.value)} autoComplete="off" />{value && <button type="button" aria-label="清除搜索" onClick={() => onChange('')}><UIIcon name="close" size={16} /></button>}</label>;
}
export function MobileEmpty({ title, children }) {
  return <div className="link-mobile-empty"><UIIcon name="archive" size={26} /><h2>{title}</h2><p>{children}</p></div>;
}
export function SessionList({ sessions, projects, selectedId, onChoose, compact = false, disabled = false }) {
  const names = new Map((projects || []).map(project => [project.id, project.name]));
  return sessionGroups(sessions).map(group => <section className={compact ? 'link-sidebar-group' : 'link-session-group'} key={group.label}><h2>{group.label}</h2><div className="link-session-list">{group.items.map(item => <button type="button" key={item.id} className={compact ? 'link-sidebar-session' : 'link-recent-row'} aria-current={selectedId === item.id ? 'page' : undefined} onClick={() => onChoose(item)} disabled={disabled}>{!compact && <span className="link-recent-glyph"><UIIcon name="archive" size={19} /></span>}<span className="link-recent-copy"><strong>{item.title || '新会话'}</strong><small>{names.get(item.projectId) || '工作区'}{item.running ? ' · 运行中' : ''}</small></span><span className="link-row-meta">{item.running ? <><StatusDot state="running" />{!compact && '进行中'}</> : relativeTime(item.updatedAt || item.createdAt)}</span></button>)}</div></section>);
}
export function MobileSidebar({ state, screen, selectedId, onChoose, onNavigate, onNew, onClose, connectionLabel, connectionState, theme, onTheme, disabled }) {
  const panel = useRef(null);
  const [query, setQuery] = React.useState('');
  useEffect(() => {
    const active = document.activeElement;
    // Touch browsers may retain textarea focus when a menu button is tapped.
    // Restore the opener instead of reopening the keyboard when the drawer closes.
    const previous = active?.matches('input, textarea, [contenteditable="true"]')
      ? panel.current?.closest('.link-mobile')?.querySelector('[aria-controls="link-mobile-sidebar"]') : active;
    panel.current?.querySelector('button')?.focus({ preventScroll: true });
    const keydown = event => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...(panel.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]') || [])].filter(node => node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); previous?.isConnected && previous.focus({ preventScroll: true }); };
  }, [onClose]);
  const sessions = recentSessions(state?.sessions || [], state?.projects || [], query);
  return <div className="link-drawer-layer"><button className="link-drawer-scrim" tabIndex={-1} aria-label="关闭侧边栏遮罩" onClick={onClose} /><aside id="link-mobile-sidebar" className="link-sidebar" role="dialog" aria-modal="true" aria-label="会话导航" ref={panel}><header className="link-sidebar-header"><span className="link-mobile-brand">Harness <span className="link-mobile-brand-sub">Plus</span></span><button type="button" className="link-mobile-icon-button" aria-label="关闭侧边栏" aria-controls="link-mobile-sidebar" aria-expanded="true" onClick={onClose}><UIIcon name="collapse" size={22} /></button></header><button className="link-sidebar-new" onClick={onNew} disabled={disabled}><UIIcon name="edit" size={19} />新会话<UIIcon name="plus" size={17} /></button><nav className="link-sidebar-nav" aria-label="主导航"><button onClick={() => onNavigate('recent')} aria-current={screen === 'recent' ? 'page' : undefined}><UIIcon name="archive" size={19} />最近<span>{state?.sessions?.length || 0}</span></button></nav><SessionSearch value={query} onChange={setQuery} label="搜索侧边栏会话" /><div className="link-sidebar-scroll">{sessions.length ? <SessionList sessions={sessions} projects={state?.projects} selectedId={selectedId} onChoose={onChoose} compact disabled={disabled} /> : <p className="link-empty">{query ? '没有找到匹配的会话' : '新会话会出现在这里'}</p>}</div><footer className="link-sidebar-footer"><button className="link-sidebar-host" onClick={() => onNavigate('connection')} aria-label="连接管理"><UIIcon name="link" size={19} /><span><strong>{state?.host?.name || '我的工作台'}</strong><small><StatusDot state={connectionState} />{connectionLabel}</small></span></button><button className="link-mobile-icon-button" aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'} onClick={onTheme}><UIIcon name="settings" size={19} /></button></footer></aside></div>;
}
function relativeTime(value) {
  if (!value) return '';
  const time = typeof value === 'number' || /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const elapsed = Math.max(0, Date.now() - time);
  return elapsed < 60000 ? '刚刚' : elapsed < 3600000 ? Math.floor(elapsed / 60000) + ' 分钟' : elapsed < 86400000 ? Math.floor(elapsed / 3600000) + ' 小时' : new Date(time).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
