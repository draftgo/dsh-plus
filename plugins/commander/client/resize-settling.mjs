export function trackFrameResize(frame, ResizeObserverClass, schedule = setTimeout, cancel = clearTimeout) {
  if (!frame || !ResizeObserverClass) return () => {};
  let width = Math.round(frame.getBoundingClientRect().width);
  let timer;
  const observer = new ResizeObserverClass(entries => {
    const nextWidth = Math.round(entries[0]?.contentRect.width ?? frame.getBoundingClientRect().width);
    if (nextWidth === width) return;
    width = nextWidth;
    frame.setAttribute('data-plus-resizing', '');
    if (timer) cancel(timer);
    timer = schedule(() => {
      timer = undefined;
      frame.removeAttribute('data-plus-resizing');
    }, 260);
  });
  observer.observe(frame);
  return () => {
    observer.disconnect();
    if (timer) cancel(timer);
    frame.removeAttribute('data-plus-resizing');
  };
}
