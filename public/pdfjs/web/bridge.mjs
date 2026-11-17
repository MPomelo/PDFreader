// PDFreader bridge for PDF.js 6.5.438. Upstream integration stays in this file.
import { PDFViewerApplication as app, PDFViewerApplicationOptions as options } from './viewer.mjs';
import { normalizeSelectionText } from './selection-text.mjs';
import { ExportState } from './export-state.mjs';
import { hasCommentDraft, commitCommentDraft } from './comment-tools.mjs';
options.set('enableScripting', false);
await app.initializedPromise;
let documentId = '', activeDocument = null, selection = '', selectionRaw = '', selectionRects = [], selectionAnchor = '';
let outline = [], destinations = [], pageHasText = null, ledger = new ExportState();
let queue = Promise.resolve(), scanSequence = 0, exporting = false;
let pendingEdit = false;
const snapshots = new Map();
const post = data => parent.postMessage({ channel: 'pdfreader', documentId, ...data }, location.origin);
const storageHash = () => activeDocument?.annotationStorage.serializable.hash || '';
function state() {
  const current = window.getSelection?.();
  const box = selection && current?.rangeCount ? current.getRangeAt(0).getBoundingClientRect() : null;
  return { documentId, page: app.pdfViewer.currentPageNumber, pages: activeDocument.numPages,
    selection, selectionRaw, selectionRects, selectionAnchor, pageHasText, outline, zoom: String(app.pdfViewer.currentScaleValue || 'auto'),
    selectionViewport: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
    dirty: ledger.dirty || pendingEdit || hasCommentDraft(document), revision: ledger.revision };
}
function publish() {
  if (!activeDocument || activeDocument !== app.pdfDocument) return;
  post({ type: 'state', state: state() });
}
function observe() {
  if (!activeDocument || activeDocument !== app.pdfDocument) return;
  const revision = ledger.revision;
  ledger.observe(storageHash());
  if (revision !== ledger.revision) publish();
}
function flush() {
  commitCommentDraft(document);
  app.pdfViewer._layerProperties.annotationEditorUIManager?.endCurrentEditing();
  pendingEdit = false;
  observe();
  publish();
  return state();
}
let observeScheduled = false;
function scheduleObserve() {
  if (observeScheduled) return;
  observeScheduled = true;
  setTimeout(() => { observeScheduled = false; observe(); publish(); }, 0);
}
async function readPageText() {
  const sequence = ++scanSequence, pdf = activeDocument, id = documentId;
  if (!pdf) return;
  const page = app.pdfViewer.currentPageNumber;
  pageHasText = null; publish();
  try {
    const content = await (await pdf.getPage(page)).getTextContent();
    if (sequence !== scanSequence || id !== documentId || pdf !== activeDocument) return;
    pageHasText = content.items.some(item => typeof item.str === 'string' && item.str.trim());
    publish();
  } catch { /* Leave unknown, rather than claiming that a failed page is a scan. */ }
}
app.eventBus.on('pagechanging', () => { publish(); void readPageText(); });
app.eventBus.on('scalechanging', publish);
let scrollPending = false;
document.getElementById('viewerContainer')?.addEventListener('scroll', () => {
  if (scrollPending || !selection) return;
  scrollPending = true; requestAnimationFrame(() => { scrollPending = false; publish(); });
});
app.eventBus.on('annotationeditorstateschanged', scheduleObserve);
// Viewer initializes its callbacks after firstPagePromise, so wrap that point
// rather than installing callbacks too early and having them overwritten later.
const initializeStorage = app._initializeAnnotationStorageCallbacks.bind(app);
app._initializeAnnotationStorageCallbacks = pdf => {
  initializeStorage(pdf);
  const storage = pdf.annotationStorage;
  const modified = storage.onSetModified, reset = storage.onResetModified;
  storage.onSetModified = () => { modified?.(); scheduleObserve(); };
  storage.onResetModified = () => { reset?.(); scheduleObserve(); };
};
// Use the acknowledged export state for browser unload, too. Upstream regards
// non-empty storage as dirty forever, including after a successful disk export.
app._hasChanges = () => ledger.dirty || pendingEdit || hasCommentDraft(document);
for (const event of ['input', 'change', 'pointerup', 'keyup']) document.addEventListener(event, scheduleObserve, true);
document.addEventListener('close', scheduleObserve, true);
document.addEventListener('input', event => {
  if (event.target instanceof Element && event.target.closest('.annotationEditorLayer, .annotationLayer')) {
    pendingEdit = true; publish();
  }
}, true);
// Viewer save/download and Ctrl+S must use the host's durable export path. In
// particular, upstream save() falls back to original bytes after failure.
for (const method of ['save', 'download', 'downloadOrSave']) {
  app[method] = async () => { if (activeDocument && !exporting) post({ type: 'export-requested' }); };
}
// DOM drops inside an iframe do not bubble to React. Route them through the
// same unsaved-change guard as native drops and the host file picker.
async function requestFile(file) {
  const id = documentId;
  const bytes = new Uint8Array(await file.arrayBuffer());
  parent.postMessage({ channel: 'pdfreader', type: 'file-open-requested', documentId: id,
    filename: file.name, bytes }, location.origin, [bytes.buffer]);
}
window.addEventListener('drop', event => {
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault(); event.stopImmediatePropagation();
  void (async () => { for (const file of files) await requestFile(file); })().catch(error => post({ type: 'error', message: String(error) }));
}, true);
document.addEventListener('change', event => {
  if (event.target?.id !== 'fileInput') return;
  const file = event.target.files[0];
  event.stopImmediatePropagation();
  if (file) void requestFile(file).catch(error => post({ type: 'error', message: String(error) }));
}, true);

