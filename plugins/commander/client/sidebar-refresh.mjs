/** Poll native status only while visible; Workspace rows already have a Host feed. */
export function startSidebarPolling({ refresh, onError, isActive, document: page = globalThis.document, schedule = setTimeout, unschedule = clearTimeout }) {
  const controller = new AbortController();
  let disposed = false, running = false, failures = 0, timer;
  const poll = async () => {
    unschedule(timer);
    if (disposed || running || page?.hidden) return;
    running = true;
    try { await refresh(controller.signal); failures = 0; }
    catch (error) {
      failures++;
      if (!disposed) onError(error);
    }
    finally {
      running = false;
      if (!disposed && !page?.hidden) {
        const delay = failures ? Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 4)) : (isActive() ? 2000 : 10000);
        timer = schedule(poll, delay);
      }
    }
  };
  const visibility = () => { if (page?.hidden) unschedule(timer); else void poll(); };
  page?.addEventListener('visibilitychange', visibility);
  void poll();
  return () => { disposed = true; unschedule(timer); controller.abort(); page?.removeEventListener('visibilitychange', visibility); };
}
