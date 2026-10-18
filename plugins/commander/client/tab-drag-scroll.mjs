// Preserve clicks and keyboard activation; only left-button mouse drags scroll.
export function createTabDragScroll() {
  let drag = null, suppressClick = false;
  const finish = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    delete drag.viewport.dataset.dragging;
    drag = null;
  };
  return {
    onPointerDown(event) {
      if (event.pointerType !== 'mouse' || event.button !== 0 || drag) return;
      suppressClick = false;
      const viewport = event.currentTarget;
      if (viewport.scrollWidth <= viewport.clientWidth) return;
      drag = { viewport, pointerId: event.pointerId, startX: event.clientX, scrollLeft: viewport.scrollLeft };
      // Capture on the original button so an ordinary click still selects it.
      const target = event.target.closest('button') || viewport;
      target.setPointerCapture(event.pointerId);
    },
    onPointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!(event.buttons & 1)) { finish(event); return; }
      const delta = event.clientX - drag.startX;
      if (!suppressClick && Math.abs(delta) < 5) return;
      suppressClick = true;
      drag.viewport.dataset.dragging = 'true';
      event.preventDefault();
      drag.viewport.scrollLeft = drag.scrollLeft - delta;
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    onClickCapture(event) {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onDragStart(event) { event.preventDefault(); },
  };
}
