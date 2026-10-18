/** In-memory fixtures. This module deliberately has no API, storage or native imports. */
export function createPreviewRuntime({ native = true, onScan = () => {}, onChange = () => {} } = {}) {
  let identity = null, pairing = null, sequence = 0, failed = false;
  const listeners = new Set(), creates = new Map(), sends = new Set();
  const projects = [{ id: 'preview-dowork', name: 'Dowork', path: '~/Workspace/Dowork' }, { id: 'preview-notes', name: '灵感笔记', path: '~/Workspace/notes' }];
  const models = [{ provider: 'demo', model: 'focused', label: '专注模式 · 演示模型' }, { provider: 'demo', model: 'creative', label: '创意模式 · 演示模型' }];
  const now = Date.now(), yesterday = new Date(now), earlier = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1); earlier.setDate(earlier.getDate() - 12);
  const sessions = [
    { id: 'preview-design', projectId: projects[0].id, title: '完善手机连接体验', running: false, createdAt: now - 3_600_000, updatedAt: now },
    { id: 'preview-ideas', projectId: projects[1].id, title: '下一版的想法', running: true, createdAt: now - 7_200_000, updatedAt: now },
    { id: 'preview-readme', projectId: projects[0].id, title: '整理项目说明', running: false, createdAt: yesterday.getTime() - 3_600_000, updatedAt: yesterday.getTime() },
    { id: 'preview-connection', projectId: projects[0].id, title: '让手机和电脑顺畅连接', running: false, createdAt: earlier.getTime() - 3_600_000, updatedAt: earlier.getTime() },
  ];
  let lastUpdatedAt = now;
  const touch = () => (lastUpdatedAt = Math.max(Date.now(), lastUpdatedAt + 1));
  const histories = new Map(sessions.map(session => [session.id, { messages: [{ id: session.id + '-user', role: 'user', text: '把当前进度整理一下，我想在手机上接着做。' }, { id: session.id + '-assistant', role: 'assistant', text: '会话已准备好，可以继续描述想法，也可以在侧边栏打开其他最近会话。\n\n这是界面演示，消息只保留在当前页面。' }], interactions: [], running: session.running, hasMore: false }]));
  const copy = value => JSON.parse(JSON.stringify(value));
  const changed = () => onChange({ pairing: pairing?.status || '', failed });
  const emitIdentity = () => { for (const listener of listeners) listener(); changed(); };
  const runtime = {
    isPreview: true,
    isNative: () => native,
    bootstrap: () => identity ? copy(identity) : null,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isLocalIdentitySave: () => false,
    saveIdentity(value) { identity = copy(value); changed(); },
    clearIdentity() { identity = null; pairing = null; failed = false; changed(); },
    contextUri(value) { return value?.code ? 'dshlink://pair?url=https%3A%2F%2Fpreview.invalid&code=DEMO-ONLY' : ''; },
    pairingContext(input) { if (!input.trim()) throw new Error('请先完成扫码演示，或输入任意演示配对码'); return { url: native ? 'https://preview.invalid' : globalThis.location?.origin || 'https://preview.invalid', code: 'DEMO-ONLY' }; },
    requestId: () => 'preview-request-' + (++sequence),
    scan: () => onScan(),
    completeScan() { identity = { url: 'https://preview.invalid', code: 'DEMO-ONLY', name: '我的手机' }; emitIdentity(); },
    decide(status) { if (!['approved', 'rejected', 'expired'].includes(status) || !pairing) return; pairing.status = status; changed(); },
    setNetworkFailure(value) { failed = Boolean(value); changed(); },
    enterWorkspace() { failed = false; pairing = null; identity = { url: 'https://preview.invalid', token: 'demo-token-in-memory', name: '我的手机', deviceId: 'demo-device' }; emitIdentity(); },
    async call(action, args = {}) {
      if (failed) throw new Error('演示：暂时无法连接电脑，请恢复演示网络后重试。');
      if (action === 'pair') { pairing = { requestId: 'preview-pair', pollToken: 'demo-poll-only', status: 'pending' }; changed(); return { requestId: pairing.requestId, pollToken: pairing.pollToken, expiresAt: Date.now() + 300_000 }; }
      if (action === 'pair/status') { if (!pairing || args.requestId !== pairing.requestId || args.pollToken !== pairing.pollToken) throw new Error('演示配对请求已失效'); return { status: pairing.status, ...(pairing.status === 'approved' ? { token: 'demo-token-in-memory', deviceId: 'demo-device' } : {}) }; }
      if (!identity?.token) throw new Error('请先完成演示配对');
      if (action === 'state') return copy({ host: { name: '我的电脑 · 演示' }, projects, sessions, models });
      if (action === 'create') {
        if (creates.has(args.requestId)) return copy(creates.get(args.requestId));
        if (!projects.some(project => project.id === args.projectId)) throw new Error('请选择演示项目');
        const createdAt = touch();
        const session = { id: 'preview-session-' + (++sequence), projectId: args.projectId, title: '新会话', running: false, model: args.model || 'focused', createdAt, updatedAt: createdAt };
        sessions.unshift(session); histories.set(session.id, { messages: [], interactions: [], running: false, hasMore: false }); creates.set(args.requestId, session); return copy(session);
      }
      const history = histories.get(args.id);
      if (!history) throw new Error('找不到这段演示会话');
      if (action === 'history') return copy(history);
      if (action === 'send') {
        if (sends.has(args.requestId)) return { accepted: true };
        sends.add(args.requestId); const session = sessions.find(item => item.id === args.id);
        history.messages.push({ id: 'preview-message-' + (++sequence), role: 'user', text: args.text });
        history.messages.push({ id: 'preview-message-' + (++sequence), role: 'assistant', text: session.model === 'creative' ? '收到。可以先把这个想法拆成几个小步骤，再逐个完善交互和文案。\n\n这是创意模式的固定演示回复，没有向任何模型服务发送消息。' : '收到，我们可以从这个目标继续。这里演示了消息发送与会话衔接，真实使用时会由你的电脑执行任务。\n\n这是固定演示回复，没有调用模型。' });
        if (session.title === '新会话') session.title = args.text.slice(0, 24);
        session.updatedAt = touch();
        return { accepted: true };
      }
      if (action === 'cancel') { history.running = false; sessions.find(item => item.id === args.id).running = false; return { ok: true }; }
      if (action === 'respond') { history.interactions = history.interactions.filter(item => item.id !== args.interactionId); return { ok: true }; }
      throw new Error('不支持这项演示操作');
    },
  };
  return runtime;
}