document.addEventListener('selectionchange', () => {
  const current = window.getSelection(), viewer = document.getElementById('viewer');
  selectionRaw = ''; selection = ''; selectionRects = []; selectionAnchor = '';
  if (current?.anchorNode && viewer.contains(current.anchorNode) && !current.isCollapsed) {
    selectionRaw = current.toString();
    selection = normalizeSelectionText(selectionRaw);
    // Text item and character offsets survive page fit/zoom and sidebar resize.
    // Normalized DOM rectangles alone drift with font rounding at new scales.
    function boundary(node, offset) {
      const element = node.nodeType === 1 ? node : node.parentElement;
      const span = element?.closest('.textLayer span');
      const layer = span?.closest('.textLayer'), page = span?.closest('.page');
      if (!span || !layer || !page) return null;
      const prefix = document.createRange(); prefix.selectNodeContents(span); prefix.setEnd(node, offset);
      return [Number(page.dataset.pageNumber), [...layer.querySelectorAll('span')].indexOf(span), prefix.toString().length];
    }
    if (current.rangeCount === 1) { const range = current.getRangeAt(0); const start = boundary(range.startContainer,range.startOffset), end = boundary(range.endContainer,range.endOffset); if (start && end) selectionAnchor = JSON.stringify([start,end]); }
    const pages = [...viewer.querySelectorAll('.page')].map(element => ({ page: Number(element.dataset.pageNumber), box: element.getBoundingClientRect() }));
    for (let i = 0; i < current.rangeCount; i++) {
      for (const rect of current.getRangeAt(i).getClientRects()) {
        if (!rect.width || !rect.height) continue;
        for (const { page, box } of pages) {
          const left = Math.max(rect.left, box.left), top = Math.max(rect.top, box.top);
          const right = Math.min(rect.right, box.right), bottom = Math.min(rect.bottom, box.bottom);
          if (right <= left || bottom <= top) continue;
          selectionRects.push({ page, x: (left - box.left) / box.width, y: (top - box.top) / box.height,
            width: (right - left) / box.width, height: (bottom - top) / box.height });
        }
      }
    }
  }
  publish();
});

