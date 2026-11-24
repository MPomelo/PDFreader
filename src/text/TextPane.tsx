import { useCallback, useEffect, useMemo, useRef, useDeferredValue, useState } from 'react';
import { Compartment, EditorState, Transaction, type ChangeSpec } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { MarkdownRenderer } from '../translation/MarkdownRenderer';
import { isImage, loadImage, relativePath } from './attachments';
import { copyText, supportsNativeAttachments, type TextTab } from './document';
import './text.css';

export interface TextEditor {
  find(): void;
  undo(): void;
  redo(): void;
  insert(text: string, position?: number): void;
  apply(changes: ChangeSpec[]): void;
  atCoordinates(x: number, y: number): number | undefined;
  track(position: number): () => number;
}

const phrases = EditorState.phrases.of({
  Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '选择全部',
  'match case': '区分大小写', regexp: '正则表达式', 'by word': '全字匹配',
  replace: '替换当前', 'replace all': '全部替换', close: '关闭查找',
});
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'Consolas, "Microsoft YaHei", monospace', lineHeight: '1.65' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 10px' },
  '.cm-gutters,.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--muted)', borderColor: 'var(--border)' },
  '.cm-activeLine,.cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
  '.cm-selectionBackground,.cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent) !important' },
  '.cm-cursor,.cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-textfield,.cm-button': { background: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--border)' },
});

function imageFiles(transfer: DataTransfer | null) {
  return Array.from(transfer?.files ?? []).filter(isImage);
}

function useImageSource(file: File | undefined, path: string, relative: string | null) {
  const [result, setResult] = useState<{ file?: File; path: string; relative: string | null; source?: string }>({ path: '', relative: null });
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    if (file) {
      url = URL.createObjectURL(file);
      setResult({ file, path, relative, source: url });
    } else if (path && relative) {
      void loadImage(path, relative).then(
        source => { if (active) setResult({ path, relative, source }); },
        () => { if (active) setResult({ path, relative }); },
      );
    }
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [file, path, relative]);
  return result.file === file && result.path === path && result.relative === relative ? result : null;
}

function PreviewImage({ alt, src, title, path, staged }: { alt: string; src: string; title?: string; path: string; staged: TextTab['staged'] }) {
  const remote = /^https?:\/\//i.test(src);
  const [loaded, setLoaded] = useState('');
  const [failed, setFailed] = useState('');
  const relative = remote ? null : relativePath(src);
  const file = relative ? staged[relative] : undefined;
  const local = useImageSource(file, remote ? '' : path, relative);
  const url = remote && loaded === src ? src : local?.source;
  if (url && failed !== src) {
    return <img alt={alt} src={url} title={title} referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
  }
  if (remote && loaded !== src) return <button className="network-image" title={src} onClick={() => setLoaded(src)}>加载网络图片{alt ? ` · ${alt}` : ''}</button>;
  if (!remote && (file || path && relative) && !local && !url) return <span className="image-placeholder">正在读取图片 {alt || relative}</span>;
  return <span className="image-placeholder" title={src}>图片不可用 · {relative || src || alt}</span>;
}

