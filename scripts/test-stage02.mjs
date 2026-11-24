import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { ExportState } from '../public/pdfjs/web/export-state.mjs';
import { expandLigatures, normalizeSelectionText } from '../public/pdfjs/web/selection-text.mjs';
import { configureViewer } from '../public/pdfjs/web/viewer-entry.mjs';
import { hasCommentDraft, commitCommentDraft } from '../public/pdfjs/web/comment-tools.mjs';
import { mayLeaveDocument } from '../src/reader/leave-document.ts';

// The pinned generic browser build uses newer standard methods than Node 24.
// Compatibility shims are test-only; the shipped Viewer is not changed.
Uint8Array.prototype.toHex ||= function () { return Buffer.from(this).toString('hex'); };
Map.prototype.getOrInsertComputed ||= function (key, callback) { if (!this.has(key)) this.set(key, callback(key)); return this.get(key); };
Map.prototype.getOrInsert ||= function (key, value) { if (!this.has(key)) this.set(key, value); return this.get(key); };
WeakMap.prototype.getOrInsertComputed ||= function (key, callback) { if (!this.has(key)) this.set(key, callback(key)); return this.get(key); };
Math.sumPrecise ||= function (values) {
  let sum = 0, correction = 0;
  for (const value of values) { const next = sum + value; correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum; sum = next; }
  return sum + correction;
};
const { getDocument } = await import('../public/pdfjs/build/pdf.mjs');
mkdirSync(resolve('.local'), { recursive: true });
execFileSync('python', [resolve('scripts/stage02-fixtures.py')], { stdio: 'pipe' });
const root = resolve('test-results/stage02');
const fontUrl = resolve('public/pdfjs/web/standard_fonts').replaceAll('\\', '/') + '/';
const load = name => getDocument({ data: new Uint8Array(readFileSync(resolve(root, name))), standardFontDataUrl: fontUrl });

test('actual selection-note entry uses comment mode and never arms or creates a highlight', () => {
  const source = readFileSync('public/pdfjs/build/pdf.mjs', 'utf8');
  const body = source.split('  commentSelection(methodOfCreation = "", group = null) {')[1]
    .split('\n  endCurrentEditing() {')[0].replace(/\n  }\s*$/, '')
    .replaceAll('this.#getAnchorElementForSelection', 'this.getAnchorElementForSelection')
    .replaceAll('this.#getLayerForTextLayer', 'this.getLayerForTextLayer');
  const notes = [], callbacks = new Map(), modes = [];
  const selection = { isCollapsed: false, toString: () => 'selected words', removeAllRanges() {} };
  const layer = { add(editor) { notes.push(editor); } };
  class Note { constructor(params) { this.anchor = params.anchor; } editComment() { this.opened = true; } }
  const invoke = new Function('document', 'NoteEditor', 'AnnotationEditorType', 'internalOpt', 'group = null', body);
  let mode = 0;
  const manager = { getAnchorElementForSelection: () => ({ closest: () => ({}) }),
    getLayerForTextLayer: () => layer, getLayer: index => index === 1 ? layer : null,
    getSelectionBoxes: () => [{ x: 0.1, y: 0.1, width: 0.5 }],
    getId: () => 'note', getMode: () => mode,
    _eventBus: { on: (name, callback) => callbacks.set(name, callback),
      dispatch(name, event) {
        assert.equal(name, 'switchannotationeditormode');
        mode = event.mode; modes.push(mode);
        callbacks.get('annotationeditormodechanged')();
      } } };
  for (const initialMode of [0, 16, 9]) {
    mode = initialMode;
    invoke.call(manager, { getSelection: () => selection }, Note, { POPUP: 16 }, {});
  }
  assert.deepEqual(modes, [16, 16]);
  assert.equal(notes.length, 3, 'supports consecutive notes and switching from highlight mode');
  assert.ok(notes.every(note => note.opened && note.anchor.text === 'selected words'));
  assert.equal(invoke.call(manager, { getSelection: () => null }, Note, { POPUP: 16 }, {},
    { page: 2, text: 'Precisely selected words', boxes: [{ x: 0.25, y: 0.45, width: 0.4 }] }), true);
  assert.deepEqual(notes.at(-1).anchor, { x: 0.25, y: 0.45, width: 0.4, text: 'Precisely selected words' });
});

