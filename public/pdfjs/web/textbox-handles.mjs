// Editor DOM offsets rotate with the page. Project the pointer onto the
// rendered inline edge so dragging to the right of the text always widens it.
export function bindTextBoxResize(handle, editor, signal, preview, commit) {
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    const { pointerId, clientX, clientY } = event;
    const box = editor.div.getBoundingClientRect(), edge = handle.getBoundingClientRect();
    const page = editor.parent.div.getBoundingClientRect();
    const dx = edge.x + edge.width / 2 - (box.x + box.width / 2);
    const dy = edge.y + edge.height / 2 - (box.y + box.height / 2);
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const direction = Math.sign(horizontal ? dx : dy) || 1;
    const room = horizontal
      ? (direction > 0 ? page.right - box.right : box.left - page.left)
      : (direction > 0 ? page.bottom - box.bottom : box.top - page.top);
    const start = editor.pdfreaderBoxWidth;
    const scale = editor.parentScale;
    const max = Math.max(start, start + room / scale);
    const gestures = new AbortController();
    const options = { signal: AbortSignal.any([signal, gestures.signal]) };
    let width = start;
    handle.setPointerCapture(pointerId);
    handle.addEventListener('pointermove', event => {
      if (event.pointerId !== pointerId) return;
      const delta = horizontal ? event.clientX - clientX : event.clientY - clientY;
      width = Math.min(max, Math.max(12, start + direction * delta / scale));
      preview(width);
    }, options);
    const finish = event => {
      if (event.pointerId !== pointerId) return;
      gestures.abort();
      preview(start);
      if (event.type === 'pointerup' && Math.abs(width - start) >= 1) commit(width);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      handle.addEventListener(type, finish, options);
    }
  }, { signal });
  handle.addEventListener('keydown', event => {
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const max = editor.pageDimensions[editor.rotation % 180 ? 1 : 0];
    commit(Math.round(Math.max(12, Math.min(max, editor.pdfreaderBoxWidth + direction * (event.shiftKey ? 10 : 2)))));
  }, { signal });
}
