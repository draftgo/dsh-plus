/* Installed before the shared Harness shell. The paired cookie is HttpOnly. */
(() => {
  const base = new URL(document.baseURI);
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
  // Loopback HTTP cannot negotiate h2; multiplex subscriptions over one socket.
  let localSocket;
  const localStreams = new Map();
  const localConnection = () => {
    if (localSocket && localSocket.readyState <= 1) return localSocket;
    const url = new URL('../../socket', base); url.protocol = 'ws:';
    const socket = localSocket = new WebSocket(url);
    socket.addEventListener('message', event => {
      try { const frame = JSON.parse(event.data), stream = localStreams.get(frame.id); if (!stream) return; if (stream.items.length >= 128) { stream.error = new Error('工作台流消费过慢'); socket.close(); } else { stream.items.push(frame); stream.wake?.(); } } catch { socket.close(); }
    });
    socket.addEventListener('close', () => { for (const stream of localStreams.values()) { stream.error = new Error('主机连接已断开，请重试'); stream.wake?.(); } });
    socket.addEventListener('error', () => {});
    return socket;
  };
  const waitSocket = (socket, signal) => new Promise((resolve, reject) => {
    const clean = () => { socket.removeEventListener('open', opened); socket.removeEventListener('close', failed); signal.removeEventListener('abort', failed); };
    const opened = () => { clean(); resolve(); }, failed = () => { clean(); reject(signal.reason || new Error('主机连接不可用')); };
    if (signal.aborted || socket.readyState > 1) return failed();
    if (socket.readyState === 1) return opened();
    socket.addEventListener('open', opened, { once: true }); socket.addEventListener('close', failed, { once: true }); signal.addEventListener('abort', failed, { once: true });
  });
  async function* localLines(payload, signal) {
    const socket = localConnection(), stream = { items: [], wake: undefined, error: null }, id = payload.id;
    await waitSocket(socket, signal); localStreams.set(id, stream);
    const abort = () => { stream.error = signal.reason || new Error('已取消'); stream.wake?.(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    socket.send(JSON.stringify({ type: 'open', id, body: payload }));
    try {
      while (true) {
        if (stream.error) throw stream.error;
        if (!stream.items.length) { await new Promise(resolve => { stream.wake = resolve; }); stream.wake = undefined; continue; }
        const frame = stream.items.shift();
        if (frame.type === 'headers' && frame.status >= 400) { if (frame.status === 401) globalThis.dispatchEvent(new CustomEvent('dsh-link-authorization-expired')); throw new Error('工作台连接失败：' + frame.status); }
        if (frame.type === 'error') throw new Error(frame.error);
        if (frame.type === 'end') return;
        if (frame.type === 'data') yield frame.value;
      }
    } finally { signal.removeEventListener('abort', abort); localStreams.delete(id); if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'cancel', id })); }
  }
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
      if (globalThis.__DSH_LINK_LOCAL_PROXY__) iterator = localLines({ id, endpoint, payload }, combined)[Symbol.asyncIterator]();
      else {
        const response = await apiFetch(route('remote/open'), { method: 'POST', signal: combined, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, endpoint, payload }) });
        if (!response.ok) throw new Error('工作台连接失败：' + response.status);
        iterator = lines(response)[Symbol.asyncIterator]();
      }
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
