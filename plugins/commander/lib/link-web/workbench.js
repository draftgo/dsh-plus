/* Installed before the shared Harness shell. The paired cookie is HttpOnly. */
(() => {
  const base = new URL('/link/workbench/', location.href);
  const originalFetch = globalThis.fetch.bind(globalThis);
  const route = path => new URL(path, base);
  const apiFetch = (input, init = {}) => {
    const url = new URL(input, base);
    // Existing UI code can use either document-relative or root-relative API paths.
    if (url.origin === base.origin && /^\/(api|plugins)\//.test(url.pathname)) url.pathname = base.pathname + url.pathname.slice(1);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('工作台请求地址无效');
    return originalFetch(url, { ...init, credentials: 'same-origin' }).then(response => {
      if (response.status === 401) globalThis.dispatchEvent(new CustomEvent('dsh-link-authorization-expired'));
      return response;
    });
  };
  async function* lines(response) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('工作台流不可用');
    const decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) yield JSON.parse(line); }
        if (done) { if (buffer.trim()) yield JSON.parse(buffer); return; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function* openStream(endpoint, payload, signal, uplink) {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const lifetime = new AbortController();
    const combined = AbortSignal.any([signal, lifetime.signal]);
    const post = async frame => {
      const response = await apiFetch(route('remote/uplink'), { method: 'POST', signal: combined, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...frame }) });
      if (!response.ok) throw new Error('工作台上行连接失败：' + response.status);
    };
    let upload, iterator, failure;
    try {
      const response = await apiFetch(route('remote/open'), { method: 'POST', signal: combined, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, endpoint, payload }) });
      if (!response.ok) throw new Error('工作台连接失败：' + response.status);
      iterator = lines(response)[Symbol.asyncIterator]();
      const ready = await iterator.next();
      if (ready.done || ready.value.type !== 'ready') throw new Error('工作台流初始化失败');
      upload = (async () => {
        if (uplink) for await (const value of uplink) { combined.throwIfAborted(); await post({ type: 'item', value }); }
        await post({ type: 'end' });
      })().catch(error => { if (!combined.aborted) { failure = error; lifetime.abort(error); } });
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error('工作台流意外中断');
        const frame = next.value;
        if (frame.type === 'end') return;
        if (frame.type === 'error') throw Object.assign(new Error(frame.error?.message || '工作台流失败'), { code: frame.error?.code, details: frame.error?.details });
        if (frame.type === 'item') yield frame.value;
      }
    } catch (error) { throw failure ?? error; }
    finally { lifetime.abort(); await iterator?.return?.().catch(() => {}); void upload; }
  }
  globalThis.__DSH_LINK_WORKBENCH__ = true;
  globalThis.__DSH_TRANSPORT__ = { fetch: apiFetch, openStream };
  // Direct feature fetches (voice, preset editor, uploads) already resolve
  // document.baseURI and carry the same cookie. Keep that path rooted here.
  globalThis.addEventListener('dsh-link-authorization-expired', () => {
    if (!document.getElementById('dsh-link-expired')) {
      const banner = document.createElement('div');
      banner.id = 'dsh-link-expired'; banner.setAttribute('role', 'alert');
      banner.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:var(--background,#fff);color:var(--foreground,#222);display:grid;place-content:center;gap:16px;padding:28px;text-align:center';
      const text = document.createElement('p'); text.textContent = '设备授权已失效，请重新配对';
      const button = document.createElement('button'); button.textContent = '重新连接'; button.style.cssText = 'min-height:44px;padding:10px 20px;border-radius:12px;cursor:pointer';
      button.onclick = () => location.assign('/link/'); banner.append(text, button); document.body.append(banner);
    }
  });
})();