test('standalone note lifecycle and real PDF save/reopen stay independent of highlights', async () => {
  // Expose the real pinned base class in a transient test module, without
  // changing the product's exports. Only DOM/storage endpoints are substituted.
  const path = resolve('.local/note-test-internals.mjs');
  const noteUrl = pathToFileURL(resolve('public/pdfjs/web/note-editor.mjs')).href;
  const source = readFileSync('public/pdfjs/build/pdf.mjs', 'utf8')
    .replace('"../web/note-editor.mjs"', JSON.stringify(noteUrl));
  writeFileSync(path, source + '\nexport { NoteEditor };\n');
  let NoteEditor, noteGetDocument;
  try {
    const internals = await import(pathToFileURL(path).href);
    ({ NoteEditor, getDocument: noteGetDocument } = internals);
    internals.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve('public/pdfjs/build/pdf.worker.mjs')).href;
  }
  finally { unlinkSync(path); }
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const element = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, append() {}, remove() {} });
  globalThis.document = { createElement: element };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  const task = noteGetDocument({ data: new Uint8Array(readFileSync(resolve(root, 'reading.pdf'))) });
  try {
    const pdf = await task.promise;
    const ui = { viewParameters: { rotation: 0, realScale: 1 }, direction: 'ltr',
      hasCommentManager: () => true, isEditingMode: () => true,
      makeCommentColor: () => '#e5a400', getNonHCMColor: value => value,
      updateComment() {}, removeComment() {},
      addToAnnotationStorage(editor) { if (!editor.isEmpty()) pdf.annotationStorage.setValue(editor.id, editor); },
      getAndRemoveDataFromAnnotationStorage: () => null,
      getId: () => 'pdfjs_internal_editor_reopened_note' };
    const layer = { pageIndex: 0, viewport: { rotation: 0,
      rawDims: { pageWidth: 612, pageHeight: 792, pageX: 0, pageY: 0 } }, addUndoableEditor() {} };
    const note = new NoteEditor({ parent: layer, uiManager: ui,
      id: 'pdfjs_internal_editor_standalone_note', x: 0, y: 0,
      anchor: { x: 0.12, y: 0.1, width: 0.5, height: 0.02, text: 'Selected text 中文' } });
    note.div = element();
    assert.equal(note.serialize(), null, 'cancelled draft leaves no annotation');
    assert.equal(pdf.annotationStorage.size, 0);
    note.comment = '独立注释，文字不高亮。';
    const data = note.serialize();
    assert.equal(data.annotationType, 102);
    assert.equal(data.quadPoints, undefined, 'note has no highlight geometry');
    assert.equal(data.outlines, undefined, 'note has no highlight appearance');
    assert.equal(pdf.annotationStorage.size, 1);
    const saved = await pdf.saveDocument();
    writeFileSync(resolve(root, 'notes-export.pdf'), saved);
    const reopened = noteGetDocument({ data: new Uint8Array(saved), standardFontDataUrl: fontUrl });
    try {
      const output = await reopened.promise;
      const annotations = await (await output.getPage(1)).getAnnotations();
      assert.equal(annotations.filter(a => a.subtype === 'Highlight').length, 0);
      const text = annotations.find(a => a.subtype === 'Text');
      assert.equal(text.contentsObj.str, '独立注释，文字不高亮。');
      assert.equal(text.pdfreaderAnchor.text, 'Selected text 中文');
      assert.ok(text.popupRef);
      const restoredUi = { ...ui, addToAnnotationStorage(editor) { output.annotationStorage.setValue(editor.id, editor); } };
      const restored = await NoteEditor.deserialize({ data: text, parent: { page: { pageNumber: 1 } } }, layer, restoredUi);
      assert.equal(restored.serialize(), null, 'opening an unchanged note is clean');
      restored.div = element();
      restored.comment = '修改后的独立注释';
      assert.equal(restored.serialize().popup.contents, '修改后的独立注释');
      const edited = getDocument({ data: await output.saveDocument() });
      try {
        const editedAnnotations = await (await (await edited.promise).getPage(1)).getAnnotations();
        assert.equal(editedAnnotations.find(a => a.subtype === 'Text').contentsObj.str, '修改后的独立注释');
        assert.equal(editedAnnotations.filter(a => a.subtype === 'Highlight').length, 0);
      } finally { await edited.destroy(); }
      restored.comment = null;
      assert.equal(restored.serialize().deleted, true);
    } finally { await reopened.destroy(); }
    note.comment = null;
    assert.equal(note.serialize(), null, 'deleting a new note removes only that note');
    // Add a separate highlight and verify deleting the note does not remove it.
    pdf.annotationStorage.setValue('pdfjs_internal_editor_independent_highlight', {
      annotationType: 9, pageIndex: 0, rotation: 0, color: [255, 255, 0], opacity: 1,
      rect: [70, 700, 400, 740], quadPoints: [70, 740, 400, 740, 70, 700, 400, 700],
      outlines: [[70, 740, 400, 740, 400, 700, 70, 700]] });
    const highlightOnly = getDocument({ data: await pdf.saveDocument() });
    try {
      const annotations = await (await (await highlightOnly.promise).getPage(1)).getAnnotations();
      assert.equal(annotations.filter(a => a.subtype === 'Highlight').length, 1);
      assert.equal(annotations.filter(a => a.subtype === 'Text').length, 0);
    } finally { await highlightOnly.destroy(); }
    execFileSync('python', ['-c', 'from pypdf import PdfReader; import sys; a=[x.get_object() for x in PdfReader(sys.argv[1]).pages[0]["/Annots"]]; assert not any(x["/Subtype"]=="/Highlight" for x in a); note=next(x for x in a if x["/Subtype"]=="/Text"); p=note["/Popup"].get_object(); assert p["/Parent"].get_object()==note; assert getattr(p.get("/Open"), "value", False) is False', resolve(root, 'notes-export.pdf')], { stdio: 'pipe' });
  } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; await task.destroy(); }
});

