import React, { useCallback, useEffect, useRef, useState } from 'react';
import { bootstrap, call, clearIdentity, contextUri, isLocalIdentitySave, isNative, pairingContext, requestId, saveIdentity, scan } from './api.mjs';
import { Button, ErrorText, StatusDot, useLinkStyle } from './app.jsx';
import { Interaction } from './interaction.jsx';

export function LinkMobileApp() {
  useLinkStyle();
  const initial = useRef(bootstrap()).current;
  const [older, setOlder] = useState([]), [page, setPage] = useState(null);
  const pendingCreate = useRef(null);
  const pairGeneration = useRef(0);
  const [identity, setIdentity] = useState(initial), [screen, setScreen] = useState(initial?.token ? 'home' : 'pair');
  const [pairUri, setPairUri] = useState(() => contextUri(initial) || new URLSearchParams(location.hash.slice(1)).get('code') || '');
  const [name, setName] = useState(initial?.name || ''), [pairing, setPairing] = useState(null), [pairState, setPairState] = useState('');
  const [state, setState] = useState(null), [projectId, setProjectId] = useState(''), [session, setSession] = useState(null), [history, setHistory] = useState({ messages: [], interactions: [], running: false });
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [sendPending, setSendPending] = useState(null), [revision, setRevision] = useState(0), [model, setModel] = useState('');
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    const changed = () => {
      const next = bootstrap();
      if (isLocalIdentitySave(next)) return;
      pairGeneration.current++;
      setIdentity(next); setPairUri(contextUri(next)); setScreen(next?.token ? 'home' : 'pair');
      setPairing(null); setPairState(''); setError(''); setBusy(false);
      if (next?.name) setName(next.name);
    };
    window.addEventListener('link:bootstrap', changed); return () => window.removeEventListener('link:bootstrap', changed);
  }, []);
  useEffect(() => {
    if (screen === 'pair') return;
    let closed = false, timer; const controller = new AbortController();
    const poll = async () => {
      try {
        if (screen === 'home') {
          const next = await call('state', {}, controller.signal);
          if (!closed) { setState(next); setProjectId(current => next.projects?.some(p => p.id === current) ? current : next.projects?.[0]?.id || ''); setError(''); }
        } else if (session) {
          const next = await call('history', { id: session.id }, controller.signal);
          if (!closed) { setHistory(next); setError(''); }
        }
      } catch (e) { if (!closed) setError(e.message); }
      finally { if (!closed) timer = setTimeout(poll, 1600); }
    };
    poll(); return () => { closed = true; controller.abort(); clearTimeout(timer); };
  }, [screen, session?.id, revision]);
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
          const next = { ...pairing.context, token: result.token, deviceId: result.deviceId }; saveIdentity(next); setIdentity(next); setPairing(null); setScreen('home'); setError(''); return;
        }
        if (result.status === 'rejected' || result.status === 'expired') return;
      } catch (e) { if (!closed && pairing.generation === pairGeneration.current) setError(e.message); }
      if (!closed) timer = setTimeout(poll, 1300);
    };
    poll(); return () => { closed = true; clearTimeout(timer); };
  }, [pairing]);
  const pair = async event => {
    event?.preventDefault(); const generation = ++pairGeneration.current; setBusy(true); setError('');
    try {
      const context = { ...pairingContext(pairUri), name: name.trim() || '我的手机' };
      if (!context.code) throw new Error('配对地址缺少一次性配对码');
      if (!isNative() && new URL(context.url).origin !== location.origin) throw new Error('请打开该主机的公网配对页面');
      saveIdentity(context); const result = await call('pair', { code: context.code, name: context.name });
      if (generation !== pairGeneration.current) return;
      setPairing({ ...result, context, generation }); setPairState('pending');
      if (location.hash) window.history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { if (generation === pairGeneration.current) setError(e.message); } finally { if (generation === pairGeneration.current) setBusy(false); }
  };
  const choose = item => { setOlder([]); setPage(null); setSession(item); setHistory({ messages: [], interactions: [], running: false }); setScreen('chat'); setSendPending(null); setError(''); };
  const create = async () => {
    if (!projectId || busy) return; setBusy(true); setError('');
    try { const selected = state?.models?.find(item => `${item.provider}:${item.model}` === model);
      const key = `${projectId}:${model}`;
      if (pendingCreate.current?.key !== key) pendingCreate.current = { key, requestId: requestId() };
      choose(await call('create', { projectId, provider: selected?.provider, model: selected?.model, requestId: pendingCreate.current.requestId })); pendingCreate.current = null; }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const submit = async (event, retry = false) => {
    event?.preventDefault(); if (busy || !session) return;
    const submission = retry ? sendPending : { id: session.id, text: draft.trim(), requestId: requestId() };
    if (!submission?.text) return;
    setBusy(true); setError(''); setSendPending(submission);
    try { await call('send', submission); setSendPending(null); setDraft(''); refresh(); }
    catch (e) { setError(`${e.message}。发送结果未确认，重试将使用同一请求编号。`); }
    finally { setBusy(false); }
  };
  const mutate = async (action, args = {}) => { setBusy(true); setError(''); try { await call(action, { id: session.id, ...args }); refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const loadEarlier = async () => {
    setBusy(true); setError('');
    try {
      const value = await call('history', { id: session.id, before: page?.cursor ?? history.cursor });
      setOlder(previous => [...value.messages, ...previous]); setPage({ cursor: value.cursor, hasMore: value.hasMore });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const disconnect = () => { pairGeneration.current++; clearIdentity(); setIdentity(null); setPairing(null); setPairState(''); setPairUri(''); setState(null); setSession(null); setScreen('pair'); setError(''); setBusy(false); };
  const project = state?.projects?.find(p => p.id === projectId);
  if (screen === 'pair') return <main className="link-mobile link-mobile-pair"><Brand /><div className="link-mobile-copy"><span className="link-kicker">YOUR WORKSPACE. WITH YOU.</span><h1>你的工作，<br /><em>不必留在桌面。</em></h1><p>{isNative() ? '扫描电脑上的二维码。确认之后，继续同一段工作。' : '输入桌面配对码，连接你自己的工作台。'}</p></div><form onSubmit={pair} className="link-pair-form"><div className="link-pair-input"><label htmlFor="pair-uri">{isNative() ? '配对地址' : '一次性配对码'}</label><textarea id="pair-uri" value={pairUri} onChange={e => { pairGeneration.current++; setPairing(null); setPairState(''); setBusy(false); setPairUri(e.target.value); }} placeholder={isNative() ? '粘贴 dshlink://pair?...' : '输入桌面显示的配对码'} rows="2" /><label htmlFor="pair-name">设备名称</label><input id="pair-name" autoComplete="off" value={name} onChange={e => setName(e.target.value)} placeholder="我的手机" /></div><div className="link-mobile-actions">{isNative() && <Button icon="scan" onClick={scan}>扫描二维码</Button>}<Button kind="primary" type="submit" disabled={!pairUri || busy || pairState === 'pending'}>{busy ? '正在连接…' : '连接工作台'}</Button><Button onClick={disconnect}>清除并重新配对</Button></div></form>{pairState && <div className="link-pair-status" role="status"><StatusDot state={pairState === 'pending' ? 'waiting' : pairState === 'approved' ? 'running' : 'failed'} /><span>{pairState === 'pending' ? '请在电脑上确认这台设备…' : pairState === 'rejected' ? '桌面已拒绝，请生成新配对码重试' : pairState === 'expired' ? '配对已过期，请生成新配对码' : '已确认'}</span></div>}<ErrorText>{error}</ErrorText></main>;
  if (screen === 'chat' && session) return <main className="link-mobile link-mobile-chat"><header className="link-mobile-header"><Button icon="arrowLeft" onClick={() => { setScreen('home'); setError(''); }}>返回</Button><div><strong>{session.title || '新会话'}</strong><small>{project?.name || '工作区'}</small></div><StatusDot state={history.running ? 'running' : 'idle'} /></header><div className="link-messages" aria-live="polite">{history.truncated && <p className="link-empty">这里只保留最近的原生事件，完整记录请在桌面工具中查看。</p>}{(page?.hasMore ?? history.hasMore) && <Button disabled={busy} onClick={loadEarlier}>加载更早的消息</Button>}{!history.messages?.length && <p className="link-empty">描述目标，让工作开始。</p>}{[...older.filter(message => !history.messages?.some(current => current.id === message.id)), ...(history.messages || [])].map((message, index) => <article className={`link-message link-message-${message.role}`} key={message.id || index}><span>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Agent' : message.role}</span><p>{message.text}</p></article>)}{history.interactions?.map(interaction => <Interaction key={interaction.id} interaction={interaction} disabled={busy} onRespond={answer => mutate('respond', { interactionId: interaction.id, answer })} />)}</div>{sendPending && <div className="link-send-pending" role="status"><span>上一条消息的发送结果未确认。</span><Button disabled={busy} onClick={() => submit(null, true)}>重试原请求</Button></div>}<form className="link-composer" onSubmit={submit}><textarea aria-label="消息内容" value={draft} onChange={e => setDraft(e.target.value)} placeholder="继续描述你想做的事…" rows="2" disabled={!!sendPending && !busy} /><div className="link-composer-actions">{history.running && <Button icon="closeCircle" disabled={busy} onClick={() => mutate('cancel')}>停止</Button>}<Button kind="primary" type="submit" icon="send" disabled={busy || !!sendPending || !draft.trim()}>发送</Button></div></form><ErrorText>{error}</ErrorText>{error && <Button onClick={refresh} disabled={busy}>重新连接</Button>}</main>;
  return <main className="link-mobile link-mobile-home"><header className="link-mobile-header"><Brand /><Button icon="logout" onClick={disconnect}>断开</Button></header><div className="link-mobile-copy"><span className="link-kicker">{state?.host?.name || 'YOUR WORKSPACE'}</span><h1>从这里，<em>继续。</em></h1><p>同一台主机，同一组会话。选择项目，接着完成你的想法。</p></div>{!state && !error && <p className="link-empty">正在读取工作台…</p>}<div className="link-projects" aria-label="项目">{state?.projects?.map(item => <button key={item.id} className={`link-project ${projectId === item.id ? 'is-active' : ''}`} onClick={() => setProjectId(item.id)} aria-pressed={projectId === item.id}><span>{item.name}</span><small>{item.path}</small></button>)}{state && !state.projects?.length && <p className="link-empty">请先在桌面添加一个项目。</p>}</div><div className="link-session-actions">{!!state?.models?.length && <label className="link-model-select">新会话模型<select value={model} onChange={e => setModel(e.target.value)}><option value="">使用主机默认模型</option>{state.models.map(item => <option key={`${item.provider}:${item.model}`} value={`${item.provider}:${item.model}`}>{item.label || item.model}</option>)}</select></label>}<Button kind="primary" icon="add" onClick={create} disabled={busy || !projectId}>新建会话</Button>{state?.sessions?.filter(item => item.projectId === projectId).map(item => <button className="link-session" key={item.id} onClick={() => choose(item)}><StatusDot state={item.running ? 'running' : 'idle'} /><span>{item.title || '未命名会话'}</span><small>{item.running ? '运行中' : '打开'}</small></button>)}</div><ErrorText>{error}</ErrorText>{error && <Button onClick={refresh}>重新连接</Button>}</main>;
}
function Brand() { return <div className="link-mobile-brand"><span className="link-mark" aria-hidden="true">↗</span><span>DSH Link</span></div>; }
