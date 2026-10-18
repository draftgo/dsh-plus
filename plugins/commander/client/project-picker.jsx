import React, { useEffect, useId, useRef, useState } from 'react';
import { LinkIconMedium, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon } from './iconsax.jsx';

/** Browsing selects host folders; an Electron chooser is only offered by the desktop bridge. */
export function ProjectPicker({ api, onClose, onSelected }) {
  const [tab, setTab] = useState('browse'), [listing, setListing] = useState(null), [query, setQuery] = useState('');
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [browseError, setBrowseError] = useState('');
  const generation = useRef(0), mounted = useRef(true), browseTarget = useRef(), id = useId();
  const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
  const browse = async path => {
    const version = ++generation.current; browseTarget.current = path; setLoading(true); setBrowseError(''); setError(''); setQuery('');
    try { const result = await api('browse', path ? { path } : {}); if (mounted.current && version === generation.current) setListing(result); }
    catch (e) { if (mounted.current && version === generation.current) { setListing(null); setBrowseError(e.message); } }
    finally { if (mounted.current && version === generation.current) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; void browse(); return () => { mounted.current = false; generation.current++; }; }, []);
  const add = async operation => {
    if (busy) return; setBusy(true); setError('');
    try { const result = await operation(); if (result?.project) await onSelected(result.project); }
    catch (e) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const select = () => add(() => api('project', { path: listing.path }));
  const pick = () => add(async () => { const path = await desktop.pick(); return path ? api('project', { path }) : null; });
  const clone = e => { e.preventDefault(); void add(() => api('clone', { url: url.trim() })); };
  const changeTab = value => { setTab(value); setError(''); };
  const tabKeys = e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 'browse' : e.key === 'End' ? 'github' : tab === 'browse' ? 'github' : 'browse';
    changeTab(next); document.getElementById(`${id}-${next}-tab`)?.focus();
  };
  const entries = (listing?.entries ?? []).filter(entry => entry.name.toLowerCase().includes(query.trim().toLowerCase()));
  const folderName = listing?.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || listing?.path;
  const close = () => { if (!busy) onClose(); };
  return <Modal open headless onClose={close} title="添加项目" className="cmd-project-dialog">
    <header className="cmd-project-header"><h2>添加项目</h2><button type="button" className="cmd-project-icon-button" aria-label="关闭" disabled={busy} onClick={close}><UIIcon name="close" size={16} /></button></header>
    <div className="cmd-project-content">
      <div className="cmd-project-tabs" role="tablist" aria-label="添加方式">
        <button type="button" role="tab" id={`${id}-browse-tab`} aria-controls={`${id}-browse-panel`} aria-selected={tab === 'browse'} tabIndex={tab === 'browse' ? 0 : -1} onKeyDown={tabKeys} onClick={() => changeTab('browse')} disabled={busy}><UIIcon name="folderOpen" size={16} selected={tab === 'browse'} />文件夹</button>
        <button type="button" role="tab" id={`${id}-github-tab`} aria-controls={`${id}-github-panel`} aria-selected={tab === 'github'} tabIndex={tab === 'github' ? 0 : -1} onKeyDown={tabKeys} onClick={() => changeTab('github')} disabled={busy}><LinkIconMedium kind="url" href="https://github.com" size={16} />GitHub</button>
      </div>
      {tab === 'browse' ? <div className="cmd-folder-browser" role="tabpanel" id={`${id}-browse-panel`} aria-labelledby={`${id}-browse-tab`}>
        <div className="cmd-folder-location">
          <Tooltip label="上一级" portal><button type="button" className="cmd-project-icon-button" aria-label="上一级" disabled={!listing?.parent || loading || busy} onClick={() => void browse(listing.parent)}><UIIcon name="chevronLeft" size={16} /></button></Tooltip>
          <button type="button" className="cmd-folder-home" onClick={() => void browse(listing?.home)} disabled={loading || busy}>主目录</button>
          <span aria-label="当前目录" title={listing?.path}>{listing?.path ?? '选择文件夹'}</span>
          {desktop && <Tooltip label="系统选择文件夹" portal><button type="button" className="cmd-project-icon-button" aria-label="系统选择文件夹" onClick={() => void pick()} disabled={busy}><UIIcon name="external" size={16} /></button></Tooltip>}
        </div>
        <label className="cmd-folder-search"><UIIcon name="search" size={16} /><input type="search" data-modal-autofocus aria-label="搜索文件夹" placeholder="搜索文件夹" value={query} onChange={e => setQuery(e.target.value)} disabled={busy || loading || !listing} /></label>
        <div className="cmd-folder-entries" aria-label="文件夹列表" aria-busy={loading}>
          {loading ? <div className="cmd-folder-empty" role="status">正在读取…</div> : browseError ? <div className="cmd-folder-empty" role="alert"><span>无法读取目录</span><span className="cmd-folder-error-detail">{browseError}</span><button type="button" className="cmd-folder-retry" onClick={() => void browse(browseTarget.current)} disabled={busy}>重试</button></div> : entries.length ? entries.map(entry => <button type="button" key={entry.path} title={entry.name} disabled={busy} onClick={() => void browse(entry.path)}><UIIcon name="folder" size={17} /><span>{entry.name}</span><UIIcon name="chevronDown" size={12} className="cmd-folder-next" /></button>) : <div className="cmd-folder-empty" role="status">{query.trim() ? '未找到文件夹' : '此目录没有子文件夹'}</div>}
        </div>
        {error && <div className="cmd-project-error" role="alert">{error}</div>}
        <div className="cmd-project-submit"><div className="cmd-project-selection" title={listing?.path}><span>当前文件夹</span><strong>{listing ? folderName : '尚未选择'}</strong></div><button type="button" className="cmd-dialog-button cmd-dialog-primary" disabled={!listing || loading || busy} onClick={() => void select()}>{busy ? '添加中…' : '添加项目'}</button></div>
      </div> : <form className="cmd-github-form" role="tabpanel" id={`${id}-github-panel`} aria-labelledby={`${id}-github-tab`} onSubmit={clone}>
        <label htmlFor={`${id}-repo`}>仓库地址</label><input id={`${id}-repo`} type="url" required placeholder="https://github.com/owner/repo" aria-describedby={`${id}-github-hint`} value={url} onChange={e => setUrl(e.target.value)} disabled={busy} />
        <p id={`${id}-github-hint`}>私有仓库需配置 Git 凭据。</p>
        {error && <div className="cmd-project-error" role="alert">{error}</div>}
        <div className="cmd-project-submit"><button type="submit" className="cmd-dialog-button cmd-dialog-primary" disabled={busy || !url.trim()}>{busy ? '克隆中…' : '克隆并添加'}</button></div>
      </form>}
    </div>
  </Modal>;
}
