const actions = [
  ['copy', '复制'], ['highlight', '高亮'], ['underline', '下划线'],
  ['strikeout', '删除线'], ['comment', '写注释'], ['translate', '翻译'],
];

export function hasTextSelection(selection, viewer) {
  if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return false;
  const textLayer = node => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('.textLayer');
  const range = selection.getRangeAt(0);
  return viewer.contains(range.commonAncestorContainer) &&
    Boolean(textLayer(range.startContainer) || textLayer(range.endContainer));
}

export function createSelectionMenu(viewer, { run, onVisibility, onDismissHostMenus }) {
  const menu = document.createElement('div');
  menu.className = 'pdfreader-selection-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '选区操作');
  const buttons = actions.map(([action, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.action = action;
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    menu.append(button);
    return button;
  });
  document.body.append(menu);
  let ranges = [];

  function close(restoreFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    ranges = [];
    if (restoreFocus) viewer.parentElement.focus({ preventScroll: true });
    onVisibility();
  }

  function open(selection, x, y) {
    ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
    menu.hidden = false;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4)) + 'px';
    buttons[0].focus({ preventScroll: true });
    onVisibility();
  }

  document.addEventListener('contextmenu', event => {
    const selection = document.getSelection();
    if (!(event.target instanceof Element) || !viewer.contains(event.target) ||
      event.target.closest('input, textarea, [contenteditable=true], .editToolbar') || !hasTextSelection(selection, viewer)) return;
    const x = event.clientX, y = event.clientY;
    const hitsSelection = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
      .some(range => [...range.getClientRects()].some(rect => x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3));
    if (!hitsSelection) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    open(selection, x, y);
  }, true);

  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target)) { close(); onDismissHostMenus(); }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      onDismissHostMenus();
      if (menu.hidden) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    }
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    const selection = document.getSelection();
    if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable=true]') || !hasTextSelection(selection, viewer)) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    event.preventDefault();
    event.stopImmediatePropagation();
    open(selection, rect.left, rect.bottom + 5);
  }, true);
  viewer.parentElement.addEventListener('scroll', () => close());
  window.addEventListener('resize', () => close());
  window.addEventListener('blur', () => close());

  menu.addEventListener('mousedown', event => event.preventDefault());
  menu.addEventListener('keydown', event => {
    const index = buttons.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'Tab') { close(true); return; }
    else return;
    event.preventDefault();
    event.stopPropagation();
    buttons[next].focus({ preventScroll: true });
  });
  menu.addEventListener('click', event => {
    const action = event.target.closest('button')?.dataset.action;
    if (!action) return;
    const selection = document.getSelection();
    selection.removeAllRanges();
    for (const range of ranges) selection.addRange(range);
    close(true);
    if (hasTextSelection(selection, viewer)) run(action);
  });

  return { close, get isOpen() { return !menu.hidden; } };
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
