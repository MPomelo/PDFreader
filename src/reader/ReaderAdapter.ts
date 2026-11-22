import type { CitationMetadata } from '../citation/format';
import type { Accent, ColorScheme } from '../ui/appearance';

export type SelectionRect = { page: number; x: number; y: number; width: number; height: number };
export type ReaderAction = 'previous' | 'next' | 'zoom-in' | 'zoom-out' | 'rotate' | 'print' | 'highlight' | 'underline' | 'strikeout' | 'text' | 'ink' | 'select' | 'thumbnails' | 'hide-navigation'
  | 'first-page' | 'last-page' | 'rotate-left' | 'cursor-select' | 'cursor-hand' | 'scroll-page' | 'scroll-vertical' | 'scroll-horizontal' | 'scroll-wrapped' | 'spread-none' | 'spread-odd' | 'spread-even' | 'document-properties' | 'undo' | 'redo';
export type ReaderState = {
  documentId: string; page: number; pages: number; selection: string; selectionRaw: string;
  selectionRects: SelectionRect[]; pageHasText: boolean | null;
  outline: { title: string; index: number }[]; dirty: boolean; revision: number;
  zoom?: string; selectionAnchor?: string;
  find?: { requestId: string; status: 'pending' | 'found' | 'not-found' | 'wrapped'; current: number; total: number; previous: boolean } | null;
};
export type FindOptions = { highlightAll: boolean; caseSensitive: boolean; entireWord: boolean; matchDiacritics: boolean };
export type ReaderEvent = { type: 'state'; state: ReaderState } | { type: 'error'; message: string } | { type: 'export-requested' } | { type: 'file-open-requested'; bytes: Uint8Array; filename: string }
  | { type: 'dismiss-menus' } | { type: 'translate-selection' } | { type: 'selection-copied' } | { type: 'cite-document' };
type Pending = { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };

/** The only boundary between the shell and the fixed-version generic Viewer. */
export class ReaderAdapter {
  private documentId = '';
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private pending = new Map<string, Pending>();
  private disposed = false;
  constructor(private frame: HTMLIFrameElement, private onEvent: (event: ReaderEvent) => void) {
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    window.addEventListener('message', this.receive);
    this.frame.contentWindow?.postMessage({ channel: 'pdfreader', type: 'hello' }, location.origin);
  }
  get hasDocument() { return !!this.documentId; }
  private receive = (event: MessageEvent) => {
    if (event.source !== this.frame.contentWindow || event.origin !== location.origin || event.data?.channel !== 'pdfreader') return;
    const message = event.data;
    if (message.type === 'ready') { this.resolveReady(); return; }
    if (message.documentId !== this.documentId) return;
    if (message.type === 'reply') {
      const request = this.pending.get(message.requestId);
      if (!request) return;
      this.pending.delete(message.requestId); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    } else if (message.type === 'state' && message.state?.documentId === this.documentId) {
      this.onEvent({ type: 'state', state: message.state });
    } else if (message.type === 'error') this.onEvent({ type: 'error', message: message.message });
    else if (message.type === 'export-requested') this.onEvent({ type: 'export-requested' });
    else if (message.type === 'file-open-requested') this.onEvent({ type: 'file-open-requested', bytes: message.bytes, filename: message.filename });
    else if (['dismiss-menus', 'translate-selection', 'selection-copied', 'cite-document'].includes(message.type)) this.onEvent({ type: message.type });
  };
  private rejectPending(reason: string) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); }
    this.pending.clear();
  }
  private async request<T>(type: string, extra = {}, transfer: Transferable[] = []): Promise<T> {
    const documentId = this.documentId;
    await this.ready;
    if (this.disposed) throw new Error('阅读器已关闭');
    if (documentId !== this.documentId) throw new Error('文档已切换');
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('阅读器操作超时，请重试。')); }, type === 'open' ? 600000 : 120000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.frame.contentWindow!.postMessage({ channel: 'pdfreader', type, documentId, requestId, ...extra }, location.origin, transfer); }
      catch (e) { clearTimeout(timer); this.pending.delete(requestId); reject(e); }
    });
  }
  async open(bytes: Uint8Array, filename: string): Promise<ReaderState> {
    this.rejectPending('文档已切换');
    this.documentId = crypto.randomUUID();
    const id = this.documentId;
    try { return await this.request('open', { bytes, filename }, [bytes.buffer as ArrayBuffer]); }
    catch (error) { if (id === this.documentId) this.documentId = ''; throw error; }
  }
  flush() { return this.request<ReaderState>('flush'); }
  export() { return this.request<{ bytes: Uint8Array; token: string }>('export'); }
  markExported(token: string) { return this.request<ReaderState>('exported', { token }); }
  commentSelection() { return this.request<boolean>('comment-selection'); }
  citationMetadata() { return this.request<CitationMetadata>('citation-metadata'); }
  showComments() { return this.request<boolean>('show-comments'); }
  find(requestId: string, query: string, options: FindOptions, again: boolean, previous: boolean) {
    this.send('find', { findId: requestId, query, options, again, previous });
  }
  closeFind() { if (!this.disposed && this.hasDocument) this.send('close-find'); }
  dismissSelectionMenu() { this.send('dismiss-selection-menu'); }
  navigate(index: number) { this.send('outline', { index }); }
  restore(page: number, zoom = 'auto') { return this.request<ReaderState>('restore', { page, zoom }); }
  setTheme(theme: ColorScheme, accent: Accent) { void this.ready.then(() => { if (!this.disposed) this.frame.contentWindow?.postMessage({ channel: 'pdfreader', type: 'theme', theme, accent }, location.origin); }); }
  setSelectionToolbar(enabled: boolean) { void this.ready.then(() => { if (!this.disposed) this.frame.contentWindow?.postMessage({ channel: 'pdfreader', type: 'selection-toolbar', enabled }, location.origin); }); }
  setHostToolbar(enabled: boolean) { void this.ready.then(() => { if (!this.disposed) this.frame.contentWindow?.postMessage({ channel: 'pdfreader', type: 'host-ui', enabled }, location.origin); }); }
  action(action: ReaderAction) { return this.request<ReaderState>('action', { action }); }
  private send(type: string, extra = {}) { this.frame.contentWindow?.postMessage({ channel: 'pdfreader', type, documentId: this.documentId, ...extra }, location.origin); }
  dispose() { this.disposed = true; this.rejectPending('阅读器已关闭'); window.removeEventListener('message', this.receive); }
}
