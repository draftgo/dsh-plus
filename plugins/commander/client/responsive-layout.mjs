export const VIEWPORT_BREAKPOINT = 1024;
export const VIEWPORT_SETTLE_MS = 90;

export function createResponsiveLayoutActions(actions, schedule = setTimeout, cancel = clearTimeout) {
  let committed, pending = 0, timer;
  const commit = width => {
    pending = 0;
    committed = width;
    actions.setViewportWidth(width);
  };
  return {
    ...actions,
    setViewportWidth(rawWidth) {
      const width = Math.round(rawWidth);
      if (!Number.isFinite(width) || width <= 0 || width === pending || width === committed) return;
      if (committed === undefined || (committed < VIEWPORT_BREAKPOINT) !== (width < VIEWPORT_BREAKPOINT)) {
        if (timer) cancel(timer);
        timer = undefined;
        commit(width);
        return;
      }
      if (width < VIEWPORT_BREAKPOINT) return;
      pending = width;
      if (timer) cancel(timer);
      timer = schedule(() => {
        timer = undefined;
        if (pending) commit(pending);
      }, VIEWPORT_SETTLE_MS);
    },
    dispose() {
      if (timer) cancel(timer);
      timer = undefined;
      if (pending) commit(pending);
    },
  };
}