window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.channel !== 'pdfreader') return;
  const message = event.data;
  if (message.type === 'hello') { post({ type: 'ready' }); return; }
  if (message.type === 'theme' && ['light','dark'].includes(message.theme)) { document.documentElement.dataset.theme = message.theme; document.documentElement.style.colorScheme = message.theme; return; }
  if (message.type === 'host-ui') { document.documentElement.classList.toggle('pdfreader-host-toolbar', message.enabled === true); window.dispatchEvent(new Event('resize')); return; }
  if (message.type === 'open') {
    documentId = message.documentId;
    activeDocument = null; selection = ''; selectionRaw = ''; selectionRects = []; selectionAnchor = '';
    outline = []; destinations = []; pageHasText = null; ++scanSequence;
    snapshots.clear(); ledger = new ExportState(); pendingEdit = false;
  } else if (message.documentId !== documentId) return;
  queue = queue.catch(() => {}).then(async () => {
    if (message.documentId !== documentId) return;
    const reply = (result, transfer = []) => parent.postMessage({ channel: 'pdfreader', documentId: message.documentId,
      type: 'reply', requestId: message.requestId, result }, location.origin, transfer);
    try {
      if (message.type === 'open') {
        // The shell has already resolved Save / Discard / Cancel. Suppress the
        // upstream close() auto-download, which cannot acknowledge a disk write.
        delete app._annotationStorageModified;
        await app.open({ data: message.bytes, filename: message.filename });
        if (message.documentId !== documentId) return;
        activeDocument = app.pdfDocument;
        ledger = new ExportState(storageHash());
        const entries = await activeDocument.getOutline();
        if (message.documentId !== documentId) return;
        function flatten(items) { for (const item of items || []) { const index = destinations.length; destinations.push(item.dest); outline.push({ title: item.title, index }); flatten(item.items); } }
        flatten(entries); publish(); reply(state()); void readPageText();
      } else if (message.type === 'outline') {
        const dest = destinations[message.index];
        if (dest) void app.pdfLinkService.goToDestination(dest);
      } else {
        if (!activeDocument || activeDocument !== app.pdfDocument) throw Error('没有可操作的文档');
        if (message.type === 'action') {
          const action = message.action;
          if (action === 'previous') app.pdfViewer.currentPageNumber = Math.max(1, app.pdfViewer.currentPageNumber - 1);
          else if (action === 'next') app.pdfViewer.currentPageNumber = Math.min(activeDocument.numPages, app.pdfViewer.currentPageNumber + 1);
          else if (action === 'zoom-in') app.zoomIn();
          else if (action === 'zoom-out') app.zoomOut();
          else if (action === 'find') app.findBar.open();
          else if (action === 'rotate') app.rotatePages(90);
          else if (action === 'print') app.triggerPrinting();
          else if (action === 'select') app.eventBus.dispatch('switchannotationeditormode', { source: app, mode: 0 });
          else if (action === 'thumbnails') app.viewsManager?.switchView(1, true);
          else if (action === 'hide-navigation') app.viewsManager?.close();
          else {
            const controls = { highlight: 'editorHighlightButton', text: 'editorFreeTextButton', ink: 'editorInkButton', select: 'editorNoneButton', tools: 'secondaryToolbarToggleButton' };
            const control = document.getElementById(controls[action]);
            if (!control) throw Error('此工具暂不可用');
            control.click();
          }
          publish(); reply(state());
        } else if (message.type === 'restore') {
          await app.pdfViewer.firstPagePromise;
          if (!app.isInitialViewSet) await new Promise((resolve, reject) => {
            const initialized = () => { clearTimeout(timer); app.eventBus.off('documentinit', initialized); resolve(); };
            const timer = setTimeout(() => { app.eventBus.off('documentinit', initialized); reject(Error('阅读器初始视图尚未就绪')); }, 10000);
            app.eventBus.on('documentinit', initialized);
          });
          if (message.documentId !== documentId) return;
          const page = Number(message.page);
          if (!Number.isSafeInteger(page) || page < 1 || page > activeDocument.numPages) throw Error('恢复页码无效');
          const zoom = String(message.zoom);
          if (['auto','page-fit','page-width','page-actual'].includes(zoom) || /^\d+(\.\d+)?$/.test(zoom) && Number(zoom) >= 0.1 && Number(zoom) <= 10) app.pdfViewer.currentScaleValue = zoom;
          app.pdfViewer.currentPageNumber = page; publish(); reply(state());
        } else if (message.type === 'comment-selection') {
          const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
          if (!manager?.hasCommentManager()) throw Error('当前文档的注释工具尚未准备好');
          const current = window.getSelection();
          if (!current?.anchorNode || current.isCollapsed || !document.getElementById('viewer').contains(current.anchorNode)) throw Error('请先在 PDF 中选中要注释的文字');
          manager.commentSelection('pdfreader_toolbar');
          reply(true);
        } else if (message.type === 'show-comments') {
          app.eventBus.dispatch('switchannotationeditormode', { source: app, mode: 16 });
          reply(true);
        } else if (message.type === 'flush') reply(flush());
        else if (message.type === 'export') {
          exporting = true;
          try {
            flush();
            const snapshot = ledger.snapshot(), pdf = activeDocument;
            const bytes = await (pdf.annotationStorage.size ? pdf.saveDocument() : pdf.getData());
            if (message.documentId !== documentId || pdf !== activeDocument) return;
            snapshots.clear(); snapshots.set(message.requestId, snapshot);
            // Serialization is not a successful export. Only 'exported' may
            // acknowledge the persisted snapshot; failures leave the ledger dirty.
            observe(); publish();
            reply({ bytes, token: message.requestId }, [bytes.buffer]);
          } finally { exporting = false; }
        } else if (message.type === 'exported') {
          const snapshot = snapshots.get(message.token);
          if (!snapshot) throw Error('导出确认已过期');
          flush(); ledger.acknowledge(snapshot); snapshots.delete(message.token);
          publish(); reply(state());
        }
      }
    } catch (error) {
      if (message.documentId !== documentId) return;
      parent.postMessage({ channel: 'pdfreader', documentId: message.documentId, type: 'reply', requestId: message.requestId,
        error: `阅读器操作失败：${error.message}` }, location.origin);
    }
  });
});
// Route shell shortcuts from inside the embedded Viewer, including editing focus.
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && (['w','tab'].includes(event.key.toLowerCase()) || /^[1-9]$/.test(event.key))) {
    event.preventDefault(); event.stopImmediatePropagation();
    parent.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, ctrlKey: true, shiftKey: event.shiftKey })); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'Enter') {
    if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true]')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true }));
    return;
  }
  if ((event.ctrlKey || event.metaKey) && ['o', 's'].includes(event.key.toLowerCase())) {
    event.preventDefault(); event.stopImmediatePropagation();
    parent.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, ctrlKey: true }));
  }
}, true);
post({ type: 'ready' });
