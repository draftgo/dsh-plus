import React, { useEffect, useRef, useState } from 'react';
import { Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { UIIcon } from './iconsax.jsx';

/** Browsing selects host folders; an Electron chooser is only offered by the desktop bridge. */
export function ProjectPicker({ host, api, onClose, onSelected }) {
  const [tab, setTab] = useState('browse'), [listing, setListing] = useState(null), [query, setQuery] = useState('');
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), mounted = useRef(true);
  const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
  const browse = async path => {
    const version = ++generation.current; setLoading(true); setError(''); setQuery('');
    try { const result = await api('browse', path ? { path } : {}); if (mounted.current && version === generation.current) setListing(result); }
    catch (e) { if (mounted.current && version === generation.current) setError(e.message); }
    finally { if (mounted.current && version === generation.current) setLoading(false); }
  };
  useEffect(() => { mounted.current = true; void browse(); return () => { mounted.current = false; generation.current++; }; }, []);
  const select = async path => {
    if (busy) return; setBusy(true); setError('');
    try { const { project } = await api('project', { path }); await onSelected(project); }
    catch (e) { if(mounted.current)setError(e.message); } finally { if(mounted.current)setBusy(false); }
  };
  const pick = async () => {
    setError('');
    try { const path = await desktop.pick(); if(path) await select(path); } catch(e) { setError(e.message); }
  };
  const clone = async e => {
    e.preventDefault(); if(busy)return; setBusy(true); setError('');
    try { const { project } = await api('clone', { url }); await onSelected(project); }
    catch(e) { if(mounted.current)setError(e.message); } finally { if(mounted.current)setBusy(false); }
  };
  const entries = (listing?.entries ?? []).filter(entry => entry.name.toLowerCase().includes(query.toLowerCase()));
  return <Modal open onClose={() => { if(!busy)onClose(); }} title="添加项目" closeLabel="关闭" description="选择服务器上的文件夹，或从 GitHub 创建工作区。" className="cmd-project-dialog">
    <div className="cmd-project-tabs" role="tablist" aria-label="添加方式"><button type="button" role="tab" aria-selected={tab==='browse'} onClick={()=>setTab('browse')} disabled={busy}><UIIcon name="folderOpen" selected={tab==='browse'} />浏览目录</button><button type="button" role="tab" aria-selected={tab==='github'} onClick={()=>setTab('github')} disabled={busy}><UIIcon name="link" selected={tab==='github'} />GitHub 仓库</button>{desktop && <button type="button" onClick={() => void pick()} disabled={busy}><UIIcon name="external" />选择文件夹</button>}</div>
    {tab==='browse' ? <div className="cmd-folder-browser" role="tabpanel" aria-label="浏览目录"><div className="cmd-folder-location"><Tooltip label="上一级" portal><button type="button" aria-label="上一级" disabled={!listing?.parent || loading || busy} onClick={()=>void browse(listing.parent)}><UIIcon name="chevronLeft" size={18} /></button></Tooltip><button type="button" onClick={()=>void browse(listing?.home)} disabled={loading||busy}>主目录</button><span aria-label="当前目录">{listing?.path ?? '正在读取目录…'}</span></div><label className="cmd-folder-search"><UIIcon name="search" size={18}/><input aria-label="搜索当前目录" placeholder="搜索当前目录中的文件夹" value={query} onChange={e=>setQuery(e.target.value)} disabled={busy}/></label><div className="cmd-folder-entries" aria-busy={loading}>{loading ? <p role="status">正在读取目录…</p> : entries.length ? entries.map(entry=><button type="button" key={entry.path} disabled={busy} onClick={()=>void browse(entry.path)}><UIIcon name="folder" size={20}/><span>{entry.name}</span><UIIcon name="chevronDown" size={14} className="cmd-folder-next"/></button>) : <p>这里没有匹配的文件夹</p>}</div><div className="cmd-project-submit"><span>使用上面的目录导航，无需填写绝对路径</span><button type="button" className="cmd-dialog-button" disabled={!listing||loading||busy} onClick={()=>void select(listing.path)}>{busy?'添加中…':'使用此文件夹'}</button></div></div> : <form className="cmd-github-form" onSubmit={clone}><label>仓库地址<input type="url" required placeholder="https://github.com/owner/repo" value={url} onChange={e=>setUrl(e.target.value)} disabled={busy}/></label><p>克隆到当前 Profile 的工作区目录，完成后自动添加为共享项目。私有仓库使用服务器现有 Git 凭据。</p><button className="cmd-dialog-button" disabled={busy||!url}>{busy?'正在克隆仓库…':'克隆并添加项目'}</button></form>}
    {error && <div className="cmd-error" role="alert">{error}</div>}
  </Modal>;
}
