// Apply after the notes and text markup patches to PDF.js 6.5.438.
import { readFileSync, writeFileSync } from 'node:fs';

const marker = '// PDFreader annotation workspace patch';
function patch(path, apply) {
  let source = readFileSync(path, 'utf8');
  if (!source.includes('pdfjsVersion = 6.5.438')) throw Error(`Unexpected PDF.js version: ${path}`);
  if (source.includes(marker)) return;
  apply((before, after) => {
    if (source.split(before).length !== 2) throw Error(`Patch context mismatch in ${path}: ${before.slice(0, 90)}`);
    source = source.replace(before, () => after);
  });
  writeFileSync(path, source + '\n' + marker + '\n');
}

patch('public/pdfjs/build/pdf.mjs', replace => {
  replace('import { createNoteEditor } from "../web/note-editor.mjs";', `import { createNoteEditor } from "../web/note-editor.mjs";
import { lineMarkupBoxes } from "../web/markup-appearance.mjs";
import { textBoxFont } from "../web/textbox-appearance.mjs";`);
  replace('    const anchor = { ...boxes[0], text };', `    const anchor = { ...boxes[0], text };
    if (this.pdfreaderOpenNote) {
      selection?.removeAllRanges();
      this.pdfreaderOpenNote({ pageIndex: layer.pageIndex, anchor });
      return true;
    }`);
  replace('    const editors = targets.map(({ layer, ...data }) => layer.addSelectionMarkup({ ...data, markup, methodOfCreation }));', `    const editors = targets.map(({ layer, ...data }) => layer.addSelectionMarkup({ ...data, markup, methodOfCreation }));
    if (editors.length > 1) {
      const group = Symbol("markup selection");
      for (const editor of editors) editor.pdfreaderGroup = group;
    }`);
  replace('  static build(boxes, isLTR, markup) {\n    // Draw on the selected line while keeping the full text quads for PDF export.\n    const marks = markup ? boxes.map(({ x, y, width, height }) => {\n      const thickness = Math.min(height * 0.16, 0.002);\n      const offset = markup === "underline" ? height - thickness : (height - thickness) / 2;\n      return { x, y: y + offset, width, height: thickness };\n    }) : boxes;', `  static build(boxes, isLTR, markup, pageDimensions) {
    const marks = markup ? lineMarkupBoxes(boxes, markup, pageDimensions) : boxes;`);
  replace('HighlightOutline.build(boxes, this._uiManager.direction === "ltr", params.markup)', 'HighlightOutline.build(boxes, this._uiManager.direction === "ltr", params.markup, this.pageDimensions)');
  replace('HighlightOutline.build(boxes, uiManager.direction === "ltr", data.markup)', 'HighlightOutline.build(boxes, uiManager.direction === "ltr", data.markup, [pageWidth, pageHeight])');
  replace('class HighlightEditor extends DrawingEditor {\n  #markup;', `class HighlightEditor extends DrawingEditor {
  #markup;
  get pdfreaderMarkup() { return this.#markup; }
  get pdfreaderText() { return this.#text; }`);
  replace('    if (this.isEditorHandlingKeyboard) return;', '    if (event.isComposing || event.keyCode === 229 || this.isEditorHandlingKeyboard) return;');
  replace('  *getEditors(pageIndex) {', `  pdfreaderEditors() {
    return Array.from(this.#allEditors.values()).filter(editor => !editor.deleted && !editor.isEmpty());
  }
  pdfreaderHistory() {
    return { undo: this.#commandManager.hasSomethingToUndo(), redo: this.#commandManager.hasSomethingToRedo() };
  }
  pdfreaderCreateNote(pageIndex, anchor, value) {
    const parent = this.getLayer(pageIndex);
    if (!parent) return null;
    const editor = new NoteEditor({ parent, id: this.getId(), uiManager: this, x: 0, y: 0, anchor, value });
    parent.add(editor);
    parent.div.hidden = false;
    return editor;
  }
  async pdfreaderImportEditor(pageIndex, id) {
    const layer = this.getLayer(pageIndex);
    if (!layer || this.isDeletedAnnotationElement(id)) return null;
    const existing = layer.getEditorByUID(id);
    if (existing) return existing;
    const editable = layer.getEditableAnnotation(id);
    if (!editable) return null;
    const editor = await layer.deserialize(editable);
    if (editor) layer.addOrRebuild(editor);
    return editor;
  }
  *getEditors(pageIndex) {`);
  replace('    const editors = drawingEditor ? [drawingEditor] : [...this.#selectedEditors];\n    const cmd = () => {', `    const editors = drawingEditor ? [drawingEditor] : [...this.#selectedEditors];
    this.pdfreaderDeleteEditors(editors);
  }
  pdfreaderDeleteEditors(editors) {
    const expanded = new Set(editors);
    const groups = new Set(editors.map(editor => editor.pdfreaderGroup).filter(Boolean));
    if (groups.size) {
      for (const editor of this.#allEditors.values()) {
        if (groups.has(editor.pdfreaderGroup)) expanded.add(editor);
      }
    }
    editors = [...expanded];
    if (!editors.length) return;
    const cmd = () => {`);
  replace('  get commentButtonColor() {\n    const {\n      color,\n      opacity\n    } = this.#firstElement.commentData;', `  get pdfreaderEntry() {
    const { data, parent } = this.#firstElement;
    return { ...data, pageIndex: parent.page.pageNumber - 1, contentsObj: { str: this.comment } };
  }
  get commentButtonColor() {
    const {
      color,
      opacity
    } = this.#firstElement.commentData;`);
  replace('  #content = "";\n  #editorDivId', `  #content = "";
  #boxWidth = 0;
  get pdfreaderText() { return this.#serializeContent(); }
  get pdfreaderBoxWidth() { return this.#boxWidth; }
  pdfreaderResize(width) {
    this.commit();
    const previous = this.#boxWidth;
    if (!previous || previous === width) return;
    const apply = width => {
      this.#boxWidth = width;
      this.#applyBoxWidth();
      this.#setEditorDimensions();
      this.addToAnnotationStorage();
    };
    this.addCommands({ cmd: () => apply(width), undo: () => apply(previous), mustExec: true });
  }
  #applyBoxWidth() {
    if (!this.#boxWidth) return;
    this.div.classList.add("pdfreader-text-box");
    this.div.style.width = \`calc(${'\$'}{this.#boxWidth}px * var(--total-scale-factor))\`;
    this.editorDiv.style.fontFamily = textBoxFont;
  }
  #editorDivId`);
  replace('    this.#fontSize = params.fontSize || FreeTextEditor._defaultFontSize;', `    this.#fontSize = params.fontSize || FreeTextEditor._defaultFontSize;
    this.#boxWidth = params.pdfreaderBoxWidth || 0;`);
  replace('    return [-FreeTextEditor._internalPadding * scale, -(FreeTextEditor._internalPadding + this.#fontSize) * scale];', `    if (this.#boxWidth) return [0, 0];
    return [-FreeTextEditor._internalPadding * scale, -(FreeTextEditor._internalPadding + this.#fontSize) * scale];`);
  replace('  getInitialTranslation() {\n    const scale = this.parentScale;\n    if (this.#boxWidth)', `  getBaseTranslation() {
    return this.#boxWidth ? [0, 0] : super.getBaseTranslation();
  }
  getInitialTranslation() {
    const scale = this.parentScale;
    if (this.#boxWidth)`);
  replace('    this.div.append(this.editorDiv);\n    this.overlayDiv', '    this.div.append(this.editorDiv);\n    this.#applyBoxWidth();\n    this.overlayDiv');
  replace('    const padding = FreeTextEditor._internalPadding * this.parentScale;', '    const padding = this.#boxWidth ? 0 : FreeTextEditor._internalPadding * this.parentScale;');
  replace('      if (!textContent?.length) {\n        return null;\n      }\n      initialData = data = {', `      if (!textContent?.length) {
        return null;
      }
      const pdfreaderBoxWidth = data.data.pdfreaderTextBox
        ? (rotation % 180 ? rect[3] - rect[1] : rect[2] - rect[0]) : 0;
      initialData = data = {`);
  replace('        value: textContent.join("\\n"),\n        position: textPosition,', '        value: textContent.join("\\n"),\n        pdfreaderBoxWidth,\n        position: textPosition,');
  replace('    editor.#fontSize = data.fontSize;', `    editor.#fontSize = data.fontSize;
    editor.#boxWidth = data.pdfreaderBoxWidth || 0;
    if (editor.#boxWidth && data.annotationElementId) {
      const [pageX, pageY] = editor.pageTranslation;
      const [pageWidth, pageHeight] = editor.pageDimensions;
      editor.x -= pageX / pageWidth;
      editor.y += pageY / pageHeight;
    }`);
  replace('      if (this.annotationElementId) {\n        const {\n          position\n        } = this._initialData;', `      if (this.annotationElementId && !this.#boxWidth) {
        const {
          position
        } = this._initialData;`);
  replace('      } else {\n        this._moveAfterPaste(baseX, baseY);\n      }\n      this.#setContent();', '      } else if (this._isCopy) {\n        this._moveAfterPaste(baseX, baseY);\n      }\n      this.#setContent();');
  replace('      value: this.#serializeContent()\n    });', '      value: this.#serializeContent(),\n      ...(this.#boxWidth ? { pdfreaderBoxWidth: this.#boxWidth } : null)\n    });');
  replace('return this.hasEditedComment || this._hasBeenMoved || serialized.value !== value', 'return this.hasEditedComment || this._hasBeenMoved || (serialized.pdfreaderBoxWidth || 0) !== this._initialData.pdfreaderBoxWidth || serialized.value !== value');
  replace('    this.createAndAddNewEditor(event, false);\n  }\n  pointerdown(event) {', `    const start = this.pdfreaderTextBoxStart;
    this.pdfreaderTextBoxStart = null;
    if (start && currentMode === AnnotationEditorType.FREETEXT) {
      const delta = event.clientX - start.clientX;
      const maxWidth = (start.bounds.right - Math.min(start.clientX, event.clientX)) / this.scale;
      const width = Math.max(12, Math.min(maxWidth, Math.abs(delta) > 6 ? Math.abs(delta) / this.scale : 180));
      this.createAndAddNewEditor({
        offsetX: Math.min(start.offsetX, event.offsetX), offsetY: Math.min(start.offsetY, event.offsetY)
      }, false, { pdfreaderBoxWidth: width });
      return;
    }
    this.createAndAddNewEditor(event, false, currentMode === AnnotationEditorType.FREETEXT &&
      document.documentElement.classList.contains("pdfreader-host-toolbar") ? { pdfreaderBoxWidth: 180 } : {});
  }
  pointerdown(event) {`);
  replace('    this.#hadPointerDown = true;\n    if (this.#currentEditorType?.isDrawer)', `    this.#hadPointerDown = true;
    this.pdfreaderTextBoxStart = null;
    if (this.#uiManager.getMode() === AnnotationEditorType.FREETEXT &&
        document.documentElement.classList.contains("pdfreader-host-toolbar")) {
      const { clientX, offsetX, offsetY } = event;
      this.pdfreaderTextBoxStart = { clientX, offsetX, offsetY, bounds: this.div.getBoundingClientRect() };
    }
    if (this.#currentEditorType?.isDrawer)`);
});

