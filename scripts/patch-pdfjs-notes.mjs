// Reproducible, version-pinned vendor patch. Retains upstream license headers.
// Run after replacing PDF.js with the original 6.5.438 distribution.
import { readFileSync, writeFileSync } from 'node:fs';
function patch(path, replacements) {
  let source = readFileSync(path, 'utf8');
  if (!source.includes('pdfjsVersion = 6.5.438')) throw Error(`Unexpected PDF.js version: ${path}`);
  if (source.includes('// PDFreader standalone notes patch')) return;
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw Error(`Patch context mismatch in ${path}: ${before.slice(0, 100)}`);
    source = source.replace(before, after);
  }
  writeFileSync(path, source + '\n// PDFreader standalone notes patch\n');
}
patch('public/pdfjs/build/pdf.mjs', [
  [';// ./src/shared/util.js', 'import { createNoteEditor } from "../web/note-editor.mjs";\n\n;// ./src/shared/util.js'],
  ['      freetext: "pdfjs-editor-remove-freetext-button",', '      comment: "pdfjs-editor-delete-comment-popup-button",\n      freetext: "pdfjs-editor-remove-freetext-button",'],
  ['const isNoneMode = this.#mode === AnnotationEditorType.NONE;', 'const isNoneMode = this.#mode !== AnnotationEditorType.HIGHLIGHT;'],
  ['if (this.#mode !== AnnotationEditorType.HIGHLIGHT && this.#mode !== AnnotationEditorType.NONE) {', 'if (![AnnotationEditorType.HIGHLIGHT, AnnotationEditorType.NONE, AnnotationEditorType.POPUP, AnnotationEditorType.COMMENT].includes(this.#mode)) {'],
  ['  commentSelection(methodOfCreation = "") {\n    this.highlightSelection(methodOfCreation, true);\n  }', `  commentSelection(methodOfCreation = "") {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return;
    const textLayer = this.#getAnchorElementForSelection(selection)?.closest(".textLayer");
    if (!textLayer) return;
    const boxes = this.getSelectionBoxes(textLayer);
    const layer = this.#getLayerForTextLayer(textLayer);
    if (!boxes?.length || !layer) return;
    const anchor = { ...boxes[0], text: selection.toString() };
    selection.removeAllRanges();
    const create = () => {
      const editor = new NoteEditor({ parent: layer, id: this.getId(),
        uiManager: this, x: 0, y: 0, anchor });
      layer.add(editor);
      editor.editComment();
    };
    // Comment mode preserves text selection and does not arm the highlighter.
    if (this.getMode() === AnnotationEditorType.POPUP) create();
    else {
      this._eventBus.on("annotationeditormodechanged", create, {
        once: true, signal: this._signal, ...internalOpt
      });
      this._eventBus.dispatch("switchannotationeditormode", {
        source: this, mode: AnnotationEditorType.POPUP
      });
    }
  }`],
  ['new Set(this.#editorTypes.map(editorClass => editorClass._editorType))', 'new Set([AnnotationType.TEXT, ...this.#editorTypes.map(editorClass => editorClass._editorType)])'],
  ['class FakeEditor extends AnnotationEditor {', 'const NoteEditor = createNoteEditor(AnnotationEditor);\n\nclass FakeEditor extends AnnotationEditor {'],
  ['class TextAnnotationElement extends AnnotationElement {', 'class TextAnnotationElement extends AnnotationElement {\n  get annotationEditorType() { return AnnotationEditorType.COMMENT; }'],
  ['      case AnnotationEditorType.HIGHLIGHT:\n        this.enableTextSelection();', '      case AnnotationEditorType.POPUP:\n      case AnnotationEditorType.COMMENT:\n      case AnnotationEditorType.HIGHLIGHT:\n        this.enableTextSelection();'],
  ['[FreeTextEditor, InkEditor, StampEditor, HighlightEditor, SignatureEditor].map', '[FreeTextEditor, InkEditor, StampEditor, HighlightEditor, SignatureEditor, NoteEditor].map'],
]);
patch('public/pdfjs/build/pdf.worker.mjs', [
  ['        case AnnotationEditorType.HIGHLIGHT:\n          if (annotation.quadPoints) {\n            promises.push(HighlightAnnotation.createNewAnnotation', '        case AnnotationEditorType.COMMENT:\n          promises.push(TextAnnotation.createNewAnnotation(xref, annotation, changes));\n          break;\n        case AnnotationEditorType.HIGHLIGHT:\n          if (annotation.quadPoints) {\n            promises.push(HighlightAnnotation.createNewAnnotation'],
  ['        case AnnotationEditorType.HIGHLIGHT:\n          if (annotation.quadPoints) {\n            promises.push(HighlightAnnotation.createNewPrintAnnotation', '        case AnnotationEditorType.COMMENT:\n          promises.push(TextAnnotation.createNewPrintAnnotation(annotationGlobals, xref, annotation, { evaluatorOptions: options }));\n          break;\n        case AnnotationEditorType.HIGHLIGHT:\n          if (annotation.quadPoints) {\n            promises.push(HighlightAnnotation.createNewPrintAnnotation'],
  ['class TextAnnotation extends MarkupAnnotation {', `class TextAnnotation extends MarkupAnnotation {
  static createNewDict(annotation, xref) {
    const note = annotation.oldAnnotation || new Dict(xref);
    note.setIfNotExists("Type", Name.get("Annot"));
    note.setIfNotExists("Subtype", Name.get("Text"));
    note.setIfName("Name", "Comment");
    note.setIfArray("Rect", annotation.rect);
    note.setIfArray("C", getPdfColorArray(annotation.color));
    note.setIfNotExists("F", 4);
    note.set("Open", false);
    note.set(annotation.oldAnnotation ? "M" : "CreationDate", \x60D:\x24{getModificationDate(annotation.date)}\x60);
    note.setIfDefined("T", stringToAsciiOrUTF16BE(annotation.user));
    if (annotation.anchor) {
      note.set("PDFreaderAnchor", stringToAsciiOrUTF16BE(JSON.stringify(annotation.anchor)));
    }
    return note;
  }
  static async createNewAppearanceStream() { return null; }
`],
  ['    const DEFAULT_ICON_SIZE = 22;\n    super(params);', '    const DEFAULT_ICON_SIZE = 22;\n    super(params);\n    this.data.isEditable = params.dict.has("PDFreaderAnchor");\n    try { this.data.pdfreaderAnchor = JSON.parse(stringToPDFString(params.dict.get("PDFreaderAnchor") || "null")); } catch { this.data.pdfreaderAnchor = null; }'],
]);