test('serialization, cancelled writes, and failed writes never clear dirty state', () => {
  const state = new ExportState('original');
  state.observe('highlight');
  const snapshot = state.snapshot();
  assert.equal(state.dirty, true);
  // Generating data or resetting PDF.js storage is not a durable-save receipt.
  state.observe('highlight');
  assert.equal(state.dirty, true);
  state.acknowledge(snapshot);
  assert.equal(state.dirty, false);
  state.observe('text');
  assert.equal(state.dirty, true);
});
test('edits made after an exported snapshot remain dirty, including deleting all annotations', () => {
  const state = new ExportState(''); state.observe('highlight');
  const snapshot = state.snapshot(); state.observe('highlight+ink');
  state.acknowledge(snapshot); assert.equal(state.dirty, true);
  state.observe('highlight'); assert.equal(state.dirty, false);
  state.observe(''); assert.equal(state.dirty, true);
});
test('leave protection handles Save, Discard, Cancel, cancelled picker, and write failure', async () => {
  const flush = async () => ({ dirty: true });
  assert.equal(await mayLeaveDocument(flush, async () => 'cancel', async () => { throw Error('unexpected save'); }), false);
  assert.equal(await mayLeaveDocument(flush, async () => 'discard', async () => { throw Error('unexpected save'); }), true);
  assert.equal(await mayLeaveDocument(flush, async () => 'save', async () => false), false);
  assert.equal(await mayLeaveDocument(flush, async () => 'save', async () => true), true);
  await assert.rejects(mayLeaveDocument(flush, async () => 'save', async () => { throw Error('disk full'); }), /disk full/);
  assert.equal(await mayLeaveDocument(async () => ({ dirty: false }), async () => { throw Error('unexpected prompt'); }, async () => false), true);
});

test('comments are enabled at component construction after stored preferences', async () => {
  const values = new Map([['enableComment', false], ['enableHighlightFloatingButton', false], ['enableScripting', true]]);
  let constructed;
  const app = { async _initializeViewerComponents() { constructed = new Map(values); return 'ready'; } };
  configureViewer(app, { set: (key, value) => values.set(key, value) });
  // Simulate preferences completing after entry module registration.
  values.set('enableComment', false);
  assert.equal(await app._initializeViewerComponents(), 'ready');
  assert.equal(constructed.get('enableComment'), true);
  assert.equal(constructed.get('enableHighlightFloatingButton'), false);
  assert.equal(constructed.get('enableScripting'), false);
});

