/** Poll native status only while visible; Workspace rows already have a Host feed. */
export function startSidebarPolling({ refresh, onError, isActive, document: page = globalThis.document, schedule = setTimeout, unschedule = clearTimeout }) {
  const controller = new AbortController();
  let disposed = false, running = false, timer;
  const poll = async () => {
    unschedule(timer);
    if (disposed || running || page?.hidden) return;
    running = true;
    try { await refresh(controller.signal); }
    catch (error) { if (!disposed) onError(error); }
    finally {
      running = false;
      if (!disposed && !page?.hidden) timer = schedule(poll, isActive() ? 2000 : 10000);
    }
  };
  const visibility = () => { if (page?.hidden) unschedule(timer); else void poll(); };
  page?.addEventListener('visibilitychange', visibility);
  void poll();
  return () => { disposed = true; unschedule(timer); controller.abort(); page?.removeEventListener('visibilitychange', visibility); };
}
