// PDFreader integration for PDF.js 6.5.438. Notes use standard Text + Popup
// annotations and have their own lifecycle, separate from highlight editors.
export function createNoteEditor(AnnotationEditor) {
  return class NoteEditor extends AnnotationEditor {
    static _type = 'comment';
    static _editorType = 102;

    constructor(params) {
      super({ ...params, name: 'pdfreaderNoteEditor' });
      this.width = 22 / this.pageDimensions[0];
      this.height = 22 / this.pageDimensions[1];
      this.rotation = 0;
      this._isDraggable = false;
      this._anchor = params.anchor || null;
      if (this._anchor) {
        this.x = Math.max(0, Math.min(1 - this.width, this._anchor.x + this._anchor.width));
        this.y = Math.max(0, Math.min(1 - this.height, this._anchor.y));
      }
    }

    get color() { return '#e5a400'; }
    get opacity() { return 1; }
    get isResizable() { return false; }
    get commentButtonPosition() { return [0, 0]; }
    get toolbarPosition() { return [0, 1]; }
    // An empty/cancelled note must not leave a marker or dirty storage behind.
    isEmpty() { return !this.hasComment && !this.annotationElementId; }

    get comment() { return super.comment; }
    set comment(value) {
      super.comment = value;
      this.addToAnnotationStorage();
    }

    render() {
      if (this.div) return this.div;
      const div = super.render();
      // Reuse the generic editor toolbar styling; this creates no text input.
      div.classList.add('freeTextEditor');
      div.setAttribute('aria-label', '注释');
      this.setDims();
      return div;
    }

    onceAdded() {
      if (!this.annotationElementId && !this._undoRegistered) {
        this._undoRegistered = true;
        this.parent.addUndoableEditor(this);
      }
    }

    // Base AnnotationEditor supplies the standard Popup editor, preview,
    // sidebar, undo/delete and annotation-storage integration.
    serialize(isForCopying = false) {
      if (isForCopying || this.isEmpty()) return null;
      if (this.deleted || !this.hasComment) return this.annotationElementId ? this.serializeDeleted() : null;
      if (this.annotationElementId && !this.hasEditedComment) return null;
      const data = { ...super.serialize(), id: this.annotationElementId,
        color: [229, 164, 0], opacity: 1, user: 'PDFreader',
        anchor: this._anchor };
      this.addComment(data);
      return data;
    }

    static async deserialize(element, parent, uiManager) {
      const { data, parent: { page: { pageNumber } } } = element;
      const initial = { ...data, annotationElementId: data.id,
        pageIndex: pageNumber - 1, rotation: 0,
        comment: data.contentsObj?.str || null };
      const editor = await super.deserialize(initial, parent, uiManager);
      editor._initialData = initial;
      editor._anchor = data.pdfreaderAnchor || null;
      editor.setCommentData(initial);
      return editor;
    }

    renderAnnotationElement(annotation) {
      if (this.deleted || !this.hasComment) { annotation.hide(); return null; }
      annotation.updateEdited({ rect: this.getPDFRect(), popup: this.comment });
      return null;
    }
  };
}