test('note drafts commit before leaving, unchanged dialogs close, and cancel does not create a draft', () => {
  const elements = new Map(); let saved = 0, cancelled = 0;
  const dialog = { open: true };
  const save = { disabled: false, click() { ++saved; dialog.open = false; } };
  const cancel = { click() { ++cancelled; dialog.open = false; } };
  elements.set('commentManagerDialog', dialog); elements.set('commentManagerSaveButton', save); elements.set('commentManagerCancelButton', cancel);
  const root = { getElementById: id => elements.get(id) };
  assert.equal(hasCommentDraft(root), true);
  commitCommentDraft(root); assert.equal(saved, 1); assert.equal(hasCommentDraft(root), false);
  dialog.open = true; save.disabled = true;
  assert.equal(hasCommentDraft(root), false);
  commitCommentDraft(root); assert.equal(cancelled, 1); assert.equal(saved, 1);
  commitCommentDraft(root); assert.equal(cancelled, 1);
});

test('pinned PDF.js reads text, outline/link destinations, rotated/scaled viewport, scan and no-outline inputs', async () => {
  const task = load('reading.pdf');
  try {
    const pdf = await task.promise, page = await pdf.getPage(1);
    assert.equal(pdf.numPages, 2);
    assert.match((await page.getTextContent()).items.map(item => item.str || '').join(' '), /search target/);
    const outline = await pdf.getOutline(); assert.equal(outline[0].title, 'Second page');
    assert.equal(await pdf.getPageIndex(outline[0].dest[0]), 1);
    const link = (await page.getAnnotations()).find(annotation => annotation.subtype === 'Link');
    assert.equal(Number.isInteger(link.dest[0]) ? link.dest[0] : await pdf.getPageIndex(link.dest[0]), 1);
    assert.equal(page.getViewport({ scale: 2, rotation: 90 }).width, 1584);
  } finally { await task.destroy(); }
  const scan = load('scanned.pdf');
  try { const pdf = await scan.promise; assert.equal((await (await pdf.getPage(1)).getTextContent()).items.length, 0); assert.equal(await pdf.getOutline(), null); }
  finally { await scan.destroy(); }
});

test('password-required, incorrect-password and correct-password inputs are distinguished', async () => {
  for (const [password, expected] of [[undefined, 1], ['incorrect', 2], ['stage02', null]]) {
    const task = getDocument({ data: new Uint8Array(readFileSync(resolve(root, 'password.pdf'))), ...(password ? { password } : {}) });
    try {
      if (expected) await assert.rejects(task.promise, error => error.name === 'PasswordException' && error.code === expected);
      else assert.equal((await task.promise).numPages, 2);
    } finally { await task.destroy(); }
  }
});

