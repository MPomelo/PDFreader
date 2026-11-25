// Apply after patch-pdfjs-annotation-workspace.mjs to PDF.js 6.5.438.
import { readFileSync, writeFileSync } from 'node:fs';
const marker = '// PDFreader contextual text box patch';

function patch(path, apply) {
  let source = readFileSync(path, 'utf8');
  if (!source.includes('pdfjsVersion = 6.5.438') || !source.includes('// PDFreader annotation workspace patch')) {
    throw Error(`Unexpected PDF.js source: ${path}`);
  }
  if (source.includes(marker)) return;
  apply((before, after) => {
    if (source.split(before).length !== 2) throw Error(`Patch context mismatch in ${path}: ${before.slice(0, 90)}`);
    source = source.replace(before, () => after);
  });
  writeFileSync(path, source + '\n' + marker + '\n');
}

patch('public/pdfjs/build/pdf.mjs', replace => {
  replace('import { textBoxFont } from "../web/textbox-appearance.mjs";',
    'import { textBoxFont } from "../web/textbox-appearance.mjs";\nimport { bindTextBoxResize } from "../web/textbox-handles.mjs";');
  replace('  onScaleChanging({\n    scale\n  }) {\n    this.commitOrRemove();',
    '  onScaleChanging({\n    scale\n  }) {\n    if (!this.pdfreaderTextBoxInEditMode()) this.commitOrRemove();');
  replace('  pdfreaderHistory() {', `  pdfreaderTextPlacement = false;
  #pdfreaderTextBoxTarget() {
    const editor = this.#activeEditor || this.#lastSelectedEditor;
    return editor instanceof FreeTextEditor && !editor.deleted ? editor : null;
  }
  pdfreaderTextBoxStyle() {
    const editor = this.#pdfreaderTextBoxTarget();
    if (!this.pdfreaderTextPlacement && !editor) return null;
    return editor?.pdfreaderStyle || FreeTextEditor.pdfreaderDefaults;
  }
  pdfreaderTextBoxInEditMode() {
    const editor = this.#pdfreaderTextBoxTarget();
    return editor?.isInEditMode() && document.documentElement.classList.contains("pdfreader-host-toolbar") ? editor : null;
  }
  pdfreaderFinishTextBox() {
    this.pdfreaderTextPlacement = false;
    const editor = this.#pdfreaderTextBoxTarget();
    if (editor?.isInEditMode()) editor.commitOrRemove();
  }
  pdfreaderSetTextBoxStyle(target, property, value) {
    const editor = this.#pdfreaderTextBoxTarget();
    if (target !== (editor?.id ?? null) || !editor && !this.pdfreaderTextPlacement) return;
    const style = editor?.pdfreaderStyle || FreeTextEditor.pdfreaderDefaults;
    if (style[property === "background" ? "whiteBackground" : property] === value) return;
    if (property === "background") {
      if (editor) editor.pdfreaderSetWhiteBackground(value);
      else FreeTextEditor.pdfreaderDefaultWhiteBackground = value;
    } else {
      const type = property === "size" ? AnnotationEditorParamsType.FREETEXT_SIZE : AnnotationEditorParamsType.FREETEXT_COLOR;
      if (editor) editor.updateParams(type, value);
      else FreeTextEditor.updateDefaultParams(type, value);
    }
  }
  pdfreaderHistory() {`);
  replace('  #boxWidth = 0;\n  get pdfreaderText()', `  #boxWidth = 0;
  #whiteBackground = false;
  static pdfreaderDefaultWhiteBackground = false;
  static get pdfreaderDefaults() {
    return { target: null, size: this._defaultFontSize, color: this._defaultColor || AnnotationEditor._defaultLineColor,
      whiteBackground: this.pdfreaderDefaultWhiteBackground };
  }
  get pdfreaderStyle() {
    return { target: this.id, size: this.#fontSize, color: this.color, whiteBackground: this.#whiteBackground };
  }
  pdfreaderSetWhiteBackground(value) {
    const previous = this.#whiteBackground;
    if (value === previous) return;
    const apply = next => {
      this.#whiteBackground = next;
      this.#applyBackground();
      this.addToAnnotationStorage();
    };
    this.addCommands({ cmd: () => apply(value), undo: () => apply(previous), mustExec: true });
  }
  #applyBackground() {
    this.div.classList.toggle("pdfreader-text-box-white", this.#whiteBackground);
  }
  get pdfreaderText()`);
  replace('    this.#boxWidth = params.pdfreaderBoxWidth || 0;', `    this.#boxWidth = params.pdfreaderBoxWidth || 0;
    this.#whiteBackground = !!this.#boxWidth && FreeTextEditor.pdfreaderDefaultWhiteBackground;`);
  replace('  pdfreaderResize(width) {\n    this.commit();', '  pdfreaderResize(width) {');
  replace('      this.translate(0, -(size - this.#fontSize) * this.parentScale);',
    '      if (!this.#boxWidth) this.translate(0, -(size - this.#fontSize) * this.parentScale);');
  replace('    if (!super.enableEditMode()) {\n      return false;\n    }\n    this.overlayDiv', `    if (!super.enableEditMode()) {
      return false;
    }
    this.div.classList.add("pdfreader-text-box-editing");
    this.overlayDiv`);
  replace('    if (!super.disableEditMode()) {\n      return false;\n    }\n    this.overlayDiv', `    if (!super.disableEditMode()) {
      return false;
    }
    this.div.classList.remove("pdfreader-text-box-editing");
    this.overlayDiv`);
  replace('    super.focusin(event);\n    if (event.target !== this.editorDiv)', `    super.focusin(event);
    if (event.target.closest?.(".pdfreader-text-box-handle")) return;
    if (event.target !== this.editorDiv)`);
  replace('  onceAdded(focus) {\n    if (this.width) {', `  focusout(event) {
    if (!event.relatedTarget && this.div.classList.contains("pdfreader-text-box-editing") &&
        document.documentElement.classList.contains("pdfreader-host-toolbar") && window.parent !== window) {
      // A host form control has no iframe-local relatedTarget. Wait for its focus
      // before committing an empty editor or ending the current input session.
      setTimeout(() => {
        const hostFocus = window.parent.document.activeElement;
        if (hostFocus?.closest("[data-pdfreader-text-toolbar]")) return;
        if (hostFocus === window.frameElement) {
          // Reflowing the dock can temporarily detach the editor within the iframe.
          if (this.isInEditMode() && this.isAttachedToDOM &&
              this._uiManager.firstSelectedEditor === this && document.activeElement === document.body) {
            this.editorDiv.focus({ preventScroll: true });
          }
          return;
        }
        super.focusout(event);
      }, 0);
      return;
    }
    super.focusout(event);
  }
  onceAdded(focus) {
    if (this.width) {`);
  replace('    this._initialOptions = null;\n  }\n  isEmpty() {\n    return !this.editorDiv', `    this._initialOptions = null;
    if (this.#boxWidth) this.#setEditorDimensions();
  }
  isEmpty() {
    return !this.editorDiv`);
  replace('  editorDivKeydown(event) {\n    FreeTextEditor._keyboardManager.exec(this, event);', `  editorDivKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    FreeTextEditor._keyboardManager.exec(this, event);`);
  replace('    this.#applyBoxWidth();\n    this.overlayDiv =', `    this.#applyBoxWidth();
    this.#applyBackground();
    if (this.#boxWidth && document.documentElement.classList.contains("pdfreader-host-toolbar")) {
      const signal = this._uiManager._signal;
      const resize = document.createElement("button");
      resize.type = "button";
      resize.className = "pdfreader-text-box-handle resize-width";
      resize.setAttribute("aria-label", "拖动或按方向键调整宽度");
      bindTextBoxResize(resize, this, signal, width => {
        this.div.style.width = \`calc(\${width}px * var(--total-scale-factor))\`;
      }, width => this.pdfreaderResize(width));
      const move = document.createElement("span");
      move.className = "pdfreader-text-box-handle move-box";
      move.setAttribute("aria-hidden", "true");
      move.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        this.commit();
        this.parent.setSelected(this);
      }, { signal });
      this.div.append(resize, move);
    }
    this.overlayDiv =`);
  replace('      const pdfreaderBoxWidth = data.data.pdfreaderTextBox', `      const pdfreaderWhiteBackground = data.data.pdfreaderWhiteBackground;
      const pdfreaderBoxWidth = data.data.pdfreaderTextBox`);
  replace('        pdfreaderBoxWidth,\n        position:', '        pdfreaderBoxWidth,\n        pdfreaderWhiteBackground,\n        position:');
  replace('    editor.#boxWidth = data.pdfreaderBoxWidth || 0;', `    editor.#boxWidth = data.pdfreaderBoxWidth || 0;
    editor.#whiteBackground = data.pdfreaderWhiteBackground === true;`);
  replace('      ...(this.#boxWidth ? { pdfreaderBoxWidth: this.#boxWidth } : null)', `      ...(this.#boxWidth ? { pdfreaderBoxWidth: this.#boxWidth } : null),
      ...(this.#whiteBackground ? { pdfreaderWhiteBackground: true } : null)`);
  replace('return this.hasEditedComment || this._hasBeenMoved || (serialized.pdfreaderBoxWidth || 0)', `return this.hasEditedComment || this._hasBeenMoved ||
      this.#whiteBackground !== !!this._initialData.pdfreaderWhiteBackground || (serialized.pdfreaderBoxWidth || 0)`);
  replace('    style.color = this.color;\n    content.replaceChildren();', `    style.color = this.color;
    style.backgroundColor = this.#whiteBackground ? "#fff" : "";
    if (this.#boxWidth) {
      style.fontFamily = textBoxFont;
      style.whiteSpace = "pre-wrap";
      style.overflowWrap = "anywhere";
    }
    content.replaceChildren();`);
  replace('    if (!this.#allowClick) {\n      this.#allowClick = true;', `    if (this.#uiManager.getMode() === AnnotationEditorType.FREETEXT && event.type === "pointerup" &&
        document.documentElement.classList.contains("pdfreader-host-toolbar") && !this.#uiManager.pdfreaderTextPlacement) {
      this.#uiManager._eventBus.dispatch("pdfreadertextdismiss");
      return;
    }
    if (!this.#allowClick) {
      this.#allowClick = true;`);
  replace('    const start = this.pdfreaderTextBoxStart;\n    this.pdfreaderTextBoxStart = null;', `    const start = this.pdfreaderTextBoxStart;
    this.pdfreaderTextBoxStart = null;
    if (start && event.type !== "pointerup") return;`);
  replace('      const delta = event.clientX - start.clientX;\n      const maxWidth = (start.bounds.right - Math.min(start.clientX, event.clientX)) / this.scale;\n      const width = Math.max(12, Math.min(maxWidth, Math.abs(delta) > 6 ? Math.abs(delta) / this.scale : 180));\n      this.createAndAddNewEditor({\n        offsetX: Math.min(start.offsetX, event.offsetX), offsetY: Math.min(start.offsetY, event.offsetY)\n      }, false, { pdfreaderBoxWidth: width });', `      const bounds = start.bounds;
      const x = MathClamp(event.clientX, bounds.left, bounds.right);
      const delta = x - start.clientX;
      const left = Math.min(start.clientX, x);
      const maxWidth = (bounds.right - left) / this.scale;
      const width = Math.max(12, Math.min(maxWidth, Math.abs(delta) > 6 ? Math.abs(delta) / this.scale : 180));
      // Derive the origin from screen coordinates, using the layer's transform
      // to convert the horizontal drag back into its local coordinates.
      const top = MathClamp(Math.min(start.clientY, event.clientY), bounds.top, bounds.bottom);
      const [offsetX, offsetY] = this.pdfreaderTextBoxOffset(start, left, top);
      this.#uiManager.pdfreaderTextPlacement = false;
      this.createAndAddNewEditor({ offsetX, offsetY }, false, { pdfreaderBoxWidth: width });`);
  replace('  pointerdown(event) {\n    if (this.#uiManager.getMode() === AnnotationEditorType.HIGHLIGHT)', `  pdfreaderTextBoxOffset(start, left, top) {
    const dx = left - start.clientX, dy = top - start.clientY;
    switch (this.viewport.rotation % 360) {
      case 90: return [start.offsetX + dy, start.offsetY - dx];
      case 180: return [start.offsetX - dx, start.offsetY - dy];
      case 270: return [start.offsetX - dy, start.offsetY + dx];
      default: return [start.offsetX + dx, start.offsetY + dy];
    }
  }
  pointerdown(event) {
    if (this.#uiManager.getMode() === AnnotationEditorType.HIGHLIGHT)`);
  replace('    if (this.#uiManager.getMode() === AnnotationEditorType.FREETEXT &&\n        document.documentElement.classList.contains("pdfreader-host-toolbar")) {\n      const { clientX, offsetX, offsetY } = event;\n      this.pdfreaderTextBoxStart = { clientX, offsetX, offsetY, bounds: this.div.getBoundingClientRect() };',
    `    if (this.#uiManager.getMode() === AnnotationEditorType.FREETEXT && this.#uiManager.pdfreaderTextPlacement &&
        document.documentElement.classList.contains("pdfreader-host-toolbar")) {
      const { clientX, clientY, offsetX, offsetY } = event;
      this.pdfreaderTextBoxStart = { clientX, clientY, offsetX, offsetY, bounds: this.div.getBoundingClientRect() };
      this.div.setPointerCapture(event.pointerId);`);
  replace('  #cleanup() {\n    for (const editor of this.#editors.values()) {\n      if (editor.isEmpty()) {', `  #cleanup(keepEditor = null) {
    for (const editor of this.#editors.values()) {
      if (editor !== keepEditor && editor.isEmpty()) {`);
  replace('    this.#uiManager.commitOrRemove();\n    this.#cleanup();\n    const oldRotation = this.viewport.rotation;\n    const rotation = viewport.rotation;', `    const oldRotation = this.viewport.rotation;
    const rotation = viewport.rotation;
    const keepEditor = oldRotation === rotation ? this.#uiManager.pdfreaderTextBoxInEditMode() : null;
    // Opening the host toolbar can change page-fit zoom while editing.
    if (!keepEditor) this.#uiManager.commitOrRemove();
    this.#cleanup(keepEditor);`);
  replace('    this.container.classList.add("freeTextAnnotation");\n    if (this.textContent) {', `    this.container.classList.add("freeTextAnnotation");
    const hostTextBox = this.data.pdfreaderTextBox && document.documentElement.classList.contains("pdfreader-host-toolbar");
    if (hostTextBox && this.data.isEditable && !(this.data.annotationFlags & (0x40 | 0x80 | 0x200))) {
      this.container.classList.add("pdfreader-saved-text-box");
      let selectTimer;
      this.container.addEventListener("click", event => {
        if (event.button !== 0 || event.detail > 1) return;
        // A double-click should reach the original PDF annotation before
        // selection swaps it for an editor element.
        clearTimeout(selectTimer);
        selectTimer = setTimeout(() => {
          if (!this.container.isConnected || this.container.hidden) return;
          this.linkService.eventBus.dispatch("switchannotationeditormode", {
            source: this, mode: AnnotationEditorType.FREETEXT, editId: this.data.id
          });
        }, 260);
      });
      this.container.addEventListener("dblclick", () => clearTimeout(selectTimer));
    }
    if (this.textContent) {`);
  replace('      this.container.append(content);\n    }\n    if (!this.data.popupRef && this.hasPopupData) {\n      this.hasOwnCommentButton = true;\n      this._createPopup();\n    }\n    this._editOnDoubleClick();',
    '      this.container.append(content);\n    }\n    if (!hostTextBox && !this.data.popupRef && this.hasPopupData) {\n      this.hasOwnCommentButton = true;\n      this._createPopup();\n    }\n    this._editOnDoubleClick();');
});

