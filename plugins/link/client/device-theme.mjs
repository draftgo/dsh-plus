const scheme = value => value === 'light' || value === 'dark' ? value : '';
const mediaTheme = host => host.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

/** The host presenter owns the resolved palette, including explicit light mode. */
export function readHostTheme(host = globalThis) {
  const root = host.document?.documentElement, body = host.document?.body;
  return scheme(root?.style?.colorScheme) || scheme(root?.getAttribute?.('data-ds-theme-source'))
    || (body?.hasAttribute?.('data-ds-dark-theme') ? 'dark' : mediaTheme(host));
}

export function observeHostTheme(onChange, host = globalThis) {
  let current;
  const sync = () => { const next = readHostTheme(host); if (next !== current) { current = next; onChange(next); } };
  const media = host.matchMedia?.('(prefers-color-scheme: dark)');
  const observer = host.MutationObserver && new host.MutationObserver(sync);
  for (const node of [host.document?.documentElement, host.document?.body]) {
    if (node) observer?.observe(node, { attributes: true, attributeFilter: ['style', 'data-ds-theme-source', 'data-ds-dark-theme'] });
  }
  if (media?.addEventListener) media.addEventListener('change', sync); else media?.addListener?.(sync);
  sync();
  return () => { observer?.disconnect(); if (media?.removeEventListener) media.removeEventListener('change', sync); else media?.removeListener?.(sync); };
}

export function initialDeviceTheme(host = globalThis) {
  return scheme(new URLSearchParams(host.location?.search || '').get('theme')) || mediaTheme(host);
}

/** Device pages accept appearance updates only from their declared embedding parent. */
export function connectDeviceTheme(onChange = () => {}, host = globalThis) {
  const params = new URLSearchParams(host.location?.search || '');
  const parentOrigin = host.__DSH_DEVICE_PARENT_ORIGIN__ || params.get('parentOrigin');
  const embedded = host.parent && host.parent !== host;
  let inherited = embedded && Boolean(scheme(params.get('theme'))), current;
  const apply = next => {
    if (next === current) return;
    current = next;
    const root = host.document?.documentElement, body = host.document?.body;
    if (root?.style) root.style.colorScheme = next;
    root?.setAttribute?.('data-dsh-device-theme', next);
    body?.toggleAttribute?.('data-ds-dark-theme', next === 'dark');
    onChange(next);
  };
  const media = host.matchMedia?.('(prefers-color-scheme: dark)');
  const followSystem = () => { if (!inherited) apply(mediaTheme(host)); };
  const receive = event => {
    if (!embedded || !parentOrigin || event.source !== host.parent || event.origin !== parentOrigin || event.data?.type !== 'dsh-devices:theme') return;
    const next = scheme(event.data.theme); if (!next) return;
    const background = event.data.background;
    if (typeof background === 'string' && /^(#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(background)) host.document?.documentElement?.style?.setProperty?.('--dsh-conversation-background', background);
    inherited = true; apply(next);
  };
  host.addEventListener('message', receive);
  if (media?.addEventListener) media.addEventListener('change', followSystem); else media?.addListener?.(followSystem);
  apply(initialDeviceTheme(host));
  if (embedded && parentOrigin) host.parent.postMessage({ type: 'dsh-devices:theme-ready' }, parentOrigin);
  return () => {
    host.removeEventListener('message', receive);
    if (media?.removeEventListener) media.removeEventListener('change', followSystem); else media?.removeListener?.(followSystem);
  };
}
