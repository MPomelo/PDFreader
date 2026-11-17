import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Add20Regular, DocumentPdf20Regular, Dismiss20Regular, FolderOpen20Regular, Translate20Regular } from '@fluentui/react-icons';
import { ReaderAdapter, type ReaderEvent, type ReaderState, type ReaderAction } from './reader/ReaderAdapter';
import { DocumentPane, type DocumentTab } from './reader/DocumentPane';
import { adjacentTabId, shortcutTabId } from './reader/tabs';
import { mayLeaveDocument, type LeaveChoice } from './reader/leave-document';
import { TranslationPanel } from './translation/TranslationPanel';
import { LibraryPanel } from './local/LibraryPanel';
import { repository, digest, DEFAULT_READER_PREFERENCES, type Layout, type Note, type Recent, type ReaderPreferences } from './local/repository';
import { ResizeHandle } from './ui/ResizeHandle';
import { DEFAULT_WIDTHS, WIDTHS_KEY, panelLayout, parseWidths } from './ui/panel-widths';
import { SettingsDialog, type SettingsSection } from './ui/SettingsDialog';
import { DocumentToolbar } from './ui/DocumentToolbar';
import './ui/styles.css';
import './ui/stage05.css';
import './ui/workspace.css';

function App() {
  const [tabs, setTabs] = useState<DocumentTab[]>([]), tabsRef = useRef<DocumentTab[]>([]);
  const [activeId, setActiveId] = useState(''), activeRef = useRef('');
  const panes = useRef(new Map<string, ReaderAdapter>());
  const progressTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState<{id: string; name: string} | null>(null);
  const leaveAnswer = useRef<((choice: LeaveChoice) => void) | null>(null);
  const [operation, setOperation] = useState(''), exclusive = useRef(false), openQueue = useRef(Promise.resolve());
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [left, setLeft] = useState(false), [right, setRight] = useState(false), [reading, setReading] = useState(false), [floating, setFloating] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [library, setLibrary] = useState(repository.snapshot), [localReady, setLocalReady] = useState(false);
  const booted = useRef(false);
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_READER_PREFERENCES), prefsRef = useRef(preferences); prefsRef.current = preferences;
  const [automatic, setAutomatic] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false), [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [signals, setSignals] = useState<Record<string,number>>({});
  const [dragging, setDragging] = useState(false), [viewport, setViewport] = useState(window.innerWidth);
  const [preferredWidths, setPreferredWidths] = useState(() => { try { return parseWidths(localStorage.getItem(WIDTHS_KEY)); } catch { return DEFAULT_WIDTHS; } });
  const active = tabs.find(tab => tab.id === activeId) || null, reader = active?.state || null;
  const widths = panelLayout(preferredWidths, viewport, left && !reading, right && !reading && !floating);
  const layout: Layout = { left, right, reading, floating, leftWidth: preferredWidths.left, rightWidth: preferredWidths.right, theme };
  const layoutRef = useRef(layout); layoutRef.current = layout;
  function updateTabs(mutate: (previous: DocumentTab[]) => DocumentTab[]) { const next = mutate(tabsRef.current); tabsRef.current = next; setTabs(next); }
  function activate(id: string, force = false) { if (exclusive.current && !force) return; activeRef.current = id; setActiveId(id); if (layoutRef.current.left) void panes.current.get(id)?.action('hide-navigation').catch(() => {}); }
  function openSettings(section: SettingsSection = 'general') { setSettingsSection(section); setSettingsOpen(true); }
  function applyLayout(value: Layout) { setLeft(value.left); setRight(value.right); setReading(value.reading); setFloating(value.floating); setTheme(value.theme); setPreferredWidths({left: value.leftWidth, right: value.rightWidth}); }
  function resizePanel(side: 'left' | 'right', value: number) { setPreferredWidths(previous => ({ ...previous, [side]: Math.max(side === 'left' ? 160 : 280, Math.min(side === 'left' ? widths.leftMax : widths.rightMax, value)) })); }
  async function changePreferences(value: ReaderPreferences) { setPreferences(value); prefsRef.current = value; try { await repository.savePreferences(value); } catch (error) { setError(String(error)); } }
  async function persist(tab: DocumentTab) { if (tab.state) await repository.progress({ fingerprint: tab.fingerprint, name: tab.name, path: tab.path, page: tab.state.page, zoom: tab.state.zoom || 'auto', time: new Date().toISOString() }); }
  function scheduleProgress(id: string) {
    clearTimeout(progressTimers.current.get(id));
    progressTimers.current.set(id, setTimeout(() => { progressTimers.current.delete(id); const tab = tabsRef.current.find(tab => tab.id === id); if (tab) void persist(tab).catch(() => {}); }, 500));
  }
  async function runOperation<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    if (exclusive.current) return;
    exclusive.current = true; setOperation(label); setError(''); setNotice('');
    try { return await work(); } catch (error) { setError(String(error)); } finally { exclusive.current = false; setOperation(''); }
  }
  function queueOpen(work: () => Promise<void>) {
    openQueue.current = openQueue.current.catch(() => {}).then(async () => {
      while (exclusive.current || !booted.current) await new Promise(resolve => setTimeout(resolve, 50));
      await runOperation('opening', work);
    });
    return openQueue.current;
  }
  async function openData(bytes: Uint8Array, name: string, path = '', expected = '', page?: number): Promise<string> {
    if (new TextDecoder().decode(bytes.slice(0,5)) !== '%PDF-') throw Error(`${name} 不是有效的 PDF`);
    const fingerprint = await digest(bytes);
    if (expected && fingerprint !== expected) throw Error('所选文件内容不匹配，未替换旧记录。');
    const existing = tabsRef.current.find(tab => tab.fingerprint === fingerprint && (path ? tab.path.toLowerCase() === path.toLowerCase() : !tab.path && tab.name === name));
    if (existing) {
      if (path) updateTabs(items => items.map(tab => tab.id === existing.id ? { ...tab, path } : tab));
      activate(existing.id, true);
      if (page && existing.state) await panes.current.get(existing.id)?.restore(page, existing.state.zoom);
      return existing.id;
    }
    const saved = prefsRef.current.restoreProgress ? repository.snapshot.book.recents.find(item => item.fingerprint === fingerprint) : null;
    const id = crypto.randomUUID();
    updateTabs(items => [...items, { id, name, path, fingerprint, bytes, initialPage: page || saved?.page || 1, initialZoom: saved?.zoom || prefsRef.current.defaultZoom, state: null }]);
    activate(id, true); return id;
  }
  async function openPath(path: string, expected = '', page?: number) { const pdf = await invoke<{name: string; path: string; bytes: number[]}>('read_pdf',{path}); return openData(Uint8Array.from(pdf.bytes),pdf.name,pdf.path,expected,page); }
  async function openPaths(paths: string[]) { for (const path of paths) try { await openPath(path); } catch (error) { setError(String(error)); } }
  function fileOpen(files: File[]) { return queueOpen(async () => { for (const file of files) try { await openData(new Uint8Array(await file.arrayBuffer()),file.name); } catch (error) { setError(String(error)); } }); }
  async function choose() {
    if (!isTauri()) { input.current?.click(); return; }
    await runOperation('choosing', async () => { const paths = await invoke<string[]>('choose_pdfs'); await openPaths(paths); });
  }
  async function openRecent(recent: Recent) { await queueOpen(async () => { if (!recent.path || !isTauri()) throw Error('请重新选择同一 PDF，以恢复阅读进度。'); await openPath(await invoke<string>('reopen_pdf',{path:recent.path})); }); }
  async function relocate(recent: Recent) { if (!isTauri()) { input.current?.click(); return; } await runOperation('choosing', async () => { const path = await invoke<string | null>('choose_pdf'); if (path) await openPath(path,recent.fingerprint); }); }
  async function locateNote(note: Note) {
    await queueOpen(async () => {
      const opened = tabsRef.current.find(tab => tab.fingerprint === note.fingerprint);
      if (opened) { activate(opened.id,true); if (opened.state) await panes.current.get(opened.id)?.restore(note.page,opened.state.zoom); return; }
      const recent = repository.snapshot.book.recents.find(item => item.fingerprint === note.fingerprint);
      if (!recent?.path || !isTauri()) throw Error('请先打开这条笔记对应的 PDF。');
      await openPath(await invoke<string>('reopen_pdf',{path:recent.path}),note.fingerprint,note.page);
    });
  }
  function answer(choice: LeaveChoice) { const resolve = leaveAnswer.current; leaveAnswer.current = null; setPrompt(null); resolve?.(choice); }
  async function exportTab(id: string): Promise<boolean> {
    const tab = tabsRef.current.find(tab => tab.id === id), pane = panes.current.get(id);
    if (!tab?.state || !pane) return false;
    setOperation('exporting');
    const { bytes, token } = await pane.export(), suggestedName = tab.name.replace(/\.pdf$/i,'') + '-批注.pdf';
    let destination: string | null;
    if (isTauri()) destination = await invoke<string | null>('export_pdf',{bytes:Array.from(bytes),suggestedName});
    else {
      const picker = (window as any).showSaveFilePicker;
      if (!picker) { const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'application/pdf'})); const link=document.createElement('a');link.href=url;link.download=suggestedName;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);setNotice('已发起下载，尚无法确认文件落盘。');return false; }
      let file;
      try { file=await picker({suggestedName,types:[{description:'PDF',accept:{'application/pdf':['.pdf']}}]}); } catch(error) { if((error as DOMException).name==='AbortError')return false;throw error; }
      const writable=await file.createWritable();try{await writable.write(new Blob([new Uint8Array(bytes)],{type:'application/pdf'}));await writable.close();}catch(error){await writable.abort().catch(()=>{});throw error;}destination=file.name;
    }
    if (!destination) { setNotice('已取消导出，批注仍保留在标签中。'); return false; }
    const state=await pane.markExported(token); updateTabs(items=>items.map(item=>item.id===id?{...item,state}:item)); setNotice('已导出 '+destination); return !state.dirty;
  }
  async function mayClose(tab: DocumentTab) {
    const pane = panes.current.get(tab.id); if (!tab.state || !pane) return true;
    return mayLeaveDocument(() => pane.flush(), () => { activate(tab.id,true);return new Promise<LeaveChoice>(resolve => {leaveAnswer.current=resolve;setPrompt({id:tab.id,name:tab.name});}); }, () => exportTab(tab.id));
  }
  async function closeTab(id: string) {
    await runOperation('closing', async () => { const tab=tabsRef.current.find(tab=>tab.id===id);if(!tab||!await mayClose(tab))return;await persist(tab).catch(()=>{});clearTimeout(progressTimers.current.get(id));progressTimers.current.delete(id);const next=adjacentTabId(tabsRef.current.map(tab=>tab.id),id,activeRef.current);updateTabs(items=>items.filter(item=>item.id!==id));activate(next,true);setSignals(previous=>{const next={...previous};delete next[id];return next;}); });
  }
  async function closeWindow() {
    await runOperation('closing', async () => { for(const tab of [...tabsRef.current]) {if(!await mayClose(tab))return;await persist(tabsRef.current.find(item=>item.id===tab.id)||tab).catch(()=>{});}await repository.saveLayout(layoutRef.current).catch(()=>{});await repository.flush();await invoke('finish_close'); });
  }
  async function action(action: ReaderAction) { const pane=panes.current.get(activeRef.current);if(action==='thumbnails')setLeft(false);try{await pane?.action(action);}catch(error){setError(String(error));} }
  async function position(page: number, zoom?: string) { const tab=tabsRef.current.find(tab=>tab.id===activeRef.current);if(!tab?.state)return;try{await panes.current.get(tab.id)?.restore(page,zoom||tab.state.zoom);}catch(error){setError(String(error));} }
  function register(id: string, pane: ReaderAdapter | null) { if(pane)panes.current.set(id,pane);else panes.current.delete(id); }
  function opened(id: string, state?: ReaderState, error?: string) { updateTabs(items=>items.map(tab=>tab.id===id?{...tab,bytes:undefined,state:state||null,error}:tab));if(state)scheduleProgress(id); }
  function readerEvent(id: string,event: ReaderEvent) {
    const previous=tabsRef.current.find(tab=>tab.id===id);if(!previous)return;
    if(event.type==='state') { updateTabs(items=>items.map(tab=>tab.id===id?{...tab,state:event.state}:tab));if(!previous.bytes&&(previous.state?.page!==event.state.page||previous.state?.zoom!==event.state.zoom))scheduleProgress(id); }
    else if(event.type==='error')setError(previous.name+'：'+event.message);
    else if(event.type==='export-requested')void runOperation('exporting',()=>exportTab(id));
    else void fileOpen([new File([new Uint8Array(event.bytes)],event.filename,{type:'application/pdf'})]);
  }
  function translateFloating() { if(!activeId)return;setReading(false);setFloating(true);setRight(true);setSignals(previous=>({...previous,[activeId]:(previous[activeId]||0)+1})); }
  const handlers = useRef({choose,closeWindow,closeTab,exportTab,openPaths}); handlers.current={choose,closeWindow,closeTab,exportTab,openPaths};
  const modalRef=useRef(false);modalRef.current=settingsOpen||!!prompt;
  useEffect(()=>repository.subscribe(()=>setLibrary(repository.snapshot)),[]);
  useEffect(()=>{const resize=()=>setViewport(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(()=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;},[theme]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(timer);},[notice]);
  useEffect(()=>{try{localStorage.setItem(WIDTHS_KEY,JSON.stringify(preferredWidths));}catch{}},[preferredWidths]);
  useEffect(()=>{if(!localReady)return;const timer=setTimeout(()=>{void repository.saveLayout(layoutRef.current).catch(()=>{});},400);return()=>clearTimeout(timer);},[localReady,left,right,reading,floating,preferredWidths.left,preferredWidths.right,theme]);
  useEffect(()=>{if(prompt&&!dialog.current?.open)dialog.current?.showModal();if(!prompt&&dialog.current?.open)dialog.current?.close();},[prompt]);
  useEffect(()=>{
    let disposed=false;const releases:(()=>void)[]=[];
    const local=repository.init().then(snapshot=>{if(!disposed){applyLayout(snapshot.book.layout);const preferences={...DEFAULT_READER_PREFERENCES,...snapshot.book.preferences};setPreferences(preferences);prefsRef.current=preferences;booted.current=true;setLocalReady(true);}return snapshot;});
    if(isTauri())void(async()=>{
      for(const [name,callback] of [['pdfs-dropped',(event:{payload:string[]})=>{void queueOpen(()=>handlers.current.openPaths(event.payload));}],['pdfs-queued',()=>{void queueOpen(async()=>{const batch=await invoke<{paths:string[];errors:string[]}>('startup_pdfs');if(batch.errors.length)setError(batch.errors.join('\n'));await handlers.current.openPaths(batch.paths);});}],['pdf-open-error',(event:{payload:string})=>setError(event.payload)],['close-requested',()=>{void handlers.current.closeWindow();}]] as const){const release=await listen<any>(name,callback);if(disposed)release();else releases.push(release);}
      try{const snapshot=await local;const batch=await invoke<{paths:string[];errors:string[]}>('startup_pdfs');if(disposed)return;if(batch.errors.length)setError(batch.errors.join('\n'));if(batch.paths.length)await queueOpen(()=>handlers.current.openPaths(batch.paths));else if(prefsRef.current.restoreProgress){const recent=snapshot.book.recents.find(recent=>recent.path);if(recent){const path=await invoke<string>('reopen_pdf',{path:recent.path});await queueOpen(()=>handlers.current.openPaths([path]));}}}catch(error){if(!disposed)setError(String(error));}
    })().catch(error=>{if(!disposed)setError(String(error));});
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape')document.querySelectorAll('.toolbar-menu[open]').forEach(menu=>menu.removeAttribute('open'));
      if(!(event.ctrlKey||event.metaKey))return;
      const value=event.key.toLowerCase();if(modalRef.current){if(value==='w'||value==='tab')event.preventDefault();return;}if(exclusive.current)return;
      if(event.shiftKey&&event.key==='Enter'){event.preventDefault();event.stopImmediatePropagation();const id=activeRef.current;if(id){setReading(false);setFloating(false);setRight(true);setSignals(previous=>({...previous,[id]:(previous[id]||0)+1}));}}
      else if(value==='o'){event.preventDefault();void handlers.current.choose();}
      else if(value==='s'){event.preventDefault();void runOperation('exporting',()=>handlers.current.exportTab(activeRef.current));}
      else if(value==='w'){event.preventDefault();if(activeRef.current)void handlers.current.closeTab(activeRef.current);}
      else if(value==='tab'||/^[1-9]$/.test(value)){event.preventDefault();activate(shortcutTabId(tabsRef.current.map(tab=>tab.id),activeRef.current,value==='tab'?'Tab':value,event.shiftKey));}
    };
    const unload=(event:BeforeUnloadEvent)=>{if(tabsRef.current.some(tab=>tab.state?.dirty)){event.preventDefault();event.returnValue='';}};
    const dismiss=(event:PointerEvent)=>{if(!(event.target as Element).closest('.toolbar-menu'))document.querySelectorAll('.toolbar-menu[open]').forEach(menu=>menu.removeAttribute('open'));};
    window.addEventListener('keydown',key,true);window.addEventListener('beforeunload',unload);document.addEventListener('pointerdown',dismiss);
    return()=>{disposed=true;releases.forEach(release=>release());progressTimers.current.forEach(clearTimeout);window.removeEventListener('keydown',key,true);window.removeEventListener('beforeunload',unload);document.removeEventListener('pointerdown',dismiss);};
  },[]);
  return <div className={'app workspace'+(reading?' reading-mode':'')} onDragOver={event=>{event.preventDefault();setDragging(true);}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragging(false);}} onDrop={event=>{event.preventDefault();setDragging(false);if(!isTauri())void fileOpen([...event.dataTransfer.files]);}}>
    <div className="workspace-tabs"><div className="workspace-brand"><DocumentPdf20Regular /><strong>PDFreader</strong></div><div className="document-tabs" role="tablist" aria-label="PDF 文档">{tabs.map(tab=><div className={'document-tab'+(tab.id===activeId?' selected':'')} key={tab.id}><button id={'document-tab-'+tab.id} role="tab" aria-label={tab.name} aria-controls={'document-pane-'+tab.id} aria-selected={tab.id===activeId} tabIndex={tab.id===activeId?0:-1} title={tab.path||tab.name} onClick={()=>activate(tab.id)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const ids=tabsRef.current.map(tab=>tab.id);const next=event.key==='Home'?ids[0]:event.key==='End'?ids[ids.length-1]:shortcutTabId(ids,tab.id,'Tab',event.key==='ArrowLeft');activate(next);document.getElementById('document-tab-'+next)?.focus();}}}><DocumentPdf20Regular /><span>{tab.name}</span>{tab.state?.dirty&&<span className="dirty-dot" aria-label="有未导出修改" />}</button><button className="close-document" aria-label={'关闭 '+tab.name} title={'关闭 '+tab.name} disabled={!!operation} onClick={()=>{void closeTab(tab.id);}}><Dismiss20Regular /></button></div>)}</div><button className="new-document" aria-label="打开新标签" title="打开 PDF 到新标签 (Ctrl+O)" disabled={!!operation} onClick={()=>{void choose();}}><Add20Regular /></button></div>
    <DocumentToolbar reader={reader} busy={!!operation} left={left} right={right&&!floating&&!!active} reading={reading} onOpen={()=>{void choose();}} onExport={()=>{void runOperation('exporting',()=>exportTab(activeId));}} onLeft={()=>{void action('hide-navigation');setReading(false);setLeft(value=>!value);}} onRight={()=>{setReading(false);if(floating){setFloating(false);setRight(true);}else setRight(value=>!value);}} onReading={()=>{void action('hide-navigation');setReading(value=>!value);}} onSettings={()=>openSettings()} onAction={value=>{void action(value);}} onPosition={(page,zoom)=>{void position(page,zoom);}} onComment={()=>{void panes.current.get(activeId)?.commentSelection().catch(error=>setError(String(error)));}} onComments={()=>{void panes.current.get(activeId)?.showComments().catch(error=>setError(String(error)));}} />
    <input ref={input} type="file" multiple accept="application/pdf,.pdf" hidden onChange={event=>{const files=[...(event.target.files||[])];event.target.value='';if(files.length)void fileOpen(files);}} />
    {error&&<div className="error" role="alert">{error}<button aria-label="关闭错误提示" onClick={()=>setError('')}><Dismiss20Regular /></button></div>}{notice&&<div className="notice" role="status">{notice}<button aria-label="关闭通知" onClick={()=>setNotice('')}><Dismiss20Regular /></button></div>}
    {library.problems.map(problem=><div className="local-problem" role="alert" key={problem.kind+problem.document}><span>{problem.message}</span><button onClick={()=>{void repository.reload();}}>重新载入</button><button onClick={()=>{void repository.recover(problem).then(setNotice).catch(error=>setError(String(error)));}}>备份并恢复</button></div>)}
    <main>
      {left&&!reading&&<div className="panel-shell navigation-shell" style={{width:widths.left}}><ResizeHandle side="left" width={widths.left} max={widths.leftMax} onResize={value=>resizePanel('left',value)} /><LibraryPanel snapshot={library} reader={reader} onNavigate={index=>panes.current.get(activeId)?.navigate(index)} onRecent={recent=>{void openRecent(recent);}} onRelocate={recent=>{void relocate(recent);}} onNote={note=>{void locateNote(note);}} onError={setError} /></div>}
      <section className="reader" aria-label="PDF 阅读区域">{tabs.map(tab=><DocumentPane key={tab.id} tab={tab} active={tab.id===activeId} theme={theme} register={register} onEvent={readerEvent} onOpened={opened} />)}
        {!tabs.length&&<div className="welcome"><DocumentPdf20Regular /><h1>打开文档，开始阅读</h1><p>可同时选择或拖入多个 PDF，在标签间切换。</p><button className="primary" disabled={!!operation} onClick={()=>{void choose();}}><FolderOpen20Regular />打开 PDF</button><span>Ctrl + O 打开 · Ctrl + Tab 切换标签</span><button onClick={()=>{void queueOpen(async()=>{const response=await fetch('/pdfjs/web/compressed.tracemonkey-pldi-09.pdf');if(!response.ok)throw Error('示例文件不可用');await openData(new Uint8Array(await response.arrayBuffer()),'示例论文.pdf');});}}>阅读示例论文</button></div>}
        {reader?.selection&&!operation&&preferences.selectionPopup&&<div className="selection-actions" style={{top:Math.max(8,Math.min((reader.selectionViewport?.y||30)+(reader.selectionViewport?.height||0)+8,window.innerHeight-220)),left:Math.max(8,Math.min(reader.selectionViewport?.x||16,viewport-(left?widths.left:0)-(right&&!floating?widths.right:0)-160))}}><button onMouseDown={event=>event.preventDefault()} onClick={translateFloating}><Translate20Regular />浮窗翻译</button></div>}
      </section>
      <div id="translation-panel" className={'panel-shell translation-shell'+(floating?' floating-translation':'')} hidden={!right||reading||!tabs.length} style={{width:floating?Math.min(480,viewport-32):widths.right}}>{!floating&&<ResizeHandle side="right" width={widths.right} max={widths.rightMax} onResize={value=>resizePanel('right',value)} />}{tabs.map(tab=><div className="tab-translation" key={tab.id} hidden={tab.id!==activeId}><TranslationPanel reader={tab.state} documentKey={tab.fingerprint} documentName={tab.name} active={tab.id===activeId&&!settingsOpen} automatic={automatic} showMetadata={preferences.showMetadata} showOriginal={preferences.showOriginal} translateSignal={signals[tab.id]||0} floating={floating} onPin={()=>{setFloating(false);setRight(true);}} onClose={()=>setRight(false)} visible={tab.id===activeId&&right&&!reading} settingsOpen={false} onSettings={()=>openSettings('translation')} disabled={!!operation||!localReady||settingsOpen} onComment={()=>{}} /></div>)}{!tabs.length&&right&&!reading&&<aside className="translation"><div className="panel-heading"><h2>译文</h2><button aria-label="关闭翻译" onClick={()=>setRight(false)}><Dismiss20Regular /></button></div><p className="hint">打开 PDF 后选择文字翻译。</p></aside>}</div>
    </main>
    <footer><span>{tabs.length?`${tabs.length} 个文档`:'就绪'}{reader?.dirty?' · 有未导出批注':''}</span><span>{reader?`第 ${reader.page} / ${reader.pages} 页`:active?.name||'PDFreader'}</span></footer>
    <SettingsDialog open={settingsOpen} initialSection={settingsSection} onClose={()=>setSettingsOpen(false)} theme={theme} onTheme={setTheme} preferences={preferences} onPreferences={value=>{void changePreferences(value);}} automatic={automatic} onAutomatic={setAutomatic} documentKey={active?.fingerprint||''} />
    <dialog ref={dialog} className="unsaved-dialog" aria-labelledby="unsaved-title" onCancel={event=>{event.preventDefault();answer('cancel');}}><h2 id="unsaved-title">有尚未导出的修改</h2><p>是否先导出“{prompt?.name}”的批注？</p><div className="dialog-actions"><button onClick={()=>answer('discard')}>放弃修改</button><button autoFocus onClick={()=>answer('cancel')}>取消</button><button className="primary" onClick={()=>answer('save')}>保存并继续</button></div></dialog>
    {dragging&&!isTauri()&&<div className="drop-target">松开以在新标签打开 PDF</div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