patch('public/pdfjs/web/viewer.mjs', replace => {
  replace('class CommentManager {\n  #dialog;', 'class CommentManager {\n  #eventBus;\n  #dialog;');
  replace('    this.dialogElement = commentDialog.dialog;', '    this.#eventBus = eventBus;\n    this.dialogElement = commentDialog.dialog;');
  replace('    this.#sidebar.show(annotations);', `    if (!document.documentElement.classList.contains("pdfreader-host-toolbar")) this.#sidebar.show(annotations);`);
  replace('  toggleCommentPopup(editor, isSelected, visibility, isEditable) {\n    if (isSelected) {', `  toggleCommentPopup(editor, isSelected, visibility, isEditable) {
    if (document.documentElement.classList.contains("pdfreader-host-toolbar")) {
      if (editor && isSelected && visibility !== false) {
        this.#eventBus.dispatch("pdfreadercomment", { editor, edit: false });
      }
      return;
    }
    if (isSelected) {`);
  replace('    return this.#dialog.open(uiManager, editor, posX, posY, options);', `    if (document.documentElement.classList.contains("pdfreader-host-toolbar")) {
      this.#eventBus.dispatch("pdfreadercomment", { editor, edit: true });
      return;
    }
    return this.#dialog.open(uiManager, editor, posX, posY, options);`);
});

