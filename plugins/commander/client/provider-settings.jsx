import React, { useState } from 'react';
import { Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { ModelsSection } from '../../../deepseek-harness/packages/client/ui-settings-models/src/client/ModelsSection.tsx';
import { UIIcon } from './iconsax.jsx';
import { ProviderBrandIcon } from './provider-brand-icon.jsx';
import { ToolBrandIcon } from './tool-brand-icon.jsx';
export { ProviderBrandIcon } from './provider-brand-icon.jsx';
import css from './provider-settings.css';

/** Keep every official editor and operation; only replace provider selection. */
export function mountProviderSettings(ctx) {
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  ctx.effect(() => () => { style.remove(); document.getElementById('commander-official-models-style')?.remove(); });
  // Child slots have one declaration owner. Adapt the official entry's view
  // reversibly, retaining its original inject, controller and render authority.
  ctx.effect(() => {
    const entry = ctx.slots.entries('settings.section').find(item => item.options.id === 'models' && item.children?.['settings.models.provider-card']);
    if (!entry) throw new Error('Official Models settings entry is unavailable');
    const original = entry.component; entry.component = ModelsSection;
    return () => { if (entry.component === ModelsSection) entry.component = original; };
  });
}

const routerGo = { id: 'routergo', name: 'RouterGo', baseURL: 'https://routergo.cn/api/v1', protocol: 'openai-completions' };

/** Receives official addable rows; selection returns to the official draft. */
export function ProviderSelect({ value, options, disabled, label, customEnabled, routerAvailable, onChange, onPreset }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const current = value === 'routergo' ? routerGo : value === '__custom' ? { name: '自定义供应商' } : options.find(option => option.id === value);
  const entries = [
    ...(customEnabled && routerAvailable && !options.some(option => option.id === 'routergo') ? [{ ...routerGo, preset: true }] : []),
    ...options.map(option => ({ ...option, preset: false })),
    ...(customEnabled ? [{ id: '__custom', name: '自定义供应商', preset: true }] : []),
  ].sort((a, b) => Number(b.id === 'routergo') - Number(a.id === 'routergo'));
  const matches = entries.filter(entry => (entry.name + ' ' + entry.id).toLowerCase().includes(query.trim().toLowerCase()));
  const close = () => { setOpen(false); setQuery(''); };
  return <>
    <button type="button" className="cmd-provider-select" disabled={disabled} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><ProviderBrandIcon id={current?.id} name={current?.name} declared={current?.declared} /><span>{current?.name || label}</span><UIIcon name="chevronDown" size={14} /></button>
    <Modal open={open} onClose={close} title={label} closeLabel="关闭" className="cmd-provider-dialog" contentClassName="cmd-provider-content">
      <label className="cmd-provider-search"><UIIcon name="search" size={16} /><input data-modal-autofocus aria-label="搜索供应商" placeholder="搜索供应商" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="cmd-provider-grid">{matches.map(entry => <button key={entry.id} type="button" className="cmd-provider-card" aria-pressed={value === entry.id} onClick={() => { close(); if (entry.preset) onPreset(entry.id === 'routergo' ? routerGo : undefined); else onChange(entry.id); }}><ProviderBrandIcon id={entry.id} name={entry.name} declared={entry.declared} /><span>{entry.name}</span>{value === entry.id ? <UIIcon name="check" size={16} /> : <UIIcon name="chevronDown" size={14} />}</button>)}</div>
      {!matches.length && <p className="cmd-provider-empty">没有匹配的供应商</p>}
    </Modal>
  </>;
}

async function toolingRequest(action, args = {}, signal) {
  const response = await fetch(new URL('api/commander/tooling', document.baseURI), { method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }) });
  const value = await response.json();
  if (!response.ok || value.error) throw Error(value.error || '无法读取 Harness 适用范围');
  return value;
}
const harnessEntry = { id: 'harness', name: 'DeepSeek Harness' };

/** Draft-only applicability. The official editor calls save after its own commit. */
export function useProviderHarness(providerId) {
  const [catalog, setCatalog] = useState(null), [selection, setSelection] = useState(null), [failure, setFailure] = useState(''), [revision, refresh] = useState(0);
  React.useEffect(() => {
    const controller = new AbortController(); setCatalog(null); setSelection(null); setFailure('');
    toolingRequest('catalog', {}, controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value); }).catch(error => { if (!controller.signal.aborted) setFailure(error.message); });
    return () => controller.abort();
  }, [revision]);
  const tools = catalog ? [harnessEntry, ...(catalog.tools || []).filter(tool => tool.configSupported !== false)] : [];
  const access = catalog?.providerAccess?.find(provider => provider.id === providerId);
  const restricted = access?.authMode === 'subscription';
  const permitted = restricted ? access.harnessTools || [] : tools.map(tool => tool.id);
  const stored = catalog?.bindings?.[providerId];
  const current = restricted ? permitted : (selection ?? (Array.isArray(stored) ? stored : permitted)).filter(id => permitted.includes(id));
  const toggle = id => { if (restricted || !permitted.includes(id)) return; setSelection(previous => { const selected = previous ?? current; return selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]; }); };
  return { tools, current, toggle, restricted, permitted, access, loading: !catalog && !failure, failure, retry: () => refresh(value => value + 1),
    async save() {
      if (selection === null) return;
      if (!providerId || !catalog) throw Error('供应商已保存，但 Harness 适用范围尚未就绪，请重试保存');
      try { const result = await toolingRequest('setBindings', { providerId, tools: selection }); setCatalog(value => ({ ...value, bindings: result.bindings })); setSelection(null); }
      catch (error) { throw Error('供应商已保存；Harness 适用范围保存失败，请重试：' + error.message); }
    },
  };
}
export function ProviderHarnessField({ value, disabled }) {
  return <aside className="cmd-provider-harness" aria-label="支持的 Harness 工具">
    <span className="cmd-provider-harness-label">适用工具</span>
    <div className="cmd-provider-harness-options" role="group" aria-label="适用 Harness 工具">{value.tools.map(tool => <Tooltip key={tool.id} label={tool.name} side="top" portal>
      <button type="button" disabled={disabled || value.loading || value.restricted} aria-label={tool.name + (value.current.includes(tool.id) ? '，已启用' : value.restricted ? '，此订阅不支持' : '，未启用')} aria-pressed={value.current.includes(tool.id)} onClick={() => value.toggle(tool.id)}>
        <ToolBrandIcon tool={tool.id === 'harness' ? 'deepseek' : tool.id} size={20} />
        <span className="cmd-provider-harness-check">{value.current.includes(tool.id) && <UIIcon name="check" size={10} />}</span>
      </button>
    </Tooltip>)}</div>
    {value.loading ? <small>加载中…</small> : value.failure ? <small role="alert">{value.failure} <button type="button" disabled={disabled} onClick={value.retry}>重试</button></small> : <small>{value.restricted ? value.access?.configured ? '订阅登录仅限对应工具；使用本机登录。' : '仅限对应工具，请先完成登录。' : '选择可使用此供应商的工具'}</small>}
  </aside>;
}
