import { AnnotationEditorType, AnnotationType } from '../build/pdf.mjs';

const pdfKinds = new Map([
  [AnnotationType.TEXT, 'comment'], [AnnotationType.HIGHLIGHT, 'highlight'],
  [AnnotationType.UNDERLINE, 'underline'], [AnnotationType.STRIKEOUT, 'strikeout'],
  [AnnotationType.FREETEXT, 'freetext'], [AnnotationType.INK, 'ink'],
]);
const kinds = new Set(pdfKinds.values());
const immutableFlags = 0x40 | 0x80 | 0x200; // ReadOnly, Locked, LockedContents
const excerpt = value => (value || '').replace(/\s+/g, ' ').trim().slice(0, 400);

function originalEntry(data) {
  const kind = pdfKinds.get(data.annotationType);
  const editable = !!data.isEditable && !(data.annotationFlags & immutableFlags) && (kind === 'freetext' || kind === 'comment' && !!data.pdfreaderAnchor);
  return {
    id: data.id, page: data.pageIndex + 1, rect: data.rect, kind, editable,
    quote: excerpt(data.pdfreaderAnchor?.text), text: excerpt(data.contentsObj?.str || data.textContent?.join(' ')),
    width: data.pdfreaderTextBox ? Math.round(data.rotation % 180 ? data.rect[3] - data.rect[1] : data.rect[2] - data.rect[0]) : undefined,
  };
}