patch('public/pdfjs/build/pdf.worker.mjs', replace => {
  replace(';// ./src/shared/util.js', 'import { textBoxMask } from "../web/textbox-appearance.mjs";\n\n;// ./src/shared/util.js');
  replace('    this._hasAppearance = !!this.appearance;\n    if (this._hasAppearance) {\n      const {\n        fontColor,\n        fontSize\n      } = parseAppearanceStream', `    this._hasAppearance = !!this.appearance;
    this.data.pdfreaderTextBox = params.dict.get("PDFreaderTextBox") === true;
    if (this.data.pdfreaderTextBox) {
      const { defaultAppearanceData } = this.data;
      defaultAppearanceData.fontSize ||= 10;
      this.data.textContent = this._contents.str.split(/\\r\\n?|\\n/);
      const [x0, y0, x1, y1] = this.rectangle;
      this.data.textPosition = { 0: [x0, y1], 90: [x0, y0], 180: [x1, y0], 270: [x1, y1] }[this.rotation];
    } else if (this._hasAppearance) {
      const {
        fontColor,
        fontSize
      } = parseAppearanceStream`);
  replace('  get hasTextContent() {\n    return this._hasAppearance;\n  }\n  static createNewDict', '  get hasTextContent() {\n    return this._hasAppearance && !this.data.pdfreaderTextBox;\n  }\n  static createNewDict');
  replace('    freetext.set("DA", da);', `    freetext.set("DA", da);
    if (annotation.pdfreaderBoxWidth) freetext.set("PDFreaderTextBox", true);`);
  replace('    const resources = new Dict(xref);\n    const font = new Dict(xref);\n    if (baseFontRef) {', `    const resources = new Dict(xref);
    if (annotation.pdfreaderBoxWidth && typeof OffscreenCanvas !== "undefined") {
      const [x0, y0, x1, y1] = rect;
      const [a, b, c, d, x, y, w, h] = {
        0: [1, 0, 0, 1, x0, y0, x1 - x0, y1 - y0],
        90: [0, 1, -1, 0, y0, -x1, y1 - y0, x1 - x0],
        180: [-1, 0, 0, -1, -x1, -y1, x1 - x0, y1 - y0],
        270: [0, -1, 1, 0, -y1, x0, y1 - y0, x1 - x0]
      }[rotation];
      if (w > 0 && h > 0) {
        const mask = textBoxMask(value, fontSize, w, h);
        const appearance = ["q", \`${'\$'}{a} ${'\$'}{b} ${'\$'}{c} ${'\$'}{d} 0 0 cm\`, getPdfColor(color, true),
          \`${'\$'}{w} 0 0 ${'\$'}{h} ${'\$'}{x} ${'\$'}{y} cm\`, mask, "Q"].join("\\n");
        const dict = new Dict(xref);
        dict.set("FormType", 1);
        dict.setIfName("Subtype", "Form");
        dict.setIfName("Type", "XObject");
        dict.set("BBox", rect);
        dict.set("Resources", resources);
        dict.set("Matrix", [1, 0, 0, 1, -x0, -y0]);
        return new StringStream(appearance, dict);
      }
    }
    const font = new Dict(xref);
    if (baseFontRef) {`);
});
