import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Add20Regular, DocumentPdf20Regular, DocumentText20Regular, Dismiss20Regular, FolderOpen20Regular } from '@fluentui/react-icons';
import { ReaderAdapter, type ReaderEvent, type ReaderState, type ReaderAction } from './reader/ReaderAdapter';
import { DocumentPane, type PdfTab } from './reader/DocumentPane';
import { adjacentTabId, shortcutTabId } from './reader/tabs';
import { mayLeaveDocument, type LeaveChoice } from './reader/leave-document';
import { TranslationPanel } from './translation/TranslationPanel';
import { LibraryPanel } from './local/LibraryPanel';
import { repository, digest, DEFAULT_READER_PREFERENCES, type Layout, type Note, type Recent, type ReaderPreferences } from './local/repository';
import { ResizeHandle } from './ui/ResizeHandle';
import { DEFAULT_WIDTHS, WIDTHS_KEY, panelLayout, parseWidths } from './ui/panel-widths';
import { SettingsDialog, type SettingsSection } from './ui/SettingsDialog';
import { DocumentToolbar } from './ui/DocumentToolbar';
import { WindowControls } from './ui/WindowControls';
import { DEFAULT_ACCENT, type Accent, type ColorScheme, type ThemeMode } from './ui/appearance';
import { CitationDialog } from './citation/CitationDialog';
import { TextPane, type TextEditor } from './text/TextPane';
import { TextToolbar } from './text/TextToolbar';
import { EncodingDialog } from './text/EncodingDialog';
import {
  acceptDocuments, chooseTextDestination, documentKind, newTextTab, openedTextTab, openBrowserText, openNativeText,
  saveBrowserText, textDirty, type OpenedText, type TextEncoding, type TextKind, type TextTab,
} from './text/document';
import { imageName, isImage, markdownUrl, readDroppedImage, saveNativeText, storeImage } from './text/attachments';
import './ui/styles.css';
import './ui/stage05.css';
import './ui/workspace.css';

const brandIcon = new URL('../src-tauri/icons/app-icon.svg', import.meta.url).href;
const systemColorScheme = window.matchMedia('(prefers-color-scheme: dark)');

function dismissToolbarMenus() {
  document.querySelectorAll('.toolbar-menu[open]').forEach(menu => menu.removeAttribute('open'));
}

type DocumentTab = PdfTab | TextTab;
function dirty(tab: DocumentTab) {
  return tab.kind === 'pdf' ? Boolean(tab.state?.dirty) : textDirty(tab);
}

