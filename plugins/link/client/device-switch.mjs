/** Windows caption device switcher state. Local drafts stay on the host page. */
const labelOf = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 100) : '';

export function deviceSwitchItems(devices) {
  const rows = Array.isArray(devices) ? devices.filter(item => item && typeof item.id === 'string' && item.id && labelOf(item.name)) : [];
  const local = rows.find(item => item.kind === 'local') || { id: 'local', name: '本机', kind: 'local', status: 'online' };
  const remote = rows.filter(item => item.kind !== 'local');
  return [{ ...local, name: labelOf(local.name) || '本机' }, ...remote.map(item => ({ ...item, name: labelOf(item.name) }))];
}

export function deviceSwitchState({ devices = [], activeId = null, open = false, busy = '', error = '' } = {}) {
  const items = deviceSwitchItems(devices);
  const active = items.find(item => item.id === activeId) || items[0];
  return {
    items,
    active,
    open: Boolean(open && items.length > 1 && !busy),
    busy: typeof busy === 'string' ? busy : '',
    error: typeof error === 'string' ? error : '',
    multiple: items.length > 1,
  };
}