test('highlights, free text and ink save through PDF.js, reopen with appearances, and preserve original bytes', async () => {
  const original = readFileSync(resolve(root, 'reading.pdf'));
  const digest = createHash('sha256').update(original).digest('hex');
  const task = load('reading.pdf'); let saved;
  try {
    const pdf = await task.promise;
    const common = { pageIndex: 0, rotation: 0, user: 'PDFreader QA', opacity: 1 };
    pdf.annotationStorage.setValue('pdfjs_internal_editor_highlight', { ...common, annotationType: 9, color: [255, 255, 0],
      rect: [70, 700, 400, 740], quadPoints: [70, 740, 400, 740, 70, 700, 400, 700], outlines: [[70, 740, 400, 740, 400, 700, 70, 700]],
      popup: { contents: '这段文字讨论视频目标分割。Anchored comment.', deleted: false, rect: [613, 640, 793, 740] } });
    pdf.annotationStorage.setValue('pdfjs_internal_editor_text', { ...common, annotationType: 3, color: [0, 0, 200],
      rect: [72, 560, 380, 600], fontSize: 18, value: 'STAGE-02 exported free text' });
    pdf.annotationStorage.setValue('pdfjs_internal_editor_ink', { ...common, annotationType: 15, color: [200, 0, 0], thickness: 3,
      rect: [70, 490, 310, 540], paths: { points: [[72, 500, 180, 530, 300, 500]], lines: [[NaN, NaN, NaN, NaN, 72, 500, 100, 510, 140, 530, 180, 530, 210, 530, 260, 510, 300, 500]] } });
    saved = await pdf.saveDocument();
    writeFileSync(resolve(root, 'annotations-export.pdf'), saved);
  } finally { await task.destroy(); }
  const reopened = getDocument({ data: new Uint8Array(saved), standardFontDataUrl: fontUrl });
  try {
    const pdf = await reopened.promise;
    const annotations = await (await pdf.getPage(1)).getAnnotations();
    for (const subtype of ['Highlight', 'FreeText', 'Ink']) assert.ok(annotations.some(a => a.subtype === subtype && a.hasAppearance), `${subtype} has saved appearance`);
    assert.ok(annotations.find(a => a.subtype === 'FreeText').contentsObj.str.includes('exported free text'));
    const highlight = annotations.find(annotation => annotation.subtype === 'Highlight');
    assert.equal(highlight.contentsObj.str, '这段文字讨论视频目标分割。Anchored comment.');
    assert.ok(highlight.popupRef, 'anchored note has standard PDF Popup reference');
    assert.equal(pdf.numPages, 2);
  } finally { await reopened.destroy(); }
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'reading.pdf'))).digest('hex'), digest);
  // Independent renderer smoke: this is a real Poppler render, not a UI screenshot.
  execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '1200', '-png', resolve(root, 'annotations-export.pdf'), resolve(root, 'annotations-poppler')], { stdio: 'pipe' });
  execFileSync('python', ['-c', 'from PIL import Image; import sys; colors=Image.open(sys.argv[1]).convert("RGB").getdata(); red=sum(r>140 and g<80 and b<80 for r,g,b in colors); assert red>100, f"Ink did not render: {red} red pixels"', resolve(root, 'annotations-poppler.png')], { stdio: 'pipe' });
  execFileSync('python', ['-c', 'from pypdf import PdfReader; import sys; page=PdfReader(sys.argv[1]).pages[0]; note=next(a.get_object() for a in page["/Annots"] if a.get_object()["/Subtype"]=="/Highlight"); popup=note["/Popup"].get_object(); assert "视频目标分割" in note["/Contents"]; assert popup["/Subtype"]=="/Popup"; assert popup["/Parent"].get_object()==note; assert getattr(popup.get("/Open"), "value", False) is False', resolve(root, 'annotations-export.pdf')], { stdio: 'pipe' });
});