function App() {
  const [tabs, setTabs] = useState<DocumentTab[]>([]), tabsRef = useRef<DocumentTab[]>([]);
  const [activeId, setActiveId] = useState(''), activeRef = useRef('');
  const panes = useRef(new Map<string, ReaderAdapter>());
  const editors = useRef(new Map<string, TextEditor>());
  const imageInput = useRef<HTMLInputElement>(null);
  const [encodingFile, setEncodingFile] = useState(''), [encodingError, setEncodingError] = useState('');
  const encodingAnswer = useRef<((value: TextEncoding | null) => void) | null>(null);
  const progressTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState<{id: string; name: string} | null>(null);
  const leaveAnswer = useRef<((choice: LeaveChoice) => void) | null>(null);
  const [operation, setOperation] = useState(''), exclusive = useRef(false), openQueue = useRef(Promise.resolve());
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [left, setLeft] = useState(false), [right, setRight] = useState(false), [reading, setReading] = useState(false), [floating, setFloating] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>('system');
  const [systemTheme, setSystemTheme] = useState<ColorScheme>(() => systemColorScheme.matches ? 'dark' : 'light');
  const [accent, setAccent] = useState<Accent>(DEFAULT_ACCENT);
  const colorScheme = theme === 'system' ? systemTheme : theme;
  const [library, setLibrary] = useState(repository.snapshot), [localReady, setLocalReady] = useState(false);
  const booted = useRef(false);
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_READER_PREFERENCES), prefsRef = useRef(preferences); prefsRef.current = preferences;
  const [automatic, setAutomatic] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false), [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [citationId, setCitationId] = useState('');
  const [signals, setSignals] = useState<Record<string,number>>({});
  const [dragging, setDragging] = useState(false), [viewport, setViewport] = useState(window.innerWidth);
  const [preferredWidths, setPreferredWidths] = useState(() => { try { return parseWidths(localStorage.getItem(WIDTHS_KEY)); } catch { return DEFAULT_WIDTHS; } });
  const active = tabs.find(tab => tab.id === activeId) || null;
  const reader = active?.kind === 'pdf' ? active.state : null;
  const text = active && active.kind !== 'pdf' ? active : null;
  const citationTab = tabs.find(tab => tab.id === citationId), citationAdapter = panes.current.get(citationId);
  const widths = panelLayout(preferredWidths, viewport, left && !reading, right && !reading && !floating && !text);
  const layout: Layout = { left, right, reading, floating, leftWidth: preferredWidths.left, rightWidth: preferredWidths.right, theme, accent };
  const layoutRef = useRef(layout); layoutRef.current = layout;
  function updateTabs(mutate: (previous: DocumentTab[]) => DocumentTab[]) { const next = mutate(tabsRef.current); tabsRef.current = next; setTabs(next); }
  function patchText(id: string, patch: Partial<TextTab>) {
    updateTabs(items => items.map(tab => tab.id === id && tab.kind !== 'pdf' ? { ...tab, ...patch } : tab));
  }
  function createText(kind: TextKind) {
    if (exclusive.current) return;
    const extension = kind === 'txt' ? '.txt' : '.md';
    let name = '未命名' + extension;
    for (let index = 2; tabsRef.current.some(tab => tab.name === name); index++) name = `未命名-${index}${extension}`;
    const tab = newTextTab(kind, name);
    updateTabs(items => [...items, tab]);
    activate(tab.id);
  }
  function registerText(id: string, editor: TextEditor | null) {
    if (editor) editors.current.set(id, editor);
    else editors.current.delete(id);
  }
  function editText(id: string, source: string | undefined, position: TextTab['position']) {
    patchText(id, source === undefined ? { position } : { source, position });
  }
  function answerEncoding(value: TextEncoding | null) {
    const resolve = encodingAnswer.current;
    encodingAnswer.current = null;
    setEncodingFile('');
    resolve?.(value);
  }
  function selectEncoding(name: string) {
    return new Promise<TextEncoding | null>(resolve => {
      encodingAnswer.current = resolve;
      setEncodingFile(name);
    });
  }
  function activate(id: string, force = false) {
    if (exclusive.current && !force) return;
    if (id !== activeRef.current) {
      dismissToolbarMenus();
      panes.current.get(activeRef.current)?.dismissSelectionMenu();
    }
    activeRef.current = id;
    setActiveId(id);
    if (layoutRef.current.left) void panes.current.get(id)?.action('hide-navigation').catch(() => {});
  }
  function openSettings(section: SettingsSection = 'general') { dismissToolbarMenus(); panes.current.get(activeRef.current)?.dismissSelectionMenu(); setSettingsSection(section); setSettingsOpen(true); }
  function openCitation(id = activeRef.current) {
    if (exclusive.current || modalRef.current || !panes.current.get(id)?.hasDocument) return;
    dismissToolbarMenus(); panes.current.get(id)?.dismissSelectionMenu(); setCitationId(id);
  }
  function applyLayout(value: Layout) { setLeft(value.left); setRight(value.right); setReading(value.reading); setFloating(value.floating); setTheme(value.theme); setAccent(value.accent ?? DEFAULT_ACCENT); setPreferredWidths({left: value.leftWidth, right: value.rightWidth}); }
  function resizePanel(side: 'left' | 'right', value: number) { setPreferredWidths(previous => ({ ...previous, [side]: Math.max(side === 'left' ? 160 : 280, Math.min(side === 'left' ? widths.leftMax : widths.rightMax, value)) })); }
  async function changePreferences(value: ReaderPreferences) { setPreferences(value); prefsRef.current = value; try { await repository.savePreferences(value); } catch (error) { setError(String(error)); } }
  async function persist(tab: DocumentTab) { if (tab.kind === 'pdf' && tab.state) await repository.progress({ fingerprint: tab.fingerprint, name: tab.name, path: tab.path, page: tab.state.page, zoom: tab.state.zoom || 'auto', time: new Date().toISOString() }); }
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
    const existing = tabsRef.current.find((tab): tab is PdfTab => tab.kind === 'pdf' && tab.fingerprint === fingerprint && (path ? tab.path.toLowerCase() === path.toLowerCase() : !tab.path && tab.name === name));
    if (existing) {
      if (path) updateTabs(items => items.map(tab => tab.id === existing.id ? { ...tab, path } : tab));
      activate(existing.id, true);
      if (page && existing.state) await panes.current.get(existing.id)?.restore(page, existing.state.zoom);
      return existing.id;
    }
    const saved = prefsRef.current.restoreProgress ? repository.snapshot.book.recents.find(item => item.fingerprint === fingerprint) : null;
    const id = crypto.randomUUID();
    updateTabs(items => [...items, { kind: 'pdf', id, name, path, fingerprint, bytes, initialPage: page || saved?.page || 1, initialZoom: saved?.zoom || prefsRef.current.defaultZoom, state: null }]);
    activate(id, true); return id;
  }
  async function openText(kind: TextKind, load: (encoding?: TextEncoding) => Promise<OpenedText>) {
    let file = await load();
    setEncodingError('');
    const existing = tabsRef.current.find(tab => tab.kind !== 'pdf' && file.path && tab.path.toLowerCase() === file.path.toLowerCase());
    if (existing) { activate(existing.id, true); return existing.id; }
    while (file.content === null) {
      const encoding = await selectEncoding(file.name);
      if (!encoding) return '';
      try { file = await load(encoding); }
      catch (error) { setEncodingError(String(error)); }
    }
    const tab = openedTextTab(kind, file);
    updateTabs(items => [...items, tab]);
    activate(tab.id, true);
    return tab.id;
  }
  async function openPath(path: string, expected = '', page?: number) {
    const kind = documentKind(path);
    if (!kind) throw Error('请选择 PDF、Markdown 或 TXT 文件');
    if (kind !== 'pdf') {
      if (expected) throw Error('请选择匹配的 PDF 文件');
      return openText(kind, encoding => openNativeText(path, encoding));
    }
    const pdf = await invoke<{ name: string; path: string; bytes: number[] }>('read_pdf', { path });
    return openData(Uint8Array.from(pdf.bytes), pdf.name, pdf.path, expected, page);
  }
  async function openPaths(paths: string[]) { for (const path of paths) try { await openPath(path); } catch (error) { setError(String(error)); } }
  function fileOpen(files: File[]) {
    return queueOpen(async () => {
      for (const file of files) try {
        const kind = documentKind(file.name);
        if (kind === 'pdf') await openData(new Uint8Array(await file.arrayBuffer()), file.name);
        else if (kind) await openText(kind, encoding => openBrowserText(file, encoding));
        else throw Error(`不支持此文档格式：${file.name}`);
      } catch (error) { setError(String(error)); }
    });
  }
  async function choose() {
    if (!isTauri()) { input.current?.click(); return; }
    await runOperation('choosing', async () => { const paths = await invoke<string[]>('choose_documents'); await openPaths(paths); });
  }
  async function openRecent(recent: Recent) { await queueOpen(async () => { if (!recent.path || !isTauri()) throw Error('请重新选择同一 PDF，以恢复阅读进度。'); await openPath(await invoke<string>('reopen_pdf',{path:recent.path})); }); }
  async function relocate(recent: Recent) { if (!isTauri()) { input.current?.click(); return; } await runOperation('choosing', async () => { const path = await invoke<string | null>('choose_pdf'); if (path) await openPath(path,recent.fingerprint); }); }
  async function locateNote(note: Note) {
    await queueOpen(async () => {
      const opened = tabsRef.current.find((tab): tab is PdfTab => tab.kind === 'pdf' && tab.fingerprint === note.fingerprint);
      if (opened) { activate(opened.id,true); if (opened.state) await panes.current.get(opened.id)?.restore(note.page,opened.state.zoom); return; }
      const recent = repository.snapshot.book.recents.find(item => item.fingerprint === note.fingerprint);
      if (!recent?.path || !isTauri()) throw Error('请先打开这条笔记对应的 PDF。');
      await openPath(await invoke<string>('reopen_pdf',{path:recent.path}),note.fingerprint,note.page);
    });
  }
  function answer(choice: LeaveChoice) { const resolve = leaveAnswer.current; leaveAnswer.current = null; setPrompt(null); resolve?.(choice); }
  async function exportTab(id: string): Promise<boolean> {
    const tab = tabsRef.current.find(tab => tab.id === id), pane = panes.current.get(id);
    if (tab?.kind !== 'pdf' || !tab.state || !pane) return false;
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
    const state=await pane.markExported(token); updateTabs(items=>items.map(item=>item.id===id&&item.kind==='pdf'?{...item,state}:item)); setNotice('已导出 '+destination); return !state.dirty;
  }
  async function saveTab(id: string, saveAs = false): Promise<boolean> {
    const tab = tabsRef.current.find(tab => tab.id === id);
    if (!tab) return false;
    if (tab.kind === 'pdf') return exportTab(id);
    if (!saveAs && (tab.path || tab.handle) && !textDirty(tab)) return true;
    setOperation('saving');
    if (isTauri()) {
      const destination = saveAs || !tab.path ? await chooseTextDestination(tab) : { path: tab.path, revision: tab.revision };
      if (!destination) return false;
      if (tabsRef.current.some(item => item.id !== id && item.path && item.path.toLowerCase() === destination.path.toLowerCase())) {
        throw Error('目标文件已在另一个标签中打开，请选择其他文件。');
      }
      if (destination.path.toLowerCase() === tab.path.toLowerCase()) destination.revision = tab.revision;
      const saved = await saveNativeText(tab, destination);
      editors.current.get(id)?.apply(saved.changes);
      const current = tabsRef.current.find((item): item is TextTab => item.id === id && item.kind !== 'pdf');
      patchText(id, { ...saved.tab, position: current?.position ?? tab.position });
      setNotice('已保存 ' + saved.tab.name);
    } else {
      const saved = await saveBrowserText(tab, saveAs);
      if (!saved) return false;
      patchText(id, saved);
      setNotice('已保存 ' + saved.name);
    }
    return true;
  }
  function insertImages(id: string, files: File[], position?: number) {
    return insertImageBatch(id, async () => files, position);
  }
  async function insertImageBatch(id: string, makeFiles: () => Promise<File[]>, position?: number) {
    const tab = tabsRef.current.find(tab => tab.id === id);
    const editor = editors.current.get(id);
    if (tab?.kind !== 'markdown' || !editor || !isTauri()) return;
    const untrack = position === undefined ? undefined : editor.track(position);
    try {
      await runOperation('attaching', async () => {
        const files = await makeFiles();
        if (tab.mode === 'preview') patchText(id, { mode: 'split' });
        let nextPosition = untrack?.();
        for (const file of files) {
          const name = imageName(file);
          if (!file.size || file.size > 16 * 1024 * 1024) throw Error('图片为空或超过 16 MiB。');
          let path: string;
          if (tab.path) {
            path = tab.assetsDir + '/' + await storeImage(tab, file);
          } else {
            path = '.pdfreader-staged/' + crypto.randomUUID() + '/' + name;
            const current = tabsRef.current.find(item => item.id === id);
            if (current?.kind !== 'markdown') return;
            patchText(id, { staged: { ...current.staged, [path]: file } });
          }
          const label = name.replace(/\.[^.]+$/, '').replace(/[\[\]]/g, '\$&');
          const link = `![${label}](${markdownUrl(path)})`;
          editor.insert(link, nextPosition);
          if (nextPosition !== undefined) nextPosition += link.length;
        }
      });
    } finally { untrack?.(); }
  }
  async function mayClose(tab: DocumentTab) {
    const pane = panes.current.get(tab.id);
    if (tab.kind === 'pdf' && (!tab.state || !pane)) return true;
    return mayLeaveDocument(
      () => tab.kind === 'pdf' ? pane!.flush() : Promise.resolve({ dirty: textDirty(tab) }),
      () => {
        activate(tab.id, true);
        return new Promise<LeaveChoice>(resolve => { leaveAnswer.current = resolve; setPrompt({ id: tab.id, name: tab.name }); });
      },
      () => saveTab(tab.id),
    );
  }
  async function closeTab(id: string) {
    await runOperation('closing', async () => { const tab=tabsRef.current.find(tab=>tab.id===id);if(!tab||!await mayClose(tab))return;await persist(tab).catch(()=>{});clearTimeout(progressTimers.current.get(id));progressTimers.current.delete(id);const next=adjacentTabId(tabsRef.current.map(tab=>tab.id),id,activeRef.current);updateTabs(items=>items.filter(item=>item.id!==id));activate(next,true);setSignals(previous=>{const next={...previous};delete next[id];return next;}); });
  }
  async function closeWindow() {
    await runOperation('closing', async () => { for(const tab of [...tabsRef.current]) {if(!await mayClose(tab))return;await persist(tabsRef.current.find(item=>item.id===tab.id)||tab).catch(()=>{});}await repository.saveLayout(layoutRef.current).catch(()=>{});await repository.flush();await invoke('finish_close'); });
  }
  async function action(action: ReaderAction) { const pane=panes.current.get(activeRef.current);if(action==='thumbnails')setLeft(false);try{await pane?.action(action);}catch(error){setError(String(error));} }
  async function position(page: number, zoom?: string) { const tab=tabsRef.current.find(tab=>tab.id===activeRef.current);if(tab?.kind!=='pdf'||!tab.state)return;try{await panes.current.get(tab.id)?.restore(page,zoom||tab.state.zoom);}catch(error){setError(String(error));} }
  function register(id: string, pane: ReaderAdapter | null) { if(pane)panes.current.set(id,pane);else panes.current.delete(id); }
  function opened(id: string, state?: ReaderState, error?: string) { updateTabs(items=>items.map(tab=>tab.id===id&&tab.kind==='pdf'?{...tab,bytes:undefined,state:state||null,error}:tab));if(state)scheduleProgress(id); }
  function readerEvent(id: string,event: ReaderEvent) {
    const previous=tabsRef.current.find(tab=>tab.id===id);if(previous?.kind!=='pdf')return;
    if(event.type==='state') { updateTabs(items=>items.map(tab=>tab.id===id&&tab.kind==='pdf'?{...tab,state:event.state}:tab));if(!previous.bytes&&(previous.state?.page!==event.state.page||previous.state?.zoom!==event.state.zoom))scheduleProgress(id); }
    else if(event.type==='error')setError(previous.name+'：'+event.message);
    else if(event.type==='export-requested')void runOperation('exporting',()=>exportTab(id));
    else if (event.type==='file-open-requested') void fileOpen([new File([new Uint8Array(event.bytes)],event.filename,{type:'application/pdf'})]);
    else if (id===activeRef.current) {
      if (event.type==='dismiss-menus') dismissToolbarMenus();
      if (event.type==='translate-selection' && !exclusive.current && !modalRef.current) translateFloating(id);
      if (event.type==='selection-copied') setNotice('已复制选区');
      if (event.type==='cite-document') openCitation(id);
    }
  }
  function translateFloating(id = activeRef.current) { if(!id)return;setReading(false);setFloating(true);setRight(true);setSignals(previous=>({...previous,[id]:(previous[id]||0)+1})); }
  const handlers = useRef({ choose, closeWindow, closeTab, saveTab, openPaths, insertImageBatch });
  handlers.current = { choose, closeWindow, closeTab, saveTab, openPaths, insertImageBatch };
  const modalRef=useRef(false);modalRef.current=settingsOpen||!!prompt||!!citationTab||!!encodingFile;
  useEffect(()=>repository.subscribe(()=>setLibrary(repository.snapshot)),[]);
  useEffect(()=>{const resize=()=>setViewport(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(() => {
    const change = () => setSystemTheme(systemColorScheme.matches ? 'dark' : 'light');
    systemColorScheme.addEventListener('change', change);
    change();
    return () => systemColorScheme.removeEventListener('change', change);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = colorScheme; document.documentElement.dataset.accent = accent; }, [colorScheme, accent]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(timer);},[notice]);
  useEffect(()=>{try{localStorage.setItem(WIDTHS_KEY,JSON.stringify(preferredWidths));}catch{}},[preferredWidths]);
  useEffect(()=>{if(!localReady)return;const timer=setTimeout(()=>{void repository.saveLayout(layoutRef.current).catch(()=>{});},400);return()=>clearTimeout(timer);},[localReady,left,right,reading,floating,preferredWidths.left,preferredWidths.right,theme,accent]);
  useEffect(()=>{if(prompt&&!dialog.current?.open)dialog.current?.showModal();if(!prompt&&dialog.current?.open)dialog.current?.close();},[prompt]);
  useEffect(()=>{
    let disposed=false;const releases:(()=>void)[]=[];
    const local=repository.init().then(snapshot=>{if(!disposed){applyLayout(snapshot.book.layout);const preferences={...DEFAULT_READER_PREFERENCES,...snapshot.book.preferences};setPreferences(preferences);prefsRef.current=preferences;booted.current=true;setLocalReady(true);}return snapshot;});
    if(isTauri())void(async()=>{
      for(const [name,callback] of [['images-dropped', (event: { payload: { paths: string[]; x: number; y: number } }) => {
        const id = activeRef.current;
        const { paths, x, y } = event.payload;
        if (modalRef.current) return;
        if (tabsRef.current.find(tab => tab.id === id)?.kind !== 'markdown') {
          setError('请在 Markdown 标签中拖入图片。');
          return;
        }
        void handlers.current.insertImageBatch(id, () => Promise.all(paths.map(readDroppedImage)), editors.current.get(id)?.atCoordinates(x, y));
      }],['pdfs-dropped',(event:{payload:string[]})=>{void queueOpen(()=>handlers.current.openPaths(event.payload));}],['pdfs-queued',()=>{void queueOpen(async()=>{const batch=await invoke<{paths:string[];errors:string[]}>('startup_pdfs');if(batch.errors.length)setError(batch.errors.join('\n'));await handlers.current.openPaths(batch.paths);});}],['pdf-open-error',(event:{payload:string})=>setError(event.payload)],['close-requested',()=>{void handlers.current.closeWindow();}]] as const){const release=await listen<any>(name,callback);if(disposed)release();else releases.push(release);}
      try{const snapshot=await local;const batch=await invoke<{paths:string[];errors:string[]}>('startup_pdfs');if(disposed)return;if(batch.errors.length)setError(batch.errors.join('\n'));if(batch.paths.length)await queueOpen(()=>handlers.current.openPaths(batch.paths));else if(prefsRef.current.restoreProgress){const recent=snapshot.book.recents.find(recent=>recent.path);if(recent){const path=await invoke<string>('reopen_pdf',{path:recent.path});await queueOpen(()=>handlers.current.openPaths([path]));}}}catch(error){if(!disposed)setError(String(error));}
    })().catch(error=>{if(!disposed)setError(String(error));});
    const key=(event:KeyboardEvent)=>{
      if (event.key === 'Escape') {
        dismissToolbarMenus();
        panes.current.get(activeRef.current)?.dismissLinkPreview();
      }
      if(!(event.ctrlKey||event.metaKey))return;
      const value=event.key.toLowerCase();if(modalRef.current){if(value==='w'||value==='tab')event.preventDefault();return;}if(exclusive.current)return;
      if(event.shiftKey&&event.key==='Enter'&&panes.current.has(activeRef.current)){event.preventDefault();event.stopImmediatePropagation();const id=activeRef.current;if(id){setReading(false);setFloating(false);setRight(true);setSignals(previous=>({...previous,[id]:(previous[id]||0)+1}));}}
      else if(value==='o'){event.preventDefault();void handlers.current.choose();}
      else if(value==='s'){event.preventDefault();void runOperation('saving',()=>handlers.current.saveTab(activeRef.current, event.shiftKey));}
      else if(value==='f'&&editors.current.has(activeRef.current)){event.preventDefault();editors.current.get(activeRef.current)?.find();}
      else if(value==='w'){event.preventDefault();if(activeRef.current)void handlers.current.closeTab(activeRef.current);}
      else if((value==='z'||value==='y')&&!event.altKey&&activeRef.current&&!(event.target instanceof Element&&event.target.closest('input,textarea,[contenteditable=true]'))){event.preventDefault();
        const command = value==='y'||event.shiftKey?'redo':'undo', editor = editors.current.get(activeRef.current);
        if (editor) editor[command]();
        else void action(command);}
      else if(value==='tab'||/^[1-9]$/.test(value)){event.preventDefault();activate(shortcutTabId(tabsRef.current.map(tab=>tab.id),activeRef.current,value==='tab'?'Tab':value,event.shiftKey));}
    };
    const unload=(event:BeforeUnloadEvent)=>{if(tabsRef.current.some(dirty)){event.preventDefault();event.returnValue='';}};
    const dismiss=(event:PointerEvent)=>{if(!(event.target as Element).closest('.toolbar-menu'))dismissToolbarMenus();};
    window.addEventListener('keydown',key,true);window.addEventListener('beforeunload',unload);document.addEventListener('pointerdown',dismiss);
    return()=>{disposed=true;releases.forEach(release=>release());progressTimers.current.forEach(clearTimeout);window.removeEventListener('keydown',key,true);window.removeEventListener('beforeunload',unload);document.removeEventListener('pointerdown',dismiss);};
  },[]);
  return <div className={'app workspace'+(reading?' reading-mode':'')} onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){if(!isTauri()) setDragging(true);event.preventDefault();}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragging(false);}} onDrop={event=>{const handled = event.defaultPrevented;event.preventDefault();setDragging(false);if(!handled&&!isTauri())void fileOpen([...event.dataTransfer.files]);}}
    onPaste={event => {
      if (event.defaultPrevented || modalRef.current || text?.kind !== 'markdown' || !isTauri()) return;
      const files = [...event.clipboardData.files].filter(isImage);
      if (files.length) { event.preventDefault(); void insertImages(text.id, files); }
    }}>
    <div className="workspace-tabs"><div className="workspace-brand" data-tauri-drag-region><img src={brandIcon} width={24} height={24} alt="" /><strong>PDFreader</strong></div><div className="document-tabs" role="tablist" aria-label="文档标签">{tabs.map(tab=><div className={'document-tab'+(tab.id===activeId?' selected':'')} key={tab.id}><button id={'document-tab-'+tab.id} role="tab" aria-label={tab.name} aria-controls={'document-pane-'+tab.id} aria-selected={tab.id===activeId} tabIndex={tab.id===activeId?0:-1} title={tab.path||tab.name} onClick={()=>activate(tab.id)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const ids=tabsRef.current.map(tab=>tab.id);const next=event.key==='Home'?ids[0]:event.key==='End'?ids[ids.length-1]:shortcutTabId(ids,tab.id,'Tab',event.key==='ArrowLeft');activate(next);document.getElementById('document-tab-'+next)?.focus();}}}>{tab.kind === 'pdf' ? <DocumentPdf20Regular /> : <DocumentText20Regular />}<span>{tab.name}</span>{dirty(tab)&&<span className="dirty-dot" aria-label={tab.kind === 'pdf' ? '有未导出修改' : '有未保存修改'} />}</button><button className="close-document" aria-label={'关闭 '+tab.name} title={'关闭 '+tab.name} disabled={!!operation} onClick={()=>{void closeTab(tab.id);}}><Dismiss20Regular /></button></div>)}</div><details className="toolbar-menu new-document">
      <summary role="button" aria-label="新建或打开文档" title="新建或打开文档"><Add20Regular /></summary>
      <div className="command-menu" onClick={event => { if ((event.target as Element).closest('button')) event.currentTarget.parentElement?.removeAttribute('open'); }}>
        <button disabled={!!operation} onClick={()=>{void choose();}}>打开文档</button>
        <button disabled={!!operation} onClick={()=>createText('markdown')}>新建 Markdown</button>
        <button disabled={!!operation} onClick={()=>createText('txt')}>新建 TXT</button>
      </div>
    </details><div className="workspace-drag" data-tauri-drag-region aria-hidden="true" />{isTauri()&&<WindowControls busy={!!operation||!localReady} onClose={()=>{void closeWindow();}} onError={setError} />}</div>
    {text ? <TextToolbar tab={text} busy={!!operation} attachments={isTauri()} onOpen={()=>{void choose();}}
      onSave={saveAs=>{void runOperation('saving',()=>saveTab(text.id,saveAs));}}
      onFind={()=>editors.current.get(text.id)?.find()} onUndo={()=>editors.current.get(text.id)?.undo()}
      onRedo={()=>editors.current.get(text.id)?.redo()} onWrap={()=>patchText(text.id,{wrap:!text.wrap})}
      onMode={mode=>patchText(text.id,{mode})} onImage={()=>imageInput.current?.click()}
      onUtf8={()=>patchText(text.id,{encoding:'UTF-8',bom:false})} onSettings={()=>openSettings()} />
      : <DocumentToolbar reader={reader} findAdapter={panes.current.get(activeId)} findModal={settingsOpen||!!prompt||!!citationTab} busy={!!operation} left={left} right={right&&!floating&&!!active} reading={reading} onOpen={()=>{void choose();}} onExport={()=>{void runOperation('exporting',()=>exportTab(activeId));}} onLeft={()=>{void action('hide-navigation');setReading(false);setLeft(value=>!value);}} onRight={()=>{setReading(false);if(floating){setFloating(false);setRight(true);}else setRight(value=>!value);}} onReading={()=>{void action('hide-navigation');setReading(value=>!value);}} onSettings={()=>openSettings()} onCitation={()=>openCitation()} onAction={value=>{void action(value);}} onPosition={(page,zoom)=>{void position(page,zoom);}} onComment={()=>{void panes.current.get(activeId)?.commentSelection().catch(error=>setError(String(error)));}} onComments={()=>{void panes.current.get(activeId)?.showComments().catch(error=>setError(String(error)));}} />}
    <input ref={input} type="file" multiple accept={acceptDocuments} hidden onChange={event=>{const files=[...(event.target.files||[])];event.target.value='';if(files.length)void fileOpen(files);}} />
    {text?.kind === 'markdown' && isTauri() && <input ref={imageInput} type="file" multiple accept="image/*,.svg,.avif,.ico" hidden onChange={event=>{
      const files = [...(event.target.files ?? [])]; event.target.value = '';
      if (files.length) void insertImages(text.id, files);
    }} />}
    {error&&<div className="error" role="alert">{error}<button aria-label="关闭错误提示" onClick={()=>setError('')}><Dismiss20Regular /></button></div>}{notice&&<div className="notice" role="status">{notice}<button aria-label="关闭通知" onClick={()=>setNotice('')}><Dismiss20Regular /></button></div>}
    {library.problems.map(problem=><div className="local-problem" role="alert" key={problem.kind+problem.document}><span>{problem.message}</span><button onClick={()=>{void repository.reload();}}>重新载入</button><button onClick={()=>{void repository.recover(problem).then(setNotice).catch(error=>setError(String(error)));}}>备份并恢复</button></div>)}
    <main>
      {left&&!reading&&<div className="panel-shell navigation-shell" style={{width:widths.left}}><ResizeHandle side="left" width={widths.left} max={widths.leftMax} onResize={value=>resizePanel('left',value)} /><LibraryPanel snapshot={library} reader={reader} onNavigate={index=>panes.current.get(activeId)?.navigate(index)} onRecent={recent=>{void openRecent(recent);}} onRelocate={recent=>{void relocate(recent);}} onNote={note=>{void locateNote(note);}} onError={setError} /></div>}
      <section className="reader" aria-label="文档内容">{tabs.map(tab=>tab.kind==='pdf' ? <DocumentPane key={tab.id} tab={tab} active={tab.id===activeId} linkPreviewActive={tab.id===activeId&&!modalRef.current&&!operation} theme={colorScheme} accent={accent} selectionToolbar={preferences.selectionPopup} register={register} onEvent={readerEvent} onOpened={opened} />
        : <TextPane key={tab.id} tab={tab} active={tab.id===activeId} busy={!!operation} register={registerText} onEdit={editText}
          onMode={(id,mode)=>patchText(id,{mode})} onImages={(id,files,position)=>{void insertImages(id,files,position);}}
          onCopy={setNotice} onError={setError} />)}
        {!tabs.length&&<div className="welcome"><DocumentPdf20Regular /><h1>打开文档</h1><p>选择或拖入 PDF、Markdown 和 TXT 文件。</p><button className="primary" disabled={!!operation} onClick={()=>{void choose();}}><FolderOpen20Regular />打开文档</button><span>Ctrl + O 打开 · Ctrl + Tab 切换标签</span><button onClick={()=>{void queueOpen(async()=>{const response=await fetch('/pdfjs/web/compressed.tracemonkey-pldi-09.pdf');if(!response.ok)throw Error('示例文件不可用');await openData(new Uint8Array(await response.arrayBuffer()),'示例论文.pdf');});}}>阅读示例论文</button></div>}
      </section>
      <div id="translation-panel" className={'panel-shell translation-shell'+(floating?' floating-translation':'')} hidden={!right||reading||!reader} style={{width:floating?Math.min(480,viewport-32):widths.right}}>{!floating&&<ResizeHandle side="right" width={widths.right} max={widths.rightMax} onResize={value=>resizePanel('right',value)} />}{tabs.filter((tab): tab is PdfTab => tab.kind==='pdf').map(tab=><div className="tab-translation" key={tab.id} hidden={tab.id!==activeId} style={{'--translation-font-size': preferences.translationFontSize+'px'} as CSSProperties}><TranslationPanel reader={tab.state} documentKey={tab.fingerprint} documentName={tab.name} active={tab.id===activeId&&!settingsOpen} automatic={automatic} showMetadata={preferences.showMetadata} showOriginal={preferences.showOriginal} translateSignal={signals[tab.id]||0} floating={floating} onPin={()=>{setFloating(false);setRight(true);}} onClose={()=>setRight(false)} visible={tab.id===activeId&&right&&!reading} settingsOpen={false} onSettings={()=>openSettings('translation')} disabled={!!operation||!localReady||settingsOpen} onComment={()=>{}} /></div>)}{!tabs.length&&right&&!reading&&<aside className="translation"><div className="panel-heading"><h2>译文</h2><button aria-label="关闭翻译" onClick={()=>setRight(false)}><Dismiss20Regular /></button></div><p className="hint">打开 PDF 后选择文字翻译。</p></aside>}</div>
    </main>
    <footer><span>{tabs.length?`${tabs.length} 个文档`:'就绪'}{reader?.dirty?' · 有未导出批注':text&&textDirty(text)?' · 有未保存修改':''}</span><span>{reader?`第 ${reader.page} / ${reader.pages} 页`:text?`第 ${text.position.line} 行，第 ${text.position.column} 列 · ${text.encoding}${text.bom?' BOM':''} · ${text.eol==='\r\n'?'CRLF':text.eol==='\r'?'CR':'LF'}`:active?.name||'PDFreader'}</span></footer>
    <SettingsDialog open={settingsOpen} initialSection={settingsSection} onClose={()=>setSettingsOpen(false)} theme={theme} onTheme={setTheme} accent={accent} onAccent={setAccent} preferences={preferences} onPreferences={value=>{void changePreferences(value);}} automatic={automatic} onAutomatic={setAutomatic} documentKey={active?.kind==='pdf'?active.fingerprint:''} />
    {citationTab && citationAdapter && <CitationDialog key={citationTab.id} documentName={citationTab.name} adapter={citationAdapter} onClose={() => setCitationId('')} />}
    {encodingFile && <EncodingDialog name={encodingFile} error={encodingError} onAnswer={answerEncoding} />}
    <dialog ref={dialog} className="unsaved-dialog" aria-labelledby="unsaved-title" onCancel={event=>{event.preventDefault();answer('cancel');}}><h2 id="unsaved-title">{text ? '有尚未保存的修改' : '有尚未导出的修改'}</h2>
      <p>{text ? `是否保存“${prompt?.name}”的修改？` : `是否先导出“${prompt?.name}”的批注？`}</p><div className="dialog-actions"><button onClick={()=>answer('discard')}>放弃修改</button><button autoFocus onClick={()=>answer('cancel')}>取消</button><button className="primary" onClick={()=>answer('save')}>保存并继续</button></div></dialog>
    {dragging&&!isTauri()&&<div className="drop-target">松开以在新标签打开文档</div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
