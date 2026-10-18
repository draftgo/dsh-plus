import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as nativeRuntime from './api.mjs';
import { UIIcon } from '../../commander/client/iconsax.jsx';
import mobileCss from './mobile.css';
import { Button, ErrorText, StatusDot, useLinkStyle } from './app.jsx';
import { Interaction } from './interaction.jsx';
import { defaultProjectId, recentSessions } from './mobile-state.mjs';
import { MobileEmpty, MobileSidebar, SessionList, SessionSearch } from './mobile-navigation.jsx';

function useMobileStyle() {
  useLinkStyle();
  useEffect(() => { if (document.getElementById('dsh-link-mobile-style')) return; const node = document.createElement('style'); node.id = 'dsh-link-mobile-style'; node.textContent = mobileCss; document.head.append(node); return () => node.remove(); }, []);
}
export function LinkMobileApp({ runtime = nativeRuntime, theme: controlledTheme, onThemeChange }) {
  useMobileStyle();
  const { bootstrap, call, clearIdentity, contextUri, isLocalIdentitySave, isNative, pairingContext, requestId, saveIdentity, scan } = runtime;
  const [initial] = useState(() => bootstrap());
  const [older, setOlder] = useState([]), [page, setPage] = useState(null);
  const pendingCreate = useRef(null);
  const messagesRef = useRef(null), viewportRef = useRef(null), composing = useRef(false);
  const pairGeneration = useRef(0);
  const [identity, setIdentity] = useState(initial), [screen, setScreen] = useState(initial?.token ? 'recent' : 'pair');
  const [sidebarOpen, setSidebarOpen] = useState(false), [query, setQuery] = useState(''), [runningOnly, setRunningOnly] = useState(false);
  const [localTheme, setLocalTheme] = useState(() => globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const theme = controlledTheme || localTheme;
  const setTheme = update => { const next = typeof update === 'function' ? update(theme) : update; if (onThemeChange) onThemeChange(next); else setLocalTheme(next); };
  const [stateError, setStateError] = useState(''), [historyError, setHistoryError] = useState('');
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const drafts = useRef(new Map()), stayAtBottom = useRef(true);
  const [pairUri, setPairUri] = useState(() => contextUri(initial) || (!runtime.isPreview ? new URLSearchParams(location.hash.slice(1)).get('code') : '') || '');
  const [name, setName] = useState(initial?.name || ''), [pairing, setPairing] = useState(null), [pairState, setPairState] = useState('');
  const [state, setState] = useState(null), [projectId, setProjectId] = useState(''), [session, setSession] = useState(null), [history, setHistory] = useState({ messages: [], interactions: [], running: false });
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [sendPending, setSendPending] = useState(null), [revision, setRevision] = useState(0), [model, setModel] = useState('');
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    const changed = () => {
      const next = bootstrap();
      if (isLocalIdentitySave(next)) return;
      pairGeneration.current++;
      setIdentity(next); setPairUri(contextUri(next)); setScreen(next?.token ? 'recent' : 'pair');
      setState(null); setSession(null); setSidebarOpen(false); setSendPending(null); setDraft(''); setStateError(''); setHistoryError(''); drafts.current.clear(); pendingCreate.current = null;
      setPairing(null); setPairState(''); setError(''); setBusy(false);
      if (next?.name) setName(next.name);
    };
    if (runtime.subscribe) return runtime.subscribe(changed);
    window.addEventListener('link:bootstrap', changed); return () => window.removeEventListener('link:bootstrap', changed);
  }, [runtime]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => {
      const node = viewportRef.current;
      if (!node) return;
      const keyboardVisible = viewport.scale === 1 && window.innerHeight - viewport.height > 120;
      node.style.setProperty('--link-keyboard-inset', keyboardVisible ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) + 'px' : '0px');
    };
    resize(); viewport.addEventListener('resize', resize); viewport.addEventListener('scroll', resize);
    return () => { viewport.removeEventListener('resize', resize); viewport.removeEventListener('scroll', resize); };
  }, [screen === 'pair']);
  useEffect(() => { const changed = () => setOnline(navigator.onLine !== false); window.addEventListener('online', changed); window.addEventListener('offline', changed); return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); }; }, []);
  useEffect(() => {
    if (!identity?.token) return;
    let closed = false, timer; const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await call('state', {}, controller.signal);
        if (!closed) { setState(next); setProjectId(current => defaultProjectId(next.projects || [], next.sessions || [], current)); setStateError(''); }
      } catch (e) { if (!closed) setStateError(e.message); }
      finally { if (!closed) timer = setTimeout(poll, screen === 'chat' ? 6000 : 1600); }
    };
    poll(); return () => { closed = true; controller.abort(); clearTimeout(timer); };
  }, [runtime, identity?.token, revision, screen]);
  useEffect(() => {
    if (screen !== 'chat' || !session) { setHistoryError(''); return; }
    let closed = false, timer; const controller = new AbortController();
    const poll = async () => {
      try { const next = await call('history', { id: session.id }, controller.signal); if (!closed) { setHistory(next); setHistoryLoaded(true); setHistoryError(''); } }
      catch (e) { if (!closed) setHistoryError(e.message); }
      finally { if (!closed) timer = setTimeout(poll, 1600); }
    };
    poll(); return () => { closed = true; controller.abort(); clearTimeout(timer); };
  }, [runtime, screen, session?.id, revision]);
  useEffect(() => {
    if (!pairing) return;
    let closed = false, timer;
    const poll = async () => {
      if (closed || pairing.generation !== pairGeneration.current) return;
      if (pairing.expiresAt && Date.now() >= pairing.expiresAt) { setPairState('expired'); setPairing(null); return; }
      try {
        const result = await call('pair/status', { requestId: pairing.requestId, pollToken: pairing.pollToken });
        if (closed || pairing.generation !== pairGeneration.current) return;
        setPairState(result.status);
        if (result.status === 'approved' && result.token) {
          const next = { ...pairing.context, token: result.token, deviceId: result.deviceId }; saveIdentity(next); setIdentity(next); setPairing(null); setScreen('recent'); setError(''); return;
        }
        if (result.status === 'rejected' || result.status === 'expired') return;
      } catch (e) { if (!closed && pairing.generation === pairGeneration.current) setError(e.message); }
      if (!closed) timer = setTimeout(poll, 1300);
    };
    poll(); return () => { closed = true; clearTimeout(timer); };
  }, [runtime, pairing]);
  useEffect(() => { if (screen === 'chat' && messagesRef.current && stayAtBottom.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight; }, [screen, session?.id, history.messages]);
  const pair = async event => {
    event?.preventDefault(); const generation = ++pairGeneration.current; setBusy(true); setError(''); setPairing(null); setPairState('');
    try {
      const context = { ...pairingContext(pairUri), name: name.trim() || '我的手机' };
      if (!context.code) throw new Error('配对地址缺少一次性配对码');
      if (!isNative() && new URL(context.url).origin !== location.origin) throw new Error('请打开该主机的 HTTPS 配对页面');
      saveIdentity(context); const result = await call('pair', { code: context.code, name: context.name });
      if (generation !== pairGeneration.current) return;
      setPairing({ ...result, context, generation }); setPairState('pending');
      if (!runtime.isPreview && location.hash) window.history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { if (generation === pairGeneration.current) setError(e.message); } finally { if (generation === pairGeneration.current) setBusy(false); }
  };
  const choose = item => {
    if (busy || (sendPending && sendPending.id !== item.id)) { setError('请先重试确认上一条消息的发送结果。'); return; }
    if (session) drafts.current.set(session.id, draft);
    if (session?.id !== item.id) { setOlder([]); setPage(null); setSession(item); setHistoryLoaded(false); setHistory({ messages: [], interactions: [], running: false }); setDraft(drafts.current.get(item.id) || ''); }
    stayAtBottom.current = true; setScreen('chat'); setSidebarOpen(false); setError('');
  };
  const openNew = () => {
    if (busy || sendPending) { setError('请先重试确认上一条消息的发送结果。'); return; }
    if (session) drafts.current.set(session.id, draft);
    setProjectId(defaultProjectId(state?.projects || [], state?.sessions || [], session?.projectId));
    setScreen('new'); setSidebarOpen(false); setError('');
  };
  const create = async event => {
    event?.preventDefault();
    if (!projectId || busy) return; setBusy(true); setError('');
    try { const selected = state?.models?.find(item => `${item.provider}:${item.model}` === model);
      const key = `${projectId}:${model}`;
      if (pendingCreate.current?.key !== key) pendingCreate.current = { key, requestId: requestId() };
      const created = await call('create', { projectId, provider: selected?.provider, model: selected?.model, requestId: pendingCreate.current.requestId });
      pendingCreate.current = null; setSession(created); setOlder([]); setPage(null); setHistoryLoaded(true); setHistory({ messages: [], interactions: [], running: false }); setDraft(''); setScreen('chat'); stayAtBottom.current = true; refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const submit = async (event, retry = false) => {
    event?.preventDefault(); if (busy || !session || composing.current || (!retry && sendPending)) return;
    const submission = retry ? sendPending : { id: session.id, text: draft.trim(), requestId: requestId() };
    if (!submission?.text) return;
    setBusy(true); setError(''); setSendPending(submission);
    // The pending request owns its text. Keep the editor free for the next draft.
    if (!retry) { setDraft(''); drafts.current.delete(submission.id); }
    try { await call('send', submission); setSendPending(null); stayAtBottom.current = true; refresh(); }
    catch (e) { setError(`${e.message}。发送结果未确认，重试将使用同一请求编号。`); }
    finally { setBusy(false); }
  };
  const mutate = async (action, args = {}) => { setBusy(true); setError(''); try { await call(action, { id: session.id, ...args }); refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const loadEarlier = async () => {
    setBusy(true); setError(''); stayAtBottom.current = false;
    const beforeHeight = messagesRef.current?.scrollHeight || 0, beforeTop = messagesRef.current?.scrollTop || 0;
    try {
      const value = await call('history', { id: session.id, before: page?.cursor ?? history.cursor });
      setOlder(previous => [...value.messages, ...previous.filter(message => !value.messages.some(item => item.id === message.id))]); setPage({ cursor: value.cursor, hasMore: value.hasMore });
      requestAnimationFrame(() => { if (messagesRef.current) messagesRef.current.scrollTop = beforeTop + messagesRef.current.scrollHeight - beforeHeight; });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const disconnect = () => { pairGeneration.current++; clearIdentity(); setIdentity(null); setPairing(null); setPairState(''); setPairUri(''); setState(null); setSession(null); pendingCreate.current = null; setSendPending(null); setScreen('pair'); setSidebarOpen(false); setDraft(''); drafts.current.clear(); setError(''); setBusy(false); };
  const project = state?.projects?.find(p => p.id === (screen === 'chat' ? session?.projectId : projectId));
  const sessions = recentSessions(state?.sessions || [], state?.projects || [], query).filter(item => !runningOnly || item.running);
  const displayedError = error || stateError || historyError;
  const connectionState = !online || stateError || historyError ? 'failed' : state ? 'running' : 'waiting';
  const connectionLabel = !online ? '网络已断开' : stateError || historyError ? '连接中断' : state ? '已连接' : '正在连接';
  const retry = <div className="link-mobile-recovery"><ErrorText>{displayedError || (!online ? '网络已断开，请检查 Wi-Fi 或移动网络。' : '')}</ErrorText><Button onClick={() => { setError(''); refresh(); }} disabled={busy}>重新连接</Button></div>;
  const updatePairUri = value => { pairGeneration.current++; setPairing(null); setPairState(''); setBusy(false); setError(''); setPairUri(value); };

  if (screen === 'pair') return <main ref={viewportRef} className="link-mobile link-mobile-v3 link-mobile-pair" data-theme={theme}>
    <header className="link-mobile-topbar"><Brand /><span className="link-mobile-connection"><StatusDot state={online ? 'idle' : 'failed'} />{online ? '尚未连接' : '网络已断开'}</span></header>
    <section className="link-mobile-section link-mobile-pair-intro"><h1>连接你的电脑</h1><p>把桌面的项目和会话，接到手机上。</p></section>
    <section className="link-mobile-pair-card">
      <div className="link-mobile-pair-symbol"><UIIcon name="link" size={28} /></div><h2>{pairUri ? '配对信息已就绪' : isNative() ? '扫码连接工作台' : '连接桌面工作台'}</h2><p>{pairUri ? '确认设备名称，发送连接请求。' : isNative() ? '在电脑「远程连接」中点击「连接手机」，再扫描电脑上的二维码。' : '在电脑「远程连接」中点击「连接手机」，在下方粘贴配对码。'}</p>
      <label className="link-mobile-field" htmlFor="pair-name"><span>这台设备的名称</span><input id="pair-name" autoComplete="off" maxLength={128} value={name} onChange={e => setName(e.target.value)} placeholder="我的手机" /></label>
      {isNative() && !pairUri && <button className="link-mobile-scan-button" onClick={scan} disabled={busy}><UIIcon name="scan" size={21} />扫描桌面二维码</button>}
      {(pairUri || !isNative()) && <Button kind="primary" onClick={pair} disabled={!pairUri.trim() || busy || pairState === 'pending'}>{busy ? '正在连接…' : pairState === 'pending' ? '等待电脑允许…' : error ? '重新连接工作台' : '连接工作台'}</Button>}
      {isNative() && pairUri && <Button icon="scan" onClick={scan} disabled={busy}>重新扫码</Button>}
      {pairState && <div className={'link-mobile-pair-feedback ' + (pairState === 'pending' ? '' : 'is-warning')} role="status"><StatusDot state={pairState === 'pending' ? 'waiting' : pairState === 'approved' ? 'running' : 'failed'} /><div><strong>{pairState === 'pending' ? runtime.isPreview ? '模拟连接：等待演示授权' : '请在电脑上允许连接' : pairState === 'rejected' ? '电脑未允许这次连接' : pairState === 'expired' ? '配对码已过期' : '已确认'}</strong><p>{pairState === 'pending' ? runtime.isPreview ? '点击本页顶部「模拟电脑允许」继续，真实电脑不会出现请求。' : '打开电脑的「远程连接」，确认设备名称后点击「允许」。' : '请在电脑上生成新的二维码，再重新扫码。'}</p></div></div>}
      {error && <div className="link-mobile-pair-feedback is-warning"><ErrorText>{connectionError(error, isNative() && !!identity?.pin)}</ErrorText></div>}
    </section>
    <details className="link-mobile-backup" open={!isNative() || undefined}><summary>无法扫码？使用配对地址<UIIcon name="chevronDown" size={16} /></summary><form onSubmit={pair}><label className="link-mobile-field" htmlFor="pair-uri"><span>{isNative() ? '完整配对地址' : '一次性配对码或完整配对地址'}</span><textarea id="pair-uri" value={pairUri} onChange={e => updatePairUri(e.target.value)} placeholder={isNative() ? '粘贴电脑复制的 dshlink://pair?…' : '粘贴电脑提供的配对码或链接'} rows="3" spellCheck="false" /></label><Button type="submit" disabled={!pairUri.trim() || busy || pairState === 'pending'}>使用地址连接</Button></form></details>
    <div className="link-mobile-network-note"><UIIcon name="check" size={17} /><p>{isNative() ? '手机与电脑在同一 Wi-Fi 下可直接连接，无需公网。不同网络需使用可访问的 HTTPS 地址。' : '当前通过 HTTPS 连接工作台。浏览器使用电脑提供的同源配对页；Android App 也可在同一 Wi-Fi 内直连。'}</p></div>
  </main>;

  const navigate = target => {
    setSidebarOpen(false);
    if (busy) return;
    if (sendPending) { setError('请先重试确认上一条消息的发送结果，再切换页面。'); return; }
    setScreen(target);
  };
  const currentSession = state?.sessions?.find(item => item.id === session?.id) || session;
  const mainTitle = screen === 'chat' ? currentSession?.title || '新会话' : screen === 'new' ? '新会话' : screen === 'connection' ? '连接管理' : '最近';
  const mainSubtitle = screen === 'chat' ? (project?.name || '工作区') + (history.running ? ' · 正在处理' : '') : state?.host?.name || 'Harness Plus';
  return <main ref={viewportRef} className={'link-mobile link-mobile-v3 link-mobile-shell' + (screen === 'chat' ? ' link-mobile-chat' : '')} data-theme={theme}>
    <div className="link-app-content" inert={sidebarOpen ? '' : undefined} aria-hidden={sidebarOpen || undefined}>
      <header className="link-app-header"><button className="link-mobile-icon-button" aria-label="打开侧边栏" aria-controls="link-mobile-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><UIIcon name="collapse" className="link-sidebar-open-icon" size={22} /></button><div className="link-app-heading"><strong>{mainTitle}</strong><small><StatusDot state={connectionState} />{mainSubtitle}</small></div><button className="link-mobile-icon-button" aria-label="新建会话" onClick={openNew} disabled={busy || !!sendPending}><UIIcon name="edit" size={21} /></button></header>
      {screen === 'chat' && session ? <div className="link-chat-body">
        <div className="link-messages" ref={messagesRef} aria-live="polite" onScroll={event => { const node = event.currentTarget; stayAtBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90; }}>
          {history.truncated && <p className="link-empty">这里只保留最近的原生事件，完整记录请在电脑中查看。</p>}
          {(page?.hasMore ?? history.hasMore) && <Button disabled={busy} onClick={loadEarlier}>加载更早的消息</Button>}
          {!historyLoaded && !displayedError && <div className="link-list-skeleton" role="status" aria-label="正在读取会话"><span /><span /></div>}
          {historyLoaded && !history.messages?.length && <MobileEmpty title="从一个想法开始">描述你的目标，电脑会接着处理。</MobileEmpty>}
          {[...older.filter(message => !history.messages?.some(current => current.id === message.id)), ...(history.messages || [])].map((message, index) => <article className={'link-message link-message-' + message.role} key={message.id || index}><span>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Harness' : message.role}</span><p>{message.text}</p></article>)}
          {history.interactions?.map(interaction => <Interaction key={interaction.id} interaction={interaction} disabled={busy} onRespond={answer => mutate('respond', { interactionId: interaction.id, answer })} />)}
          {history.running && <p className="link-chat-working" role="status"><StatusDot state="running" />电脑正在处理…</p>}
        </div>
        {sendPending && !busy && <div className="link-send-pending" role="status"><span>上一条消息的发送结果未确认。<small className="link-send-pending-text">{sendPending.text}</small></span><Button disabled={busy} onClick={() => submit(null, true)}>重试原请求</Button></div>}
        {(displayedError || !online) && retry}
        <form className="link-composer" onSubmit={submit}><textarea aria-label="消息内容" value={draft} onChange={event => setDraft(event.target.value)} placeholder="继续你的想法…" rows="2" onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onBlur={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && event.keyCode !== 229) submit(event); }} /><div className="link-composer-footer"><small>{runtime.isPreview ? '演示回复 · 不调用模型' : project?.name || '在电脑上执行'}</small>{history.running && <Button disabled={busy} onClick={() => mutate('cancel')}>停止</Button>}<button className="link-send-button" aria-label={busy ? '正在发送' : '发送消息'} type="submit" disabled={busy || !!sendPending || !draft.trim()}><UIIcon name="chevronLeft" className="link-send-arrow" size={20} /></button></div></form>
      </div> : <div className="link-app-body">
        {screen === 'connection' ? <section className="link-connection-page"><div className="link-page-title"><h1>连接管理</h1><p>查看这台手机连接的工作台。</p></div><section className="link-mobile-host-card"><UIIcon name="link" size={23} /><div><h2>{state?.host?.name || '我的工作台'}</h2><span><StatusDot state={connectionState} />{connectionLabel}</span></div></section><dl className="link-mobile-connection-details"><div><dt>设备名称</dt><dd>{identity?.name || name || '我的手机'}</dd></div><div><dt>连接地址</dt><dd>{runtime.isPreview ? '演示工作台 · 本地模拟' : identity?.url || '当前工作台'}</dd></div><div><dt>连接方式</dt><dd>{runtime.isPreview ? '界面预览' : isNative() ? 'Android Link App' : 'HTTPS 浏览器'}</dd></div><div><dt>外观</dt><dd><button className="link-filter" onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')}>{theme === 'dark' ? '深色 · 切换浅色' : '浅色 · 切换深色'}</button></dd></div></dl><div className="link-mobile-connection-actions"><Button icon="refresh" onClick={() => { setError(''); refresh(); }} disabled={busy}>刷新连接</Button><Button onClick={disconnect} disabled={busy || !!sendPending}>断开并重新配对</Button></div><p className="link-mobile-footnote">断开只清除这台手机的连接信息，电脑中的项目和会话会保留。</p></section> : screen === 'new' ? <section className="link-new-session"><div className="link-page-title"><span className="link-new-mark"><UIIcon name="edit" size={27} /></span><h1>接下来，做点什么？</h1><p>选好工作位置，就可以开始新的会话。</p></div><form className="link-new-form" onSubmit={create}><label className="link-mobile-field"><span>工作位置</span><select aria-label="工作位置" value={projectId} onChange={event => { pendingCreate.current = null; setProjectId(event.target.value); }} disabled={busy || !state?.projects?.length}>{!state?.projects?.length && <option value="">暂无可用项目</option>}{state?.projects?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="link-mobile-field"><span>模型</span><select aria-label="选择模型" value={model} onChange={event => { pendingCreate.current = null; setModel(event.target.value); }} disabled={busy}><option value="">使用电脑默认模型</option>{state?.models?.map(item => <option key={item.provider + ':' + item.model} value={item.provider + ':' + item.model}>{item.label || item.model}</option>)}</select></label>{state && !state.projects?.length && <p className="link-empty">先在电脑添加一个项目，项目会自动出现在这里。</p>}<p className="link-mobile-footnote">自动使用最近的工作位置。消息与任务仍由电脑执行。</p><button className="link-primary-action" type="submit" disabled={busy || !projectId}>{busy ? '正在创建…' : '开始会话'}<UIIcon name="plus" size={18} /></button></form></section> : <section className="link-recents"><div className="link-page-title"><h1>最近</h1><p>接着上次的想法，继续往前。</p></div><SessionSearch value={query} onChange={setQuery} /><div className="link-recent-summary"><span>{query ? sessions.length + ' 个搜索结果' : '所有项目的会话'}</span><button className="link-filter" aria-pressed={runningOnly} onClick={() => setRunningOnly(value => !value)}><StatusDot state={runningOnly ? 'running' : 'idle'} />运行中{state?.sessions?.some(item => item.running) ? ' ' + state.sessions.filter(item => item.running).length : ''}</button></div>{!state && !displayedError ? <div className="link-list-skeleton" role="status" aria-label="正在读取最近会话"><span /><span /><span /></div> : sessions.length ? <SessionList sessions={sessions} projects={state?.projects} selectedId={session?.id} onChoose={choose} disabled={busy || !!sendPending} /> : state ? <MobileEmpty title={query ? '没有找到匹配的会话' : runningOnly ? '暂时没有运行中的会话' : '从这里开始新的想法'}>{query ? '换个关键词，或搜索项目名称。' : runningOnly ? '电脑正在处理的会话会出现在这里。' : '右上角新建会话，随时从手机接上进度。'}</MobileEmpty> : null}</section>}
        {(displayedError || !online) && retry}
      </div>}
    </div>
    {sidebarOpen && <MobileSidebar state={state} screen={screen} selectedId={session?.id} onChoose={choose} onNavigate={navigate} onNew={openNew} onClose={closeSidebar} connectionLabel={connectionLabel} connectionState={connectionState} theme={theme} onTheme={() => setTheme(value => value === 'light' ? 'dark' : 'light')} disabled={busy || !!sendPending} />}
  </main>;
}
function Brand() { return <div className="link-mobile-brand"><span className="link-mark"><UIIcon name="link" size={19} /></span><span>DSH <span className="link-mobile-brand-sub">Link</span></span></div>; }
function connectionError(message, lan) { if (/[\u3400-\u9fff]/.test(message) || !/failed to connect|timeout|timed out|unreachable/i.test(message)) return message; return lan ? '暂时无法连接电脑。请确认手机和电脑在同一 Wi-Fi，电脑已开启 Link；检查防火墙后可重新连接。' : '暂时无法连接工作台。请确认 HTTPS 地址可从手机访问，并检查服务状态、域名证书与网络转发后重试。'; }
