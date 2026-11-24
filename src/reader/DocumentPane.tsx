import { useEffect, useRef } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ReaderAdapter, type NativePageLayout, type ReaderEvent, type ReaderState } from './ReaderAdapter';
import type { Accent, ColorScheme } from '../ui/appearance';
export type PdfTab = { kind: 'pdf'; id: string; name: string; path: string; fingerprint: string; bytes?: Uint8Array; initialPage: number; initialZoom: string; state: ReaderState | null; error?: string };
export function DocumentPane({ tab, active, theme, accent, selectionToolbar, register, onEvent, onOpened }: { tab: PdfTab; active: boolean; theme: ColorScheme; accent: Accent; selectionToolbar: boolean; register: (id: string, adapter: ReaderAdapter | null) => void; onEvent: (id: string, event: ReaderEvent) => void; onOpened: (id: string, state?: ReaderState, error?: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null), adapter = useRef<ReaderAdapter | null>(null);
  const events = useRef(onEvent), opened = useRef(onOpened); events.current = onEvent; opened.current = onOpened;
  useEffect(() => {
    let disposed = false;
    const nativeLayout = tab.path && isTauri() ? async (page: number) =>
      invoke<NativePageLayout | null>('native_page_layout', { path: tab.path, fingerprint: tab.fingerprint, page }) : undefined;
    const reader = new ReaderAdapter(frame.current!, event => events.current(tab.id, event), nativeLayout);
    adapter.current = reader; register(tab.id, reader);
    reader.setHostToolbar(true);
    void (async () => {
      try {
        if (!tab.bytes) throw Error('文档数据不可用，请重新打开');
        const state = await reader.open(tab.bytes, tab.name);
        const restored = await reader.restore(Math.min(tab.initialPage, state.pages), tab.initialZoom);
        if (!disposed) opened.current(tab.id, restored);
      } catch (error) { if (!disposed) opened.current(tab.id, undefined, String(error)); }
    })();
    return () => { disposed = true; register(tab.id, null); reader.dispose(); };
  }, []);
  useEffect(() => { adapter.current?.setTheme(theme, accent); }, [theme, accent]);
  useEffect(() => { adapter.current?.setSelectionToolbar(selectionToolbar); }, [selectionToolbar]);
  return <div id={'document-pane-' + tab.id} className="document-pane" data-active={active} role="tabpanel" aria-labelledby={'document-tab-' + tab.id} aria-hidden={!active} inert={!active}>
    <iframe ref={frame} title={'PDF · ' + tab.name} src="/pdfjs/web/viewer.html?file=" />
    {!tab.state && !tab.error && <div className="loading" role="status">正在打开 {tab.name}…</div>}
    {tab.error && <div className="document-error" role="alert"><h2>文档无法打开</h2><p>{tab.error}</p><p>可关闭此标签后重试，其他标签不受影响。</p></div>}
  </div>;
}