patch('public/pdfjs/build/pdf.worker.mjs', replace => {
  replace('    this.data.pdfreaderTextBox = params.dict.get("PDFreaderTextBox") === true;', `    this.data.pdfreaderTextBox = params.dict.get("PDFreaderTextBox") === true;
    this.data.pdfreaderWhiteBackground = params.dict.get("PDFreaderTextBoxBackground") === true;`);
  replace('    if (annotation.pdfreaderBoxWidth) freetext.set("PDFreaderTextBox", true);', `    if (annotation.pdfreaderBoxWidth) freetext.set("PDFreaderTextBox", true);
    if (annotation.pdfreaderWhiteBackground) freetext.set("PDFreaderTextBoxBackground", true);
    else freetext.delete("PDFreaderTextBoxBackground");`);
  replace('        const appearance = ["q", \`\${a} \${b} \${c} \${d} 0 0 cm\`, getPdfColor(color, true),\n          \`\${w} 0 0 \${h} \${x} \${y} cm\`, mask, "Q"].join("\\n");', `        const paint = annotation.pdfreaderWhiteBackground ? ["1 g", \`\${x} \${y} \${w} \${h} re f\`] : [];
        const appearance = ["q", \`\${a} \${b} \${c} \${d} 0 0 cm\`, ...paint, getPdfColor(color, true),
          \`\${w} 0 0 \${h} \${x} \${y} cm\`, mask, "Q"].join("\\n");`);
  replace('    const buffer = ["q", \`\${matrix.join(" ")} 0 0 cm\`, \`\${clipBox.join(" ")} re W n\`, \`BT\`, \`\${getPdfColor(color, true)}\`, \`0 Tc /Helv \${numberToString(newFontSize)} Tf\`];', `    const paint = annotation.pdfreaderWhiteBackground ? ["1 g", \`\${clipBox.join(" ")} re f\`] : [];
    const buffer = ["q", \`\${matrix.join(" ")} 0 0 cm\`, ...paint, \`\${clipBox.join(" ")} re W n\`, \`BT\`, \`\${getPdfColor(color, true)}\`, \`0 Tc /Helv \${numberToString(newFontSize)} Tf\`];`);
});
