import React, { useEffect, useState } from 'react';
import * as runtime from './api.mjs';
import { LinkMobileApp } from './mobile.jsx';
import { BrandLogo } from './brand.jsx';

/** Pair once, then run the same workspace and plugins as the desktop browser. */
export function LinkWorkbenchEntry() {
  const [identity, setIdentity] = useState(() => runtime.bootstrap());
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const sync = () => setIdentity(runtime.bootstrap());
    const failed = event => setError(event.detail || '工作台暂时无法打开，请重试');
    window.addEventListener('link:identity-updated', sync);
    window.addEventListener('link:bootstrap', sync);
    window.addEventListener('link:workbench-error', failed);
    return () => { window.removeEventListener('link:identity-updated', sync); window.removeEventListener('link:bootstrap', sync); window.removeEventListener('link:workbench-error', failed); };
  }, []);
  useEffect(() => {
    if (!identity?.token) return;
    let closed = false;
    setError('');
    runtime.openWorkbench().catch(reason => { if (!closed) setError(reason.message); });
    return () => { closed = true; };
  }, [identity?.token, attempt]);
  if (!identity?.token) return <LinkMobileApp />;
  return <main className="link-workbench-loading" style={{ minHeight: '100dvh', display: 'grid', placeContent: 'center', justifyItems: 'center', gap: 16, padding: 24, boxSizing: 'border-box', fontFamily: 'system-ui', colorScheme: 'light dark' }}><BrandLogo size={64} /><h1 style={{ margin: 0, fontSize: 22 }}>DSH-Plus</h1><p role={error ? 'alert' : 'status'} style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{error || '正在打开工作台…'}</p>{error && <><button type="button" onClick={() => setAttempt(value => value + 1)}>重新打开工作台</button><button type="button" onClick={() => { runtime.clearIdentity(); setIdentity(null); }}>重新配对</button></>}</main>;
}
