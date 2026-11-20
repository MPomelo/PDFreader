// Apply after patch-pdfjs-notes.mjs to the pinned PDF.js 6.5.438 build.
import { readFileSync, writeFileSync } from 'node:fs';

const marker = '// PDFreader text markup patch';
function patch(path, replacements) {
  let source = readFileSync(path, 'utf8');
  if (!source.includes('pdfjsVersion = 6.5.438')) throw Error(`Unexpected PDF.js version: ${path}`);
  if (source.includes(marker)) return;
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw Error(`Patch context mismatch in ${path}: ${before.slice(0, 120)}`);
    source = source.replace(before, after);
  }
  writeFileSync(path, source + '\n' + marker + '\n');
}

patch('public/pdfjs/build/pdf.mjs', [
  ['if (currentLayer.hasTextLayer(textLayer)) {', 'if (currentLayer?.hasTextLayer(textLayer)) {'],
  [`    if (this.#mode !== AnnotationEditorType.NONE && !this.isEditorHandlingKeyboard) {
      AnnotationEditorUIManager._keyboardManager.exec(this, event);
    }
  }
  keyup(event) {`, `    if (this.isEditorHandlingKeyboard) return;
    if (this.#mode !== AnnotationEditorType.NONE) {
      AnnotationEditorUIManager._keyboardManager.exec(this, event);
      return;
    }
    // One-shot text markup keeps the selection tool active.
    if (!(event.ctrlKey || event.metaKey) || event.altKey ||
        !this.#container.contains(event.target) || event.target.closest?.("input, textarea, [contenteditable=true]")) return;
    const key = event.key.toLowerCase();
    const action = key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" ? "redo" : "";
    if (!action || !(action === "undo" ? this.#commandManager.hasSomethingToUndo() : this.#commandManager.hasSomethingToRedo())) return;
    this[action]();
    event.preventDefault();
  }
  keyup(event) {`],
  ['  highlightSelection(methodOfCreation = "", comment = false) {', `  addSelectionMarkup(markup, methodOfCreation) {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || this.#mode === AnnotationEditorType.DISABLE) return false;
    const ranges = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
    const targets = [];
    for (const textLayer of this.#viewer.querySelectorAll(".textLayer")) {
      const clipped = [];
      for (const range of ranges) {
        if (!range.intersectsNode(textLayer)) continue;
        // Text nodes avoid duplicate span bounds and the selection sentinel at the page boundary.
        const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!range.intersectsNode(node)) continue;
          const part = document.createRange();
          const start = range.startContainer === node ? range.startOffset : 0;
          const end = range.endContainer === node ? range.endOffset : node.length;
          part.setStart(node, start);
          part.setEnd(node, end);
          if (part.toString().trim()) clipped.push(part);
        }
      }
      if (!clipped.length) continue;
      const layer = this.#getLayerForTextLayer(textLayer);
      const boxes = this.getSelectionBoxes(textLayer, clipped);
      if (!layer || !boxes?.length) return false;
      targets.push({ layer, boxes, text: clipped.map(part => part.toString()).join(" ") });
    }
    if (!targets.length) return false;
    selection.removeAllRanges();
    this.#floatingToolbar?.hide();
    this.unselectAll();
    const editors = targets.map(({ layer, ...data }) => layer.addSelectionMarkup({ ...data, markup, methodOfCreation }));
    this.addCommands({
      cmd: () => editors.forEach(editor => this.rebuild(editor)),
      undo: () => editors.forEach(editor => editor.remove()),
      mustExec: false,
    });
    return true;
  }
  highlightSelection(methodOfCreation = "", comment = false) {`],
  [`  getSelectionBoxes(textLayer) {
    if (!textLayer) {
      return null;
    }
    const selection = document.getSelection();
    for (let i = 0, ii = selection.rangeCount; i < ii; i++) {
      if (!textLayer.contains(selection.getRangeAt(i).commonAncestorContainer)) {
        return null;
      }
    }`, `  getSelectionBoxes(textLayer, ranges) {
    if (!textLayer) return null;
    if (!ranges) {
      const selection = document.getSelection();
      ranges = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i));
    }
    if (ranges.some(range => !textLayer.contains(range.commonAncestorContainer))) return null;`],
  [`    const boxes = [];
    for (let i = 0, ii = selection.rangeCount; i < ii; i++) {
      const range = selection.getRangeAt(i);`, `    const boxes = [];
    for (const range of ranges) {`],
  [`  static build(boxes, isLTR) {
    const outline = new HighlightOutliner(boxes, 0.001).getOutlines();`, `  static build(boxes, isLTR, markup) {
    // Draw on the selected line while keeping the full text quads for PDF export.
    const marks = markup ? boxes.map(({ x, y, width, height }) => {
      const thickness = Math.min(height * 0.16, 0.002);
      const offset = markup === "underline" ? height - thickness : (height - thickness) / 2;
      return { x, y: y + offset, width, height: thickness };
    }) : boxes;
    const outline = new HighlightOutliner(marks, markup ? 0 : 0.001).getOutlines();`],
  ['class HighlightEditor extends DrawingEditor {', `class HighlightEditor extends DrawingEditor {
  #markup;
  #groupedUndo;`],
  ['    this.#text = params.text || "";', `    this.#text = params.text || "";
    this.#markup = params.markup;
    this.#groupedUndo = params.groupedUndo;`],
  ['    this._drawingOptions ||= params.drawingOptions || HighlightEditor.getDefaultDrawingOptions();', `    this._drawingOptions ||= params.drawingOptions || HighlightEditor.getDefaultDrawingOptions(
      params.markup ? { fill: params.markup === "underline" ? "#1463a3" : "#b42331" } : undefined
    );`],
  ['        drawOutlines: HighlightOutline.build(boxes, this._uiManager.direction === "ltr")', '        drawOutlines: HighlightOutline.build(boxes, this._uiManager.direction === "ltr", params.markup)'],
  [`  onceAdded(focus) {
    if (!this.annotationElementId) {
      this.parent.addUndoableEditor(this);
    }
    if (focus) {
      this.div.focus();
    }
  }
  remove() {`, `  onceAdded(focus) {
    if (!this.annotationElementId && !this.#groupedUndo) {
      this.parent.addUndoableEditor(this);
    }
    if (focus && !this.#groupedUndo) {
      this.div.focus();
    }
  }
  remove() {`],
  ['      return HighlightOutline.build(boxes, uiManager.direction === "ltr");', '      return HighlightOutline.build(boxes, uiManager.direction === "ltr", data.markup);'],
  ['    if (data instanceof HighlightAnnotationElement) {', '    if (data instanceof HighlightAnnotationElement || data instanceof UnderlineAnnotationElement || data instanceof StrikeOutAnnotationElement) {'],
  [`        annotationType: AnnotationEditorType.HIGHLIGHT,
        color: Array.from(color),
        opacity,
        quadPoints,`, `        annotationType: AnnotationEditorType.HIGHLIGHT,
        markup: data instanceof UnderlineAnnotationElement ? "underline" : data instanceof StrikeOutAnnotationElement ? "strikeout" : undefined,
        color: Array.from(color || [0, 0, 0]),
        opacity,
        quadPoints,`],
  [`    const editor = await super.deserialize(data, parent, uiManager);
    editor._initialData = initialData;
    if (data.comment) {
      editor.setCommentData(data);
    }
    return editor;
  }
  serialize(isForCopying = false) {
    if (this.isEmpty() || isForCopying) {`, `    const editor = await super.deserialize(data, parent, uiManager);
    editor.#markup = data.markup;
    editor._initialData = initialData;
    if (data.comment) {
      editor.setCommentData(data);
    }
    return editor;
  }
  serialize(isForCopying = false) {
    if (this.isEmpty() || isForCopying) {`],
  [`      outlines: this._drawOutlines.serialize(serialized.rect, this._drawRotation)
    });
    this.addComment(serialized);`, `      outlines: this._drawOutlines.serialize(serialized.rect, this._drawRotation)
    });
    if (this.#markup) {
      serialized.markup = this.#markup;
      // The appearance is a thin line but the annotation rectangle encloses all selected text.
      const rect = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < serialized.quadPoints.length; i += 2) {
        const x = serialized.quadPoints[i], y = serialized.quadPoints[i + 1];
        rect[0] = Math.min(rect[0], x);
        rect[1] = Math.min(rect[1], y);
        rect[2] = Math.max(rect[2], x);
        rect[3] = Math.max(rect[3], y);
      }
      serialized.rect = rect;
    }
    this.addComment(serialized);`],
  ['  createAndAddNewEditor(event, isCentered, data = {}) {', `  addSelectionMarkup(data) {
    const editor = new HighlightEditor({
      parent: this, id: this.#uiManager.getId(), x: 0, y: 0,
      uiManager: this.#uiManager, groupedUndo: true, ...data,
    });
    this.add(editor);
    return editor;
  }
  createAndAddNewEditor(event, isCentered, data = {}) {`],
  ['    this.container.classList.add("underlineAnnotation");', '    this.container.classList.add("underlineAnnotation");\n    if (this.data.isEditable) this._editOnDoubleClick();'],
  ['    this.container.classList.add("strikeoutAnnotation");', '    this.container.classList.add("strikeoutAnnotation");\n    if (this.data.isEditable) this._editOnDoubleClick();'],
  ...['UnderlineAnnotationElement', 'StrikeOutAnnotationElement'].map(name => {
    const block = `class ${name} extends AnnotationElement {
  constructor(parameters) {
    super(parameters, {
      isRenderable: true,
      ignoreBorder: true,
      createQuadrilaterals: true
    });`;
    return [block, block + '\n    this.annotationEditorType = AnnotationEditorType.HIGHLIGHT;'];
  }),
]);

patch('public/pdfjs/build/pdf.worker.mjs', [
  ['    highlight.setIfNotExists("Subtype", Name.get("Highlight"));', `    const subtype = annotation.markup === "underline" ? "Underline" : annotation.markup === "strikeout" ? "StrikeOut" : "Highlight";
    highlight.setIfNotExists("Subtype", Name.get(subtype));`],
  ...['UnderlineAnnotation', 'StrikeOutAnnotation'].map(name => {
    const block = `class ${name} extends MarkupAnnotation {
  constructor(params) {
    super(params);
    const {
      dict,
      xref
    } = params;
    const quadPoints = this.data.quadPoints = getQuadPoints(dict, null);`;
    return [block, block + '\n    this.data.isEditable = !!quadPoints && !this.data.noHTML;\n    this.data.opacity = dict.get("CA") ?? 1;'];
  }),
]);
