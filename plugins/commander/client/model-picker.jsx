import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UIIcon } from './iconsax.jsx';
import { ProviderBrandIcon } from './provider-brand-icon.jsx';
import { ToolBrandIcon } from './tool-brand-icon.jsx';
import { availableTools, currentToolId, providersForTool, selectionReasoningEffort } from './model-picker-state.mjs';
import css from './model-picker.css';

/** Selection, permissions and persistence stay with the official directory. */
export function mountModelPicker(ctx) {
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  ctx.effect(() => () => style.remove());
  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
    name: 'conversation.input.model', priority: -10,
    inject: sessionId => {
      const directory = ctx.modelDirectories.directoryFor(sessionId);
      return { available: ctx.sessions.subagentAddress(sessionId) === undefined, hooks: { directory: directory.store }, load: () => directory.load(), select: selection => directory.select(selection) };
    },
  }, ModelPicker));
}

function ModelPicker({ locked, available, useDirectory, load, select }) {
  const state = useDirectory(value => value);
  const [open, setOpen] = useState(false), [tool, setTool] = useState('deepseek'), [provider, setProvider] = useState(null), [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState(null), [catalogLoading, setCatalogLoading] = useState(false), [revision, setRevision] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false), [position, setPosition] = useState(null), [error, setError] = useState(''), [catalogError, setCatalogError] = useState('');
  const trigger = useRef(null), menu = useRef(null), search = useRef(null), selecting = useRef(false), toolTrigger = useRef(null);
  const id = useId(), currentTool = currentToolId(state.current?.provider);
  const entries = availableTools(catalog), activeTool = entries.find(entry => entry.id === tool);
  const currentGroup = state.groups.find(group => group.id === state.current?.provider);
  const currentModel = currentGroup?.models.find(model => model.id === state.current?.model);
  const busy = state.status === 'selecting', loading = state.status === 'loading' || catalogLoading;
  const close = () => { setOpen(false); setProvider(null); setToolsOpen(false); setQuery(''); };
  const refresh = () => { setError(''); setRevision(value => value + 1); void load().catch(reason => setError(reason.message)); };
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setCatalogLoading(true); setCatalogError('');
    (async () => {
      const response = await fetch(new URL('api/commander/tooling', document.baseURI), { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pickerCatalog' }) });
      const value = await response.json(); if (!response.ok || value.error) throw Error(typeof value.error === 'string' ? value.error : value.error?.message || '工具目录加载失败');
      if (controller.signal.aborted) return;
      setCatalog(value); setTool(current => availableTools(value).some(entry => entry.id === current && entry.routeSupported) ? current : 'deepseek');
    })().catch(reason => { if (!controller.signal.aborted) setCatalogError(reason.message); }).finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    return () => controller.abort();
  }, [open, revision]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(368, window.innerWidth - 24), below = window.innerHeight - rect.bottom, above = rect.top, topSide = above > below;
      setPosition({ position: 'fixed', width, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), ...(topSide ? { bottom: window.innerHeight - rect.top + 8 } : { top: rect.bottom + 8 }), maxHeight: Math.max(100, Math.min(480, (topSide ? above : below) - 20)) });
    };
    place();
    const outside = event => { if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(); };
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (toolsOpen) { setToolsOpen(false); toolTrigger.current?.focus(); } else { close(); trigger.current?.focus(); } } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key, true); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, toolsOpen]);
  useEffect(() => { if (open && !toolsOpen) search.current?.focus(); }, [open, provider, toolsOpen]);
  useEffect(() => { if (toolsOpen) menu.current?.querySelector('.cmd-model-tool-menu button[aria-checked="true"]')?.focus(); }, [toolsOpen]);
  const choose = async (group, model, effort) => {
    if (selecting.current || locked) return;
    selecting.current = true; setError('');
    try {
      const reasoningEffort = selectionReasoningEffort(group.id, model, state.current, effort);
      const result = await select({ provider: group.id, model: model.id, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
      if (!result?.ok) throw new Error(result?.error?.message ?? '模型选择不可用');
      close(); trigger.current?.focus();
    } catch (reason) { setError(reason.message); } finally { selecting.current = false; }
  };
  const providers = providersForTool(state.groups, catalog, tool), selectedProvider = providers.find(item => item.id === provider);
  const matches = text => text.toLowerCase().includes(query.trim().toLowerCase());
  const visibleProviders = providers.filter(item => matches(item.name + ' ' + item.id));
  const models = (selectedProvider?.models || []).filter(({ model, nativeModelId }) => matches(model.name + ' ' + (nativeModelId || model.id)));
  const activeEffort = currentModel && selectionReasoningEffort(currentGroup.id, currentModel, state.current);
  const effortName = currentModel?.reasoning?.efforts?.find(effort => effort.id === activeEffort)?.name;
  const failures = state.failures?.filter(group => tool === 'deepseek' ? !group.id?.startsWith('commander-') : group.id === 'commander-' + tool) || [];
  const message = error || catalogError || state.error || failures.map(group => group.message).join('；');
  const onMenuKey = event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const scope = toolsOpen ? menu.current.querySelector('.cmd-model-tool-menu') : menu.current;
    const buttons = [...scope.querySelectorAll('button:not(:disabled),input')], current = buttons.indexOf(document.activeElement), direction = event.key === 'ArrowDown' ? 1 : -1;
    event.preventDefault(); buttons[(current + direction + buttons.length) % buttons.length]?.focus();
  };
  return <>
    <button ref={trigger} type="button" className="cmd-model-trigger" disabled={locked || !available || busy} aria-label={'选择工具与模型，当前 ' + (entries.find(item => item.id === currentTool)?.name ?? currentTool) + ' ' + (currentModel?.name ?? state.current?.model ?? '')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { if (open) close(); else { setTool(currentTool); setProvider(null); setQuery(''); setToolsOpen(false); setOpen(true); refresh(); } }}>
      <span className="cmd-model-caption">{currentModel?.name ?? state.current?.model ?? '选择模型'}{effortName ? ' · ' + effortName : ''}</span><UIIcon name="chevronDown" size={14} />
    </button>
    {open && position && createPortal(<div ref={menu} id={id} role="dialog" aria-label="工具与模型" className="cmd-model-popup" style={position} onKeyDown={onMenuKey}>
      <header className="cmd-model-header">
        {provider ? <button type="button" className="cmd-model-back" aria-label="返回供应商列表" disabled={busy} onClick={() => { setProvider(null); setQuery(''); }}><UIIcon name="chevronLeft" size={16} /><span>{selectedProvider?.name || '供应商'}</span></button> : <span className="cmd-model-heading">选择供应商</span>}
        <button ref={toolTrigger} type="button" className="cmd-model-tool-trigger" aria-label="选择 Agent 工具" aria-haspopup="menu" aria-expanded={toolsOpen} disabled={busy} onClick={() => setToolsOpen(value => !value)}><ToolBrandIcon tool={tool} size={18} /><span>{activeTool?.name || (catalogLoading ? '识别工具…' : tool)}</span><UIIcon name="chevronDown" size={13} /></button>
      </header>
      {toolsOpen && <div className="cmd-model-tool-menu" role="menu" aria-label="本机可用 Agent 工具">{entries.map(entry => <button key={entry.id} type="button" role="menuitemradio" disabled={!entry.routeSupported} aria-checked={tool === entry.id} className={tool === entry.id ? 'is-selected' : ''} onClick={() => { setTool(entry.id); setProvider(null); setQuery(''); setToolsOpen(false); }}><ToolBrandIcon tool={entry.id} size={20} /><span>{entry.name}{!entry.routeSupported && <small>{entry.routeReason || '供应商隔离待适配'}</small>}</span>{tool === entry.id && <UIIcon name="check" size={16} />}</button>)}<small>{catalogLoading ? '正在识别本机工具…' : '自动识别本机已安装的对话工具'}</small></div>}
      <label className="cmd-model-search"><UIIcon name="search" size={16} /><input ref={search} type="search" autoComplete="off" spellCheck={false} aria-label={provider ? '搜索模型' : '搜索供应商'} placeholder={provider ? '搜索模型' : '搜索供应商'} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="cmd-model-options" key={tool + '/' + (provider || '')}>
        {!provider ? visibleProviders.map(entry => {
          const selected = entry.models.some(({ group, model }) => state.current?.provider === group.id && state.current?.model === model.id);
          return <button type="button" key={entry.id} disabled={busy || !entry.models.length} className={'cmd-model-provider' + (selected ? ' is-selected' : '')} onClick={() => { setProvider(entry.id); setQuery(''); }}><span className="cmd-model-provider-mark"><ProviderBrandIcon id={entry.id} name={entry.name} declared={entry.declared} size={22} /></span><span className="cmd-model-provider-copy"><span>{entry.name}</span><small>{entry.models.length} 个模型</small></span><UIIcon name="chevronLeft" className="cmd-model-next" size={15} /></button>;
        }) : models.map(({ group, model, nativeModelId }) => {
          const selected = state.current?.provider === group.id && state.current?.model === model.id;
          return <div key={group.id + '/' + model.id} className="cmd-model-choice"><button type="button" role="menuitemradio" aria-checked={selected} disabled={busy} className={selected ? 'is-selected' : ''} onClick={() => void choose(group, model)}><span>{model.name}{nativeModelId && nativeModelId !== model.name && <small>{nativeModelId}</small>}</span>{selected && <UIIcon name="check" size={16} />}</button>{selected && model.reasoning?.efforts?.length > 0 && <div className="cmd-model-efforts" role="group" aria-label="推理强度">{model.reasoning.efforts.map(effort => <button key={effort.id} type="button" disabled={busy} aria-pressed={activeEffort === effort.id} onClick={() => void choose(group, model, effort.id)}>{effort.name}</button>)}</div>}</div>;
        })}
        {!(provider ? models : visibleProviders).length && <p role="status">{loading ? '正在加载…' : query ? '没有匹配结果' : provider ? '暂无可用模型' : tool === 'deepseek' ? '请先在模型设置中添加供应商' : '暂无可用供应商，请在模型设置中配置此工具'}</p>}
      </div>
      {message && <footer><span role="alert">{message}</span><button type="button" onClick={refresh} disabled={busy || loading}>重试</button></footer>}
    </div>, document.body)}
  </>;
}
