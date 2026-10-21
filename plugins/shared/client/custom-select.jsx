import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import css from './custom-select.css';

/** Controlled picker; values remain opaque strings. */
export function CustomSelect({ value, options = [], onChange, disabled = false, placeholder = '请选择', searchable = false, className = '', id, name, ...props }) {
  const listId = useId(), trigger = useRef(null), popup = useRef(null), search = useRef(null), typing = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(-1), [position, setPosition] = useState(null);
  const selected = options.find(option => option.value === value);
  const filtered = options.filter(option => !query || String(option.searchText ?? option.label ?? option.value).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const enabled = filtered.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
  const close = (restore = false) => { setOpen(false); setQuery(''); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const choose = option => { if (!option || option.disabled) return; onChange?.(option.value); close(true); };
  const show = (last = false) => {
    if (disabled) return;
    setQuery('');
    const initial = options.findIndex(option => option.value === value && !option.disabled);
    const candidates = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
    setActive(initial >= 0 ? initial : last ? candidates.at(-1) ?? -1 : candidates[0] ?? -1);
    setOpen(true);
  };
  useEffect(() => {
    if (document.getElementById('dowork-custom-select-style')) return;
    const style = document.createElement('style'); style.id = 'dowork-custom-select-style'; style.textContent = css; document.head.append(style);
  }, []);
  useEffect(() => { if (disabled) close(); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = trigger.current; if (!anchor) return;
      const rect = anchor.getBoundingClientRect(), viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
      const below = topEdge + height - rect.bottom - 14, above = rect.top - topEdge - 14;
      const upwards = below < 220 && above > below, menuWidth = Math.min(Math.max(rect.width, 180), width - 24);
      const computed = getComputedStyle(anchor), variables = {};
      for (let index = 0; index < computed.length; index++) { const key = computed[index]; if (key.startsWith('--link-') || key.startsWith('--dsw-') || key.startsWith('--dc-')) variables[key] = computed.getPropertyValue(key); }
      setPosition({ ...variables, position: 'fixed', width: menuWidth, maxHeight: Math.max(80, Math.min(360, upwards ? above : below)), left: Math.max(leftEdge + 12, Math.min(rect.left, leftEdge + width - menuWidth - 12)), ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }), fontFamily: computed.fontFamily });
    };
    update();
    const outside = event => { if (!trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update); window.visualViewport?.addEventListener('scroll', update);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); window.visualViewport?.removeEventListener('resize', update); window.visualViewport?.removeEventListener('scroll', update); };
  }, [open]);
  useEffect(() => { if (open && position) (searchable ? search.current : popup.current)?.focus({ preventScroll: true }); }, [open, !!position, searchable]);
  useEffect(() => { if (open) document.getElementById(listId + '-' + active)?.scrollIntoView({ block: 'nearest' }); }, [active, open, listId]);
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    if (event.key === 'Enter' || (event.key === ' ' && event.target !== search.current)) { event.preventDefault(); choose(filtered[active]); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const current = enabled.indexOf(active);
      setActive(event.key === 'Home' ? enabled[0] ?? -1 : event.key === 'End' ? enabled.at(-1) ?? -1 : enabled[(current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length] ?? -1);
      return;
    }
    if (!searchable && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); const now = Date.now(), previous = typing.current;
      const text = now - previous.time < 700 ? previous.text + event.key : event.key; typing.current = { text, time: now };
      const match = filtered.findIndex(option => !option.disabled && String(option.label ?? option.value).toLocaleLowerCase().startsWith(text.toLocaleLowerCase()));
      if (match >= 0) setActive(match);
    }
  };
  const portalRoot = trigger.current?.closest('[role=dialog], dialog, .link-dialog, .dc-dialog') || (typeof document !== 'undefined' ? document.body : null);
  return <><button {...props} type="button" id={id} ref={trigger} className={'dowork-select ' + className} disabled={disabled} aria-haspopup="listbox" aria-expanded={open && !disabled} aria-controls={open ? listId : undefined} onClick={() => open ? close() : show()} onKeyDown={event => { if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); show(event.key === 'ArrowUp' || event.key === 'End'); } }}><span className="dowork-select-value" data-placeholder={!selected || undefined}>{selected?.icon}{selected?.label ?? placeholder}</span><span className="dowork-select-chevron" aria-hidden="true" /></button>{name && <input type="hidden" name={name} value={value ?? ''} disabled={disabled} />}{open && !disabled && portalRoot && createPortal(<div ref={popup} className="dowork-select-popup" style={position ?? { visibility: 'hidden', position: 'fixed' }} onKeyDown={keydown} tabIndex={searchable ? undefined : -1} role={searchable ? undefined : 'listbox'} id={searchable ? undefined : listId} aria-label={searchable ? undefined : props['aria-label'] || '选项'} aria-labelledby={searchable ? undefined : props['aria-labelledby']} aria-activedescendant={!searchable && active >= 0 ? listId + '-' + active : undefined}>{searchable && <input ref={search} className="dowork-select-search" role="combobox" aria-label={'搜索' + (props['aria-label'] || '选项')} aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={active >= 0 ? listId + '-' + active : undefined} placeholder="搜索…" value={query} onChange={event => { const next = event.target.value; setQuery(next); setActive(options.filter(option => !next || String(option.searchText ?? option.label ?? option.value).toLocaleLowerCase().includes(next.toLocaleLowerCase())).findIndex(option => !option.disabled)); }} />}<div className="dowork-select-options" role={searchable ? 'listbox' : 'presentation'} id={searchable ? listId : undefined} aria-label={searchable ? props['aria-label'] || '选项' : undefined}>{filtered.map((option, index) => <div key={option.value} id={listId + '-' + index} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-active={index === active || undefined} className="dowork-select-option" onPointerMove={() => { if (!option.disabled) setActive(index); }} onPointerDown={event => event.preventDefault()} onClick={() => choose(option)}>{option.icon}<span>{option.label}</span>{option.value === value && <span className="dowork-select-check" aria-hidden="true" />}</div>)}{!filtered.length && <p className="dowork-select-empty">没有可选项</p>}</div></div>, portalRoot)}</>;
}
export default CustomSelect;
