import { useEffect, useRef } from 'react';
import { ReaderAdapter, type ReaderEvent, type ReaderState } from './ReaderAdapter';
export type DocumentTab = { id: string; name: string; path: string; fingerprint: string; bytes?: Uint8Array; initialPage: number; initialZoom: string; state: ReaderState | null; error?: string };
export function DocumentPane({ tab, active, theme, register, onEvent, onOpened }: { tab: DocumentTab; active: boolean; theme: 'light' | 'dark'; register: (id: string, adapter: ReaderAdapter | null) => void; onEvent: (id: string, event: ReaderEvent) => void; onOpened: (id: string, state?: ReaderState, error?: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null), adapter = useRef<ReaderAdapter | null>(null);
  const events = useRef(onEvent), opened = useRef(onOpened); events.current = onEvent; opened.current = onOpened;
  useEffect(() => {
    let disposed = false;
    const reader = new ReaderAdapter(frame.current!, event => events.current(tab.id, event)); adapter.current = reader; register(tab.id, reader);
    reader.setTheme(theme); reader.setHostToolbar(true);
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
  useEffect(() => { adapter.current?.setTheme(theme); }, [theme]);
  return <div id={'document-pane-' + tab.id} className="document-pane" data-active={active} role="tabpanel" aria-labelledby={'document-tab-' + tab.id} aria-hidden={!active} inert={!active}>
    <iframe ref={frame} title={'PDF · ' + tab.name} src="/pdfjs/web/viewer.html?file=" />
    {!tab.state && !tab.error && <div className="loading" role="status">正在打开 {tab.name}…</div>}
    {tab.error && <div className="document-error" role="alert"><h2>文档无法打开</h2><p>{tab.error}</p><p>可关闭此标签后重试，其他标签不受影响。</p></div>}
  </div>;
}