export function TextPane({ tab, active, busy, register, onEdit, onMode, onImages, onCopy, onError }: {
  tab: TextTab;
  active: boolean;
  busy: boolean;
  register: (id: string, editor: TextEditor | null) => void;
  onEdit: (id: string, source: string | undefined, position: TextTab['position']) => void;
  onMode: (id: string, mode: TextTab['mode']) => void;
  onImages: (id: string, files: File[], position?: number) => void;
  onCopy: (message: string) => void;
  onError: (message: string) => void;
}) {
  const editorHost = useRef<HTMLDivElement>(null);
  const controller = useRef<EditorView | null>(null);
  const wrap = useRef(new Compartment()).current, readOnly = useRef(new Compartment()).current;
  const callbacks = useRef({ onEdit, onMode, onImages, busy });
  callbacks.current = { onEdit, onMode, onImages, busy };
  const deferredSource = useDeferredValue(tab.source);
  const Image = useMemo(() => ({ alt, src, title }: { alt: string; src: string; title?: string }) =>
    <PreviewImage key={src} alt={alt} src={src} title={title} path={tab.path} staged={tab.staged} />,
    [tab.path, tab.staged]);

  useEffect(() => {
    const tracked = new Set<{ position: number }>();
    const view = new EditorView({
      parent: editorHost.current!,
      state: EditorState.create({
        doc: tab.source,
        extensions: [
          lineNumbers(), highlightActiveLine(), drawSelection(), history(), search({ top: true }), phrases, theme,
          keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
          wrap.of(tab.wrap ? EditorView.lineWrapping : []), readOnly.of(EditorState.readOnly.of(busy)),
          ...(tab.kind === 'markdown' ? [markdown(), syntaxHighlighting(defaultHighlightStyle)] : []),
          EditorView.contentAttributes.of({ 'aria-label': tab.kind === 'txt' ? 'TXT 编辑器' : 'Markdown 编辑器', spellcheck: 'false' }),
          EditorView.updateListener.of(update => {
            if (update.docChanged) for (const marker of tracked) marker.position = update.changes.mapPos(marker.position, 1);
            if (!update.docChanged && !update.selectionSet) return;
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            callbacks.current.onEdit(tab.id, update.docChanged ? update.state.doc.toString() : undefined, {
              line: line.number, column: head - line.from + 1,
            });
          }),
          ...(tab.kind === 'markdown' && supportsNativeAttachments() ? [EditorView.domEventHandlers({
            paste(event) {
              const files = imageFiles(event.clipboardData);
              if (!files.length) return false;
              if (!callbacks.current.busy) callbacks.current.onImages(tab.id, files);
              return true;
            },
            drop(event, view) {
              const files = imageFiles(event.dataTransfer);
              if (!files.length) return false;
              if (!callbacks.current.busy) callbacks.current.onImages(tab.id, files, view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined);
              return true;
            },
          })] : []),
        ],
      }),
    });
    controller.current = view;
    register(tab.id, {
      find() {
        if (editorHost.current?.parentElement?.dataset.mode === 'preview') callbacks.current.onMode(tab.id, 'split');
        requestAnimationFrame(() => openSearchPanel(view));
      },
      undo: () => { undo(view); },
      redo: () => { redo(view); },
      insert(text, position) {
        const selection = view.state.selection.main;
        const from = position ?? selection.from, to = position ?? selection.to;
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true });
        requestAnimationFrame(() => view.focus());
      },
      apply(changes) {
        if (changes.length) view.dispatch({ changes, annotations: Transaction.addToHistory.of(false) });
      },
      atCoordinates(x, y) {
        const element = document.elementFromPoint(x, y);
        return element && view.contentDOM.contains(element) ? view.posAtCoords({ x, y }) ?? undefined : undefined;
      },
      track(position) {
        const marker = { position };
        tracked.add(marker);
        return () => { tracked.delete(marker); return marker.position; };
      },
    });
    return () => { register(tab.id, null); controller.current = null; view.destroy(); };
  }, []);

  useEffect(() => {
    controller.current?.dispatch({ effects: wrap.reconfigure(tab.wrap ? EditorView.lineWrapping : []) });
  }, [tab.wrap, wrap]);
  useEffect(() => {
    controller.current?.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(busy)) });
  }, [busy, readOnly]);
  useEffect(() => { if (active && tab.mode !== 'preview') controller.current?.requestMeasure(); }, [active, tab.mode]);

  const copied = useCallback((text: string, message: string) => {
    void copyText(text).then(() => onCopy(message), error => onError(String(error)));
  }, [onCopy, onError]);
  const copyMath = useCallback((text: string) => copied(text, '已复制公式'), [copied]);
  const copyCode = useCallback((text: string) => copied(text, '已复制代码'), [copied]);

  return <div id={'document-pane-' + tab.id} className="document-pane text-pane" data-active={active}
    data-mode={tab.mode} role="tabpanel" aria-labelledby={'document-tab-' + tab.id} aria-hidden={!active} inert={!active}>
    <div className="text-editor" ref={editorHost} hidden={tab.mode === 'preview'} />
    {tab.kind === 'markdown' && tab.mode !== 'edit' && <article className="text-preview" aria-label="Markdown 预览">
      <MarkdownRenderer source={deferredSource} image={Image} onCopy={copyMath} onCopyCode={copyCode} />
    </article>}
  </div>;
}
