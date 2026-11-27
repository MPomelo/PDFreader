const actionGroups = [
  [['copy', '复制']],
  [['highlight', '高亮'], ['underline', '下划线'], ['strikeout', '删除线'], ['comment', '写注释']],
  [['translate', '翻译'], ['ask', '问 AI'], ['citation', '引文']],
];

export function hasTextSelection(selection, viewer) {
  if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return false;
  const textLayer = node => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('.textLayer');
  const range = selection.getRangeAt(0);
  return viewer.contains(range.commonAncestorContainer) &&
    Boolean(textLayer(range.startContainer) || textLayer(range.endContainer));
}

export function createSelectionMenu(viewer, { run, autoShow, onDismissHostMenus, preciseSelection, preciseRects }) {
  const menu = document.createElement('div');
  menu.className = 'pdfreader-selection-toolbar';
  menu.hidden = true;
  menu.setAttribute('role', 'toolbar');
  menu.setAttribute('aria-label', '选区操作');
  const buttons = [];
  actionGroups.forEach((group, groupIndex) => {
    if (groupIndex > 0) {
      const divider = document.createElement('span');
      divider.className = 'pdfreader-selection-divider';
      divider.setAttribute('aria-hidden', 'true');
      menu.append(divider);
    }
    for (const [action, label] of group) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.action = action;
      button.tabIndex = action === 'copy' ? 0 : -1;
      menu.append(button);
      buttons.push(button);
    }
  });
  document.body.append(menu);
  let ranges = [];
  let captured = null;
  let pointer = null;
  let frame = 0;

  function close(restoreFocus = false) {
    cancelAnimationFrame(frame);
    frame = 0;
    if (menu.hidden) return;
    menu.hidden = true;
    ranges = [];
    captured = null;
    if (restoreFocus) viewer.parentElement.focus({ preventScroll: true });
  }

  function visibleRects(selection, precise) {
    if (precise) return preciseRects(precise);
    const bounds = viewer.parentElement.getBoundingClientRect();
    return Array.from({ length: selection.rangeCount }, (_, index) => [...selection.getRangeAt(index).getClientRects()]).flat()
      .filter(rect => rect.width > 0 && rect.height > 0 && rect.right > bounds.left && rect.left < bounds.right &&
        rect.bottom > bounds.top && rect.top < bounds.bottom);
  }

  function show({ precise = null, point = null, focus = false } = {}) {
    const selection = document.getSelection();
    if (!precise && !hasTextSelection(selection, viewer)) return false;
    const rects = visibleRects(selection, precise);
    if (!rects.length) return false;
    const distance = rect => Math.hypot(Math.max(rect.left - point.x, 0, point.x - rect.right),
      Math.max(rect.top - point.y, 0, point.y - rect.bottom));
    const rect = point ? rects.reduce((best, rect) => distance(rect) < distance(best) ? rect : best) : rects.at(-1);
    captured = precise;
    ranges = precise ? [] : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
    const bounds = viewer.parentElement.getBoundingClientRect();
    const inset = 6, gap = 7;
    menu.style.maxWidth = Math.max(0, bounds.width - inset * 2) + 'px';
    menu.style.maxHeight = Math.max(0, bounds.height - inset * 2) + 'px';
    menu.hidden = false;
    const x = point ? Math.max(rect.left, Math.min(rect.right, point.x)) : (rect.left + rect.right) / 2;
    const below = rect.bottom + gap;
    const above = rect.top - gap - menu.offsetHeight;
    const y = below + menu.offsetHeight <= bounds.bottom - inset ? below : above;
    menu.style.left = Math.max(bounds.left + inset, Math.min(x - menu.offsetWidth / 2, bounds.right - menu.offsetWidth - inset)) + 'px';
    menu.style.top = Math.max(bounds.top + inset, Math.min(y, bounds.bottom - menu.offsetHeight - inset)) + 'px';
    for (const [index, button] of buttons.entries()) button.tabIndex = index === 0 ? 0 : -1;
    if (focus) buttons[0].focus({ preventScroll: true });
    return true;
  }

  function finish(precise, point) {
    if (!autoShow()) return;
    close();
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (autoShow() && (!precise || precise === preciseSelection())) show({ precise, point });
    });
  }

  document.addEventListener('contextmenu', event => {
    const selection = document.getSelection();
    const precise = preciseSelection();
    if (!(event.target instanceof Element) || !viewer.contains(event.target) ||
      event.target.closest('input, textarea, [contenteditable=true], .editToolbar') || !precise && !hasTextSelection(selection, viewer)) return;
    const x = event.clientX, y = event.clientY;
    const rects = visibleRects(selection, precise);
    const hitsSelection = rects.some(rect => x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3);
    if (!hitsSelection) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    show({ precise, point: { x, y }, focus: true });
  }, true);

  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target)) { close(); onDismissHostMenus(); }
    if (event.button === 0 && event.target instanceof Element && viewer.contains(event.target) &&
        event.target.closest('.textLayer')) pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }, true);
  document.addEventListener('pointerup', event => {
    if (event.pointerId !== pointer?.id) return;
    const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 3;
    pointer = null;
    if (moved && !preciseSelection()) finish(null, { x: event.clientX, y: event.clientY });
  }, true);
  document.addEventListener('pointercancel', () => { pointer = null; }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      onDismissHostMenus();
      if (menu.hidden) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    }
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable=true]') ||
        !show({ precise: preciseSelection(), focus: true })) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  viewer.parentElement.addEventListener('scroll', () => close());
  window.addEventListener('resize', () => close());
  window.addEventListener('blur', () => { pointer = null; close(); });

  menu.addEventListener('mousedown', event => event.preventDefault());
  menu.addEventListener('focusout', event => {
    if (event.relatedTarget && !menu.contains(event.relatedTarget)) close();
  });
  menu.addEventListener('keydown', event => {
    const index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    buttons[index].tabIndex = -1;
    buttons[next].tabIndex = 0;
    buttons[next].focus({ preventScroll: true });
  });
  menu.addEventListener('click', event => {
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    const precise = captured;
    if (precise) {
      close(true);
      run(action, precise);
      return;
    }
    const selection = document.getSelection();
    selection.removeAllRanges();
    for (const range of ranges) selection.addRange(range);
    close(true);
    if (hasTextSelection(selection, viewer)) run(action);
  });

  return { close, finish, get isOpen() { return !menu.hidden; } };
}

export async function copySelectionText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* Some embedded WebViews only support the copy command. */ }
  const transfer = event => {
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener('copy', transfer, { capture: true, once: true });
  try {
    if (!document.execCommand('copy')) throw Error('无法复制选区，请使用 Ctrl+C 重试。');
  } finally { window.removeEventListener('copy', transfer, true); }
}