export function createAnnotationWorkspace(app, post, getPdf, onChange) {
  const manager = () => app.pdfViewer._layerProperties.annotationEditorUIManager;
  let originals, draft, listening = false, saved = new Map(), lastPayload = '';
  let renderTimer;
  const current = () => manager()?.pdfreaderEditors() || [];
  const editorEntry = (editor, changes) => {
    const { pageIndex, uid: id, editorType, annotationElementId } = editor;
    const kind = editor.pdfreaderMarkup || editorType;
    const quote = editor.pdfreaderQuote || (editorType === 'highlight' ? editor.pdfreaderText : '');
    const text = editorType === 'highlight' ? editor.comment?.text : editor.pdfreaderText;
    const editable = !annotationElementId || kind === 'comment' || kind === 'freetext';
    const data = editor.getPDFRect();
    return {
      id, page: pageIndex + 1, rect: data, kind, editable, quote: excerpt(quote), text: excerpt(text),
      width: editor.pdfreaderBoxWidth ? Math.round(editor.pdfreaderBoxWidth) : undefined,
      changed: changes.has(id) || typeof editor.pdfreaderGroup === 'symbol' && changes.has(editor.pdfreaderGroup),
    };
  };
  function snapshot() {
    const edits = new Map();
    for (const editor of current()) {
      const data = editor.serialize();
      if (data) edits.set(editor.uid, JSON.stringify(data));
    }
    for (const [id, editor] of getPdf()?.annotationStorage || []) {
      if (editor.deleted && !edits.has(editor.annotationElementId || id)) {
        edits.set(editor.annotationElementId || id, 'deleted');
      }
    }
    return edits;
  }
  async function loadOriginals() {
    const pdf = getPdf();
    originals ??= pdf.getAnnotationsByType(new Set(pdfKinds.keys())).then(items => items || []).catch(error => {
      if (pdf === getPdf()) originals = null;
      throw error;
    });
    return originals;
  }
  async function publish() {
    const pdf = getPdf();
    if (!listening || !pdf) return;
    const imported = draft ? [] : await loadOriginals();
    if (pdf !== getPdf() || !listening) return;
    const ui = manager(), edits = snapshot(), editors = current();
    const changed = new Set([...saved.keys(), ...edits.keys()].filter(id => edits.get(id) !== saved.get(id)));
    const groups = new Map();
    const entries = new Map(imported.filter(data => !ui?.isDeletedAnnotationElement(data.id) && edits.get(data.id) !== 'deleted')
      .map(data => [data.id, { ...originalEntry(data), changed: changed.has(data.id) }]));
    for (const editor of editors) {
      if (!kinds.has(editor.pdfreaderMarkup || editor.editorType)) continue;
      const item = editorEntry(editor, changed);
      if (editor.pdfreaderGroup) {
        const first = groups.get(editor.pdfreaderGroup);
        if (first) {
          first.lastPage = Math.max(first.lastPage || first.page, item.page);
          first.changed ||= item.changed;
          if (item.page < first.page) {
            Object.assign(first, { page: item.page, rect: item.rect, id: item.id });
          }
          continue;
        }
        groups.set(editor.pdfreaderGroup, item);
      }
      entries.set(item.id, item);
    }
    const payload = {
      entries: [...entries.values()].sort((a, b) => a.page - b.page || (b.rect?.[3] || 0) - (a.rect?.[3] || 0)),
      undo: ui?.pdfreaderHistory().undo || false, redo: ui?.pdfreaderHistory().redo || false,
      deleted: [...changed].filter(id => edits.get(id) === 'deleted' || !edits.has(id) && !entries.has(id)).length,
      draft: draft?.description || null,
    };
    const json = JSON.stringify(payload);
    if (lastPayload === json) return;
    lastPayload = json;
    post({ type: 'annotations', workspace: payload });
  }
  function schedule() {
    if (!listening) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => void publish().catch(error => post({ type: 'error', message: error.message })), 30);
  }
  function show() {
    listening = true;
    post({ type: 'annotations-open' });
    schedule();
  }
  function begin({ pageIndex, anchor, editor, imported, readOnly = false }) {
    show();
    if (draft) return;
    const value = editor?.comment?.text || imported?.contentsObj?.str || '';
    const quote = anchor?.text || editor?.pdfreaderQuote || imported?.pdfreaderAnchor?.text;
    draft = {
      editor, imported, anchor,
      description: { id: crypto.randomUUID(), page: pageIndex + 1, quote: excerpt(quote), value, existing: !!(editor || imported), readOnly },
    };
    schedule();
  }
  function prepare() {
    const ui = manager();
    if (ui) ui.pdfreaderOpenNote = data => begin(data);
    return ui;
  }
  function jump(page, rect) {
    const pageView = app.pdfViewer.getPageView(page - 1);
    if (!pageView) return;
    if (!rect?.every(Number.isFinite)) {
      app.pdfViewer.currentPageNumber = page;
      return;
    }
    app.pdfViewer.scrollPageIntoView({
      pageNumber: page, destArray: [null, { name: 'XYZ' }, null, rect[3] + 32, null],
    });
    const { viewport, div } = pageView;
    const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
    const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
    const focus = document.createElement('div');
    focus.className = 'pdfreader-annotation-location';
    focus.style.left = Math.min(x1, x2) / viewport.width * 100 + '%';
    focus.style.top = Math.min(y1, y2) / viewport.height * 100 + '%';
    focus.style.width = Math.abs(x2 - x1) / viewport.width * 100 + '%';
    focus.style.height = Math.abs(y2 - y1) / viewport.height * 100 + '%';
    div.append(focus);
    setTimeout(() => focus.remove(), 1400);
  }
  function waitForPage(page, condition) {
    if (condition()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const names = ['annotationlayerrendered', 'annotationeditorlayerrendered', 'editorsrendered', 'annotationeditormodechanged', 'pagerendered'];
      const finish = error => {
        clearTimeout(timer);
        for (const name of names) app.eventBus.off(name, check);
        error ? reject(error) : resolve();
      };
      const check = event => {
        if (event.pageNumber && event.pageNumber !== page) return;
        if (condition()) finish();
      };
      const timer = setTimeout(() => finish(Error('批注所在页面尚未加载，请稍后重试。')), 6000);
      for (const name of names) app.eventBus.on(name, check);
    });
  }
  function enterTextMode() {
    const mode = AnnotationEditorType.FREETEXT;
    if (app.pdfViewer.annotationEditorMode === mode) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        app.eventBus.off('annotationeditormodechanged', changed);
        error ? reject(error) : resolve();
      };
      const changed = event => { if (event.mode === mode) finish(); };
      const timer = setTimeout(() => finish(Error('无法打开文本框编辑模式。')), 6000);
      app.eventBus.on('annotationeditormodechanged', changed);
      app.eventBus.dispatch('switchannotationeditormode', { source: app, mode });
    });
  }
  async function findEditor(id, data) {
    const ui = prepare();
    const existing = current().find(editor => editor.uid === id);
    if (existing) return existing;
    if (!data || !originalEntry(data).editable || !ui) throw Error('当前批注无法编辑。');
    jump(data.pageIndex + 1, data.rect);
    await waitForPage(data.pageIndex + 1, () => ui.getLayer(data.pageIndex)?.getEditableAnnotation(id));
    const editor = await ui.pdfreaderImportEditor(data.pageIndex, id);
    if (!editor) throw Error('当前批注无法编辑。');
    return editor;
  }
  async function finishNote(id, value) {
    if (!draft || draft.description.id !== id) throw Error('注释编辑已结束。');
    if (value !== null && !draft.description.readOnly) {
      const text = String(value).trim();
      if (!text) throw Error('请输入注释内容。');
      if (text !== draft.description.value) {
        const { editor, imported, anchor, description: { page } } = draft;
        const ui = prepare();
        if (editor || imported) {
          const target = editor || await findEditor(imported.id, imported);
          const previous = target.comment;
          ui.addCommands({
            cmd: () => { target.comment = text; target.addToAnnotationStorage(); },
            undo: () => { target.comment = previous; target.addToAnnotationStorage(); },
            mustExec: true,
          });
        } else {
          if (!ui.getLayer(page - 1)) {
            jump(page);
            await waitForPage(page, () => ui.getLayer(page - 1));
          }
          if (!ui.pdfreaderCreateNote(page - 1, anchor, text)) throw Error('无法在此页保存注释。');
        }
      }
    }
    draft = null;
    onChange();
    schedule();
    return true;
  }
  async function act(action, id, value) {
    const ui = prepare();
    if (!ui) throw Error('当前文档的批注工具尚未准备好。');
    ui.endCurrentEditing();
    const editor = current().find(editor => editor.uid === id);
    const original = editor ? null : (await loadOriginals()).find(data => data.id === id);
    const entry = editor ? editorEntry(editor, new Set()) : original && originalEntry(original);
    if (!entry) throw Error('该批注已不存在。');
    if (action === 'locate') {
      jump(entry.page, entry.rect);
      return true;
    }
    if (!entry.editable || draft) throw Error('请先完成当前注释编辑。');
    if (entry.kind === 'freetext' && (action === 'edit' || action === 'resize')) {
      jump(entry.page, entry.rect);
      await enterTextMode();
      const target = await findEditor(id, original);
      if (!target.isAttachedToDOM) {
        await waitForPage(entry.page, () => target.isAttachedToDOM);
      }
      if (action === 'edit') {
        ui.setSelected(target);
        target.enterInEditMode();
      } else {
        const width = Math.round(Number(value));
        const max = target.pageDimensions[target.rotation % 180 ? 1 : 0];
        if (!Number.isFinite(width) || width < 12 || width > max) throw Error('文本框宽度须介于 12 和页面宽度之间。');
        target.pdfreaderResize(width);
      }
    } else {
      const target = await findEditor(id, original);
      if (action === 'delete') ui.pdfreaderDeleteEditors([target]);
      else if (action === 'edit' && entry.kind === 'comment') begin({ pageIndex: target.pageIndex, editor: target });
    }
    onChange();
    schedule();
    return true;
  }
  function openComment(editor) {
    if (editor.pdfreaderEntry) {
      const data = editor.pdfreaderEntry;
      begin({ pageIndex: data.pageIndex, imported: data, readOnly: !originalEntry(data).editable });
    } else if (editor.editorType === 'comment') {
      begin({ pageIndex: editor.pageIndex, editor });
    } else show();
  }
  return {
    show, prepare, act, finishNote, openComment, schedule, snapshot,
    acknowledge(annotations) { saved = annotations; schedule(); },
    reset() {
      clearTimeout(renderTimer);
      originals = draft = null;
      listening = false;
      saved = new Map();
      lastPayload = '';
    },
  };
}