test('ReaderAdapter rejects obsolete operations and ignores stale/wrong-source document events', async () => {
  const compiled = ts.transpileModule(readFileSync('src/reader/ReaderAdapter.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { ReaderAdapter } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  const previousWindow = globalThis.window, previousLocation = globalThis.location;
  globalThis.window = new EventTarget(); globalThis.location = { origin: 'http://pdfreader.test' };
  const sent = [], received = [], source = { postMessage: message => sent.push(message) };
  const emit = (data, origin = location.origin, from = source) => { const event = new Event('message'); Object.assign(event, { data: { channel: 'pdfreader', ...data }, origin, source: from }); window.dispatchEvent(event); };
  const adapter = new ReaderAdapter({ contentWindow: source }, event => received.push(event));
  try {
    emit({ type: 'ready' });
    const first = adapter.open(new Uint8Array([1]), 'first.pdf'); await Promise.resolve();
    const open = sent.at(-1);
    emit({ type: 'reply', documentId: open.documentId, requestId: open.requestId, result: { documentId: open.documentId } }); await first;
    const oldFlush = adapter.flush(); await Promise.resolve();
    const rejected = assert.rejects(oldFlush, /文档已切换/);
    const next = adapter.open(new Uint8Array([2]), 'next.pdf'); await Promise.resolve();
    await rejected;
    const newOpen = sent.at(-1);
    emit({ type: 'state', documentId: open.documentId, state: { documentId: open.documentId, selection: 'stale', page: 99 } });
    emit({ type: 'state', documentId: newOpen.documentId, state: { documentId: newOpen.documentId } }, 'https://untrusted.test');
    emit({ type: 'state', documentId: newOpen.documentId, state: { documentId: newOpen.documentId } }, location.origin, {});
    assert.equal(received.length, 0);
    emit({ type: 'reply', documentId: newOpen.documentId, requestId: newOpen.requestId, result: { documentId: newOpen.documentId } }); await next;
    emit({ type: 'state', documentId: newOpen.documentId, state: { documentId: newOpen.documentId, selection: '', page: 1 } });
    assert.equal(received[0].state.selection, ''); assert.equal(received[0].state.page, 1);
  } finally { adapter.dispose(); globalThis.window = previousWindow; globalThis.location = previousLocation; }
});

test('actual bridge requires durable export acknowledgement and retains edits after serialization failure', async () => {
  const messages = [], handlers = new Map();
  const location = { origin: 'http://pdfreader.test' };
  const parent = { postMessage: message => messages.push(message) };
  const window = { addEventListener: (type, callback) => { if (type === 'message') handlers.set(type, callback); } };
  const textSize = { addEventListener() {} };
  const document = { addEventListener() {}, getElementById(id) { return id === 'editorFreeTextFontSize' ? textSize : null; } };
  let hash = '', failSave = false;
  const storage = { size: 1, get serializable() { return { hash }; }, onSetModified: null, onResetModified: null };
  const pdf = { numPages: 2, annotationStorage: storage, getOutline: async () => null,
    getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'text' }] }) }),
    saveDocument: async () => { storage.onResetModified?.(); if (failSave) throw Error('serialization failed'); return new TextEncoder().encode('%PDF-test'); },
  };
  const app = { initializedPromise: Promise.resolve(), eventBus: { on() {} }, pdfDocument: null,
    _initializeAnnotationStorageCallbacks() { storage.onSetModified = () => {}; storage.onResetModified = () => {}; },
    async open() { hash = ''; this.pdfDocument = pdf; this._initializeAnnotationStorageCallbacks(pdf); },
    pdfViewer: { currentPageNumber: 1, _layerProperties: { annotationEditorUIManager: { endCurrentEditing() {} } } },
  };
  const source = readFileSync('public/pdfjs/web/bridge.mjs', 'utf8').replace(/^import .*;\r?$/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const createSelectionMenu = () => ({ isOpen: false, close() {} });
  const createPreciseSelection = () => ({ current: null, setDocument() {} });
  const createLinkPreview = () => ({ reset() {}, close() {} });
  const { AnnotationEditorType } = await import('../public/pdfjs/build/pdf.mjs');
  await new AsyncFunction('app', 'options', 'AnnotationEditorType', 'expandLigatures', 'normalizeSelectionText', 'ExportState', 'hasCommentDraft', 'commitCommentDraft', 'createSelectionMenu', 'createPreciseSelection', 'createLinkPreview', 'window', 'document', 'parent', 'location', 'Element', source)(app, { set() {} }, AnnotationEditorType, expandLigatures, normalizeSelectionText, ExportState, hasCommentDraft, commitCommentDraft, createSelectionMenu, createPreciseSelection, createLinkPreview, window, document, parent, location, class {});
  const send = async (type, extra = {}) => {
    const requestId = crypto.randomUUID();
    handlers.get('message')({ source: parent, origin: location.origin, data: { channel: 'pdfreader', documentId: 'document-one', requestId, type, ...extra } });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const reply = messages.find(message => message.requestId === requestId && message.type === 'reply');
      if (reply) return reply;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw Error('Bridge reply did not arrive');
  };
  assert.equal((await send('open', { bytes: new Uint8Array(), filename: 'test.pdf' })).result.dirty, false);
  hash = 'highlight'; assert.equal((await send('flush')).result.dirty, true);
  const snapshot = await send('export'); assert.ok(snapshot.result.bytes.length);
  assert.equal((await send('flush')).result.dirty, true);
  assert.equal((await send('exported', { token: snapshot.result.token })).result.dirty, false);
  hash = 'highlight+text'; failSave = true;
  assert.match((await send('export')).error, /serialization failed/);
  assert.equal((await send('flush')).result.dirty, true);
  failSave = false;
  const older = await send('export'); hash = 'newer ink';
  assert.equal((await send('exported', { token: older.result.token })).result.dirty, true);
});
