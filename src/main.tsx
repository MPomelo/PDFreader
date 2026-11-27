import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DocumentPdf20Regular, Dismiss20Regular, FolderOpen20Regular, PanelLeft20Regular, Settings20Regular, WindowMultiple20Regular } from '@fluentui/react-icons';
import { ReaderAdapter, type ReaderEvent, type ReaderState, type ReaderAction, type AnnotationWorkspace, type AnnotationDraft, type AnnotationAction } from './reader/ReaderAdapter';
import { DocumentPane, type PdfTab } from './reader/DocumentPane';
import { shortcutTabId } from './reader/tabs';
import { mayLeaveDocument, type LeaveChoice } from './reader/leave-document';
import { LibraryPanel } from './local/LibraryPanel';
import { repository, digest, DEFAULT_READER_PREFERENCES, type Layout, type Note, type Recent, type ReaderPreferences } from './local/repository';
import { ResizeHandle } from './ui/ResizeHandle';
import { DEFAULT_WIDTHS, WIDTHS_KEY, panelLayout, parseWidths } from './ui/panel-widths';
import { SettingsDialog, type SettingsSection } from './ui/SettingsDialog';
import { DocumentToolbar } from './ui/DocumentToolbar';
import { TextBoxToolbar } from './ui/TextBoxToolbar';
import { AnnotationPanel } from './ui/AnnotationPanel';
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
import { WorkspaceSeparator, WorkspaceTabs, type HeaderTab } from './workspace/WorkspaceTabs';
import { columns, columnOf, columnName, defaultWorkspace, move, readWorkspace, remove, saveWorkspace, select, singleTranslation, type Column, type Resource, type Workspace } from './workspace/layout';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';
import { TranslationSource } from './workspace/TranslationSource';
import { WorkspaceTranslation } from './workspace/WorkspaceTranslation';
import { ChatPane, type Material } from './chat/ChatPane';
import { conversationName, type Conversation } from './chat/model';
import './ui/styles.css';
import './ui/stage05.css';
import './ui/workspace.css';
import './ui/annotations.css';

const brandIcon = new URL('../src-tauri/icons/app-icon.svg', import.meta.url).href;
const systemColorScheme = window.matchMedia('(prefers-color-scheme: dark)');

function dismissToolbarMenus() {
  document.querySelectorAll('.toolbar-menu[open]').forEach(menu => menu.removeAttribute('open'));
  document.querySelectorAll<HTMLElement>('.new-document-menu:popover-open').forEach(menu => menu.hidePopover());
}

type DocumentTab = PdfTab | TextTab;
function dirty(tab: DocumentTab) {
  return tab.kind === 'pdf' ? Boolean(tab.state?.dirty) : textDirty(tab);
}

function App() {
  const [tabs, setTabs] = useState<DocumentTab[]>([]), tabsRef = useRef<DocumentTab[]>([]);
  const [activeId, setActiveId] = useState(''), activeRef = useRef('');
  const [workspace, setWorkspace] = useState(defaultWorkspace), workspaceRef = useRef(workspace);
  const [extras, setExtras] = useState<Resource[]>([]), extrasRef = useRef(extras);
  const [missing, setMissing] = useState<Record<string, string>>({});
  const [maximized, setMaximized] = useState<Column | null>(null), maximizedRef = useRef(maximized); maximizedRef.current = maximized;
  const [layoutReady, setLayoutReady] = useState(false), preserveLayout = useRef(false);
  const [translationSignals, setTranslationSignals] = useState<Record<string, { pdf: string; count: number }>>({});
  const [chatMaterials, setChatMaterials] = useState<Record<string, Material[]>>({});
  const chatStops = useRef(new Map<string, () => Promise<void>>());
  const [chatRevisions, setChatRevisions] = useState<Record<string, number>>({});
  const panes = useRef(new Map<string, ReaderAdapter>());
  const editors = useRef(new Map<string, TextEditor>());
  const imageInput = useRef<HTMLInputElement>(null);
  const imageTarget = useRef('');
  const lastPdf = useRef<Record<Column, string>>({ upper: '', lower: '', right: '' });
  const [translationConflict, setTranslationConflict] = useState<{ id: string; to: Column } | null>(null);
  const translationDialog = useRef<HTMLDialogElement>(null);
  const automaticSignature = useRef('');
  const [encodingFile, setEncodingFile] = useState(''), [encodingError, setEncodingError] = useState('');
  const encodingAnswer = useRef<((value: TextEncoding | null) => void) | null>(null);
  const progressTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState<{id: string; name: string} | null>(null);
  const leaveAnswer = useRef<((choice: LeaveChoice) => void) | null>(null);
  const [operation, setOperation] = useState(''), exclusive = useRef(false), openQueue = useRef(Promise.resolve());
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [left, setLeft] = useState(false), [reading, setReading] = useState(false);
  const [navigationId, setNavigationId] = useState('');
  const [annotationTab, setAnnotationTab] = useState('');
  const [annotations, setAnnotations] = useState<Record<string, AnnotationWorkspace>>({});
  const draftValues = useRef(new Map<string, { draft: AnnotationDraft; value: string }>());
  const [, refreshDraft] = useState(0);
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
  const [dragging, setDragging] = useState(false), [viewport, setViewport] = useState(window.innerWidth);
  const [preferredWidths, setPreferredWidths] = useState(() => { try { return parseWidths(localStorage.getItem(WIDTHS_KEY)); } catch { return DEFAULT_WIDTHS; } });
  const active = tabs.find(tab => tab.id === activeId) || null;
  const translation = extras.find(tab => tab.kind === 'translation');
  const pdfs = tabs.filter((tab): tab is PdfTab => tab.kind === 'pdf');
  const navigationPdf = active?.kind === 'pdf' ? active : pdfs.find(tab => tab.id === navigationId) ?? pdfs.find(tab => tab.id === workspace.selected.upper);
  const navigationReader = navigationPdf?.state ?? null;
  const navigationTabId = navigationPdf?.id ?? '';
  const reader = active?.kind === 'pdf' ? active.state : null;
  const text = active && active.kind !== 'pdf' ? active : null;
  const citationTab = tabs.find(tab => tab.id === citationId), citationAdapter = panes.current.get(citationId);
  const widths = panelLayout(preferredWidths, viewport, left && !reading, false);
  const layout: Layout = { left, right: false, reading, floating: false, leftWidth: preferredWidths.left, rightWidth: preferredWidths.right, theme, accent };
  const openColumns = columns.filter(column => !workspace.collapsed[column] && (!maximized || maximized === column));
  const showUpper = openColumns.includes('upper'), showLower = openColumns.includes('lower'), showRight = openColumns.includes('right');
  const layoutRef = useRef(layout); layoutRef.current = layout;
  function updateTabs(mutate: (previous: DocumentTab[]) => DocumentTab[]) { const next = mutate(tabsRef.current); tabsRef.current = next; setTabs(next); }
  function updateWorkspace(next: Workspace) {
    workspaceRef.current = next;
    for (const column of columns) {
      if (tabsRef.current.some(tab => tab.kind === 'pdf' && tab.id === next.selected[column])) lastPdf.current[column] = next.selected[column];
    }
    setWorkspace(next);
    const id = next.selected[next.focus];
    if (activeRef.current !== id) {
      dismissToolbarMenus();
      panes.current.get(activeRef.current)?.dismissSelectionMenu();
    }
    activeRef.current = id;
    setActiveId(id);
  }
  function focusColumn(column: Column, force = false) {
    if (exclusive.current && !force) return;
    if (maximizedRef.current && maximizedRef.current !== column) setMaximized(null);
    updateWorkspace(select(workspaceRef.current, column));
  }
  function moveTab(id: string, column: Column, before?: string) {
    if (exclusive.current || !columnOf(workspaceRef.current, id)) return;
    if (maximizedRef.current && maximizedRef.current !== column) setMaximized(null);
    updateWorkspace(move(workspaceRef.current, id, column, before));
  }
  function collapseColumn(column: Column) {
    const current = workspaceRef.current;
    const next = { ...current, collapsed: { ...current.collapsed, [column]: true } };
    if (maximizedRef.current === column) setMaximized(null);
    updateWorkspace(current.focus === column ? select(next, columns.find(item => !next.collapsed[item]) ?? 'upper') : next);
  }
  function resetWorkspace() {
    preserveLayout.current = false;
    setMaximized(null);
    const defaults = defaultWorkspace();
    updateWorkspace({ ...workspaceRef.current, lowerShare: defaults.lowerShare, rightShare: defaults.rightShare });
  }
  function updateExtras(next: Resource[]) { extrasRef.current = next; setExtras(next); }
  function resolveTranslationSource(source = 'upper', layout = workspaceRef.current) {
    const column = columns.find(item => item === source);
    const pdfIds = new Set(tabsRef.current.filter(tab => tab.kind === 'pdf').map(tab => tab.id));
    if (!column) return pdfIds.has(source) ? source : '';
    const candidates = [layout.selected[column], lastPdf.current[column], ...layout.order[column].slice().reverse()];
    return candidates.find(id => layout.order[column].includes(id) && pdfIds.has(id)) ?? '';
  }
  function setTranslationSource(id: string, source: string) {
    updateExtras(extrasRef.current.map(tab => tab.id === id ? { ...tab, source } : tab));
  }
  function newTranslation(column: Column) {
    const existing = extrasRef.current.find(tab => tab.kind === 'translation');
    if (existing) {
      if (columnOf(workspaceRef.current, existing.id) === column) activate(existing.id);
      else setTranslationConflict({ id: existing.id, to: column });
    } else {
      const focused = workspaceRef.current.focus;
      const source = resolveTranslationSource('upper') ? 'upper' : columns.find(item => item !== column && resolveTranslationSource(item)) ?? focused;
      addFeature('translation', column, source);
    }
  }
  function answerTranslationConflict(choice: 'move' | 'locate' | 'cancel') {
    if (!translationConflict) return;
    const { id, to } = translationConflict;
    setTranslationConflict(null);
    if (choice === 'cancel') return;
    if (choice === 'move') moveTab(id, to);
    else activate(id);
    requestAnimationFrame(() => document.getElementById('document-tab-' + id)?.focus());
  }
  function addFeature(kind: 'translation' | 'chat', column: Column, source?: string) {
    if (kind === 'translation') {
      const existing = extrasRef.current.find(tab => tab.kind === 'translation');
      if (existing) return existing.id;
    }
    const id = crypto.randomUUID();
    updateExtras([...extrasRef.current, { id, kind, name: kind === 'chat' ? 'AI 对话' : '译文', source }]);
    if (maximizedRef.current && maximizedRef.current !== column) setMaximized(null);
    updateWorkspace(move(workspaceRef.current, id, column));
    return id;
  }
  function addDocument(tab: DocumentTab, column: Column, restoring = false) {
    updateTabs(items => [...items, tab]);
    if (!restoring) {
      if (maximizedRef.current && maximizedRef.current !== column) setMaximized(null);
      updateWorkspace(move(workspaceRef.current, tab.id, column));
    }
  }
  function workspaceSnapshot(workspace = workspaceRef.current) {
    const documents: Resource[] = tabsRef.current.filter(tab => tab.path).map(tab => ({
      id: tab.id, kind: tab.kind, name: tab.name, path: tab.path,
      fingerprint: tab.kind === 'pdf' ? tab.fingerprint : undefined,
    }));
    return saveWorkspace(workspace, [...documents, ...extrasRef.current.filter(tab => tab.kind !== 'chat' || !temporaryChats.current.has(tab.id))]);
  }
  const temporaryChats = useRef(new Set<string>());
  function patchText(id: string, patch: Partial<TextTab>) {
    updateTabs(items => items.map(tab => tab.id === id && tab.kind !== 'pdf' ? { ...tab, ...patch } : tab));
  }
  function createText(kind: TextKind, column = workspaceRef.current.focus) {
    if (exclusive.current) return;
    const extension = kind === 'txt' ? '.txt' : '.md';
    let name = '未命名' + extension;
    for (let index = 2; tabsRef.current.some(tab => tab.name === name); index++) name = `未命名-${index}${extension}`;
    const tab = newTextTab(kind, name);
    addDocument(tab, column);
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
    const column = columnOf(workspaceRef.current, id);
    if (!column) return;
    if (maximizedRef.current && maximizedRef.current !== column) setMaximized(null);
    updateWorkspace(select(workspaceRef.current, column, id));
    if (layoutRef.current.left) void panes.current.get(id)?.action('hide-navigation').catch(() => {});
  }
  function openSettings(section: SettingsSection = 'general') { dismissToolbarMenus(); panes.current.get(activeRef.current)?.dismissSelectionMenu(); setSettingsSection(section); setSettingsOpen(true); }
  function openCitation(id = activeRef.current) {
    if (exclusive.current || modalRef.current || !panes.current.get(id)?.hasDocument) return;
    dismissToolbarMenus(); panes.current.get(id)?.dismissSelectionMenu(); setCitationId(id);
  }
  function applyLayout(value: Layout) { setLeft(value.left); setReading(value.reading); setTheme(value.theme); setAccent(value.accent ?? DEFAULT_ACCENT); setPreferredWidths({left: value.leftWidth, right: value.rightWidth}); }
  function resizeNavigation(value: number) { setPreferredWidths(previous => ({ ...previous, left: Math.max(160, Math.min(widths.leftMax, value)) })); }
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
  async function openData(bytes: Uint8Array, name: string, path = '', expected = '', page?: number, column = workspaceRef.current.focus, restoredId?: string): Promise<string> {
    if (new TextDecoder().decode(bytes.slice(0,5)) !== '%PDF-') throw Error(`${name} 不是有效的 PDF`);
    const fingerprint = await digest(bytes);
    if (expected && fingerprint !== expected) throw Error('所选文件内容不匹配，未替换旧记录。');
    const existing = tabsRef.current.find((tab): tab is PdfTab => tab.kind === 'pdf' && (path ? tab.path.toLowerCase() === path.toLowerCase() : !tab.path && tab.name === name && tab.fingerprint === fingerprint));
    if (existing) {
      if (path) updateTabs(items => items.map(tab => tab.id === existing.id ? { ...tab, path } : tab));
      activate(existing.id, true);
      if (page && existing.state) await panes.current.get(existing.id)?.restore(page, existing.state.zoom);
      return existing.id;
    }
    const saved = prefsRef.current.restoreProgress ? repository.snapshot.book.recents.find(item => item.fingerprint === fingerprint) : null;
    const id = restoredId ?? crypto.randomUUID();
    addDocument({ kind: 'pdf', id, name, path, fingerprint, bytes, initialPage: page || saved?.page || 1, initialZoom: saved?.zoom || prefsRef.current.defaultZoom, state: null }, column, !!restoredId);
    return id;
  }
  async function openText(kind: TextKind, load: (encoding?: TextEncoding) => Promise<OpenedText>, column = workspaceRef.current.focus, restoredId?: string) {
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
    if (restoredId) tab.id = restoredId;
    addDocument(tab, column, !!restoredId);
    return tab.id;
  }
  async function openPath(path: string, expected = '', page?: number, column = workspaceRef.current.focus, restoredId?: string) {
    const kind = documentKind(path);
    if (!kind) throw Error('请选择 PDF、Markdown 或 TXT 文件');
    if (kind !== 'pdf') {
      if (expected) throw Error('请选择匹配的 PDF 文件');
      return openText(kind, encoding => openNativeText(path, encoding), column, restoredId);
    }
    const pdf = await invoke<{ name: string; path: string; bytes: number[] }>('read_pdf', { path });
    return openData(Uint8Array.from(pdf.bytes), pdf.name, pdf.path, expected, page, column, restoredId);
  }
  async function openPaths(paths: string[], column = workspaceRef.current.focus) { for (const path of paths) try { await openPath(path, '', undefined, column); } catch (error) { setError(String(error)); } }
  function fileOpen(files: File[], column = workspaceRef.current.focus) {
    return queueOpen(async () => {
      for (const file of files) try {
        const kind = documentKind(file.name);
        if (kind === 'pdf') await openData(new Uint8Array(await file.arrayBuffer()), file.name, '', '', undefined, column);
        else if (kind) await openText(kind, encoding => openBrowserText(file, encoding), column);
        else throw Error(`不支持此文档格式：${file.name}`);
      } catch (error) { setError(String(error)); }
    });
  }
  const pickerColumn = useRef<Column>('upper');
  async function choose(column = workspaceRef.current.focus) {
    pickerColumn.current = column;
    focusColumn(column);
    if (!isTauri()) { input.current?.click(); return; }
    await runOperation('choosing', async () => { const paths = await invoke<string[]>('choose_documents'); await openPaths(paths, column); });
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
  function pendingNote(id: string) {
    const note = draftValues.current.get(id);
    return note && note.value !== note.draft.value ? note : undefined;
  }
  async function finishNote(tabId: string, draftId: string, value: string | null) {
    await panes.current.get(tabId)?.annotationNote(draftId, value);
    draftValues.current.delete(tabId);
    setAnnotations(previous => {
      const workspace = previous[tabId];
      return workspace?.draft?.id === draftId ? { ...previous, [tabId]: { ...workspace, draft: null } } : previous;
    });
  }
  function showAnnotations(id: string) {
    setNavigationId(id);
    setAnnotationTab(id);
    setReading(false);
    setLeft(true);
    void panes.current.get(id)?.action('hide-navigation').catch(() => {});
  }
  async function annotationAction(id: string, action: AnnotationAction, item: string, value?: number) {
    try { return await panes.current.get(id)?.annotationAction(action, item, value) ?? false; }
    catch (error) { setError(String(error)); return false; }
  }
  function updateDraft(id: string, value: string) {
    const note = draftValues.current.get(id);
    if (note) {
      note.value = value;
      refreshDraft(version => version + 1);
    }
  }
  async function exportTab(id: string): Promise<boolean> {
    const tab = tabsRef.current.find(tab => tab.id === id), pane = panes.current.get(id);
    if (tab?.kind !== 'pdf' || !tab.state || !pane) return false;
    const note = pendingNote(id);
    if (note) {
      showAnnotations(id);
      if (!note.value.trim()) throw Error('请填写、取消或删除当前注释后再导出。');
      await finishNote(id, note.draft.id, note.value);
    }
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
      async () => ({ dirty: tab.kind === 'pdf' ? !!pendingNote(tab.id) || (await pane!.flush()).dirty : textDirty(tab) }),
      () => {
        activate(tab.id, true);
        return new Promise<LeaveChoice>(resolve => { leaveAnswer.current = resolve; setPrompt({ id: tab.id, name: tab.name }); });
      },
      () => saveTab(tab.id),
    );
  }
  async function closeTab(id: string) {
    if (exclusive.current) return;
    if (!tabsRef.current.some(tab => tab.id === id)) {
      await chatStops.current.get(id)?.();
      updateExtras(extrasRef.current.filter(tab => tab.id !== id));
      setMissing(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
      setTranslationSignals(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
      temporaryChats.current.delete(id);
      setChatMaterials(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
      updateWorkspace(remove(workspaceRef.current, id));
      return;
    }
    await runOperation('closing', async () => { const tab=tabsRef.current.find(tab=>tab.id===id);if(!tab||!await mayClose(tab))return;await persist(tab).catch(()=>{});clearTimeout(progressTimers.current.get(id));progressTimers.current.delete(id);
      draftValues.current.delete(id);
      setAnnotations(previous => { const next = { ...previous }; delete next[id]; return next; });
      setAnnotationTab(previous => previous === id ? '' : previous);
      updateTabs(items=>items.filter(item=>item.id!==id));updateWorkspace(remove(workspaceRef.current,id)); });
  }
  async function closeWindow() {
    await runOperation('closing', async () => { const initialWorkspace = workspaceRef.current; for(const tab of [...tabsRef.current]) {if(!await mayClose(tab))return;await persist(tabsRef.current.find(item=>item.id===tab.id)||tab).catch(()=>{});}await Promise.all([...chatStops.current.values()].map(stop => stop()));await repository.saveLayout(layoutRef.current).catch(()=>{});if(layoutReady&&!preserveLayout.current)await repository.saveWorkspace(workspaceSnapshot(initialWorkspace)).catch(()=>{});await repository.flush();await invoke('finish_close'); });
  }
  async function action(action: ReaderAction, id = activeRef.current) { const pane=panes.current.get(id);if(action==='thumbnails')setLeft(false);try{await pane?.action(action);}catch(error){setError(String(error));} }
  async function position(id: string, page: number, zoom?: string) { const tab=tabsRef.current.find(tab=>tab.id===id);if(tab?.kind!=='pdf'||!tab.state)return;try{await panes.current.get(tab.id)?.restore(page,zoom||tab.state.zoom);}catch(error){setError(String(error));} }
  function register(id: string, pane: ReaderAdapter | null) { if(pane)panes.current.set(id,pane);else panes.current.delete(id); }
  function opened(id: string, state?: ReaderState, error?: string) { updateTabs(items=>items.map(tab=>tab.id===id&&tab.kind==='pdf'?{...tab,bytes:undefined,state:state||null,error}:tab));if(state)scheduleProgress(id); }
  function readerEvent(id: string,event: ReaderEvent) {
    const previous=tabsRef.current.find(tab=>tab.id===id);if(previous?.kind!=='pdf')return;
    if(event.type==='state') { updateTabs(items=>items.map(tab=>tab.id===id&&tab.kind==='pdf'?{...tab,state:event.state}:tab));if(!previous.bytes&&(previous.state?.page!==event.state.page||previous.state?.zoom!==event.state.zoom))scheduleProgress(id); }
    else if(event.type==='error')setError(previous.name+'：'+event.message);
    else if(event.type==='export-requested')void runOperation('exporting',()=>exportTab(id));
    else if (event.type === 'annotations') {
      const draft = event.workspace.draft;
      if (draft) {
        if (draftValues.current.get(id)?.draft.id !== draft.id) draftValues.current.set(id, { draft, value: draft.value });
      } else draftValues.current.delete(id);
      setAnnotations(previous => ({ ...previous, [id]: event.workspace }));
    }
    else if (event.type==='file-open-requested') void fileOpen([new File([new Uint8Array(event.bytes)],event.filename,{type:'application/pdf'})]);
    else if (id===activeRef.current) {
      if (event.type === 'annotations-open') showAnnotations(id);
      if (event.type==='dismiss-menus') dismissToolbarMenus();
      if (event.type==='translate-selection' && !exclusive.current && !modalRef.current) requestTranslation(id);
      if (event.type==='selection-copied') setNotice('已复制选区');
      if (event.type==='cite-document') openCitation(id);
    }
  }
  function revealTranslation(pdfId: string) {
    const column = columnOf(workspaceRef.current, pdfId) ?? 'upper';
    const existing = extrasRef.current.find(tab => tab.kind === 'translation');
    const originalFocus = workspaceRef.current.focus;
    const id = existing?.id ?? addFeature('translation', column === 'right' ? 'lower' : 'right', column);
    const targetColumn = columnOf(workspaceRef.current, id);
    if (!targetColumn) return id;
    if (maximizedRef.current && maximizedRef.current !== targetColumn) setMaximized(null);
    const next = select(workspaceRef.current, targetColumn, id);
    updateWorkspace({ ...next, focus: originalFocus });
    setReading(false);
    return id;
  }
  function requestTranslation(pdfId: string) {
    const column = columnOf(workspaceRef.current, pdfId);
    if (!column) return;
    const id = revealTranslation(pdfId);
    const target = extrasRef.current.find(tab => tab.id === id);
    if (resolveTranslationSource(target?.source) !== pdfId) setTranslationSource(id, column);
    setTranslationSignals(previous => ({ ...previous, [id]: { pdf: pdfId, count: (previous[id]?.count ?? 0) + 1 } }));
  }
  const handlers = useRef({ choose, closeWindow, closeTab, saveTab, openPaths, insertImageBatch, cycleColumns, requestTranslation });
  handlers.current = { choose, closeWindow, closeTab, saveTab, openPaths, insertImageBatch, cycleColumns, requestTranslation };
  const modalRef=useRef(false);modalRef.current=settingsOpen||!!prompt||!!citationTab||!!encodingFile||!!translationConflict;
  function cycleColumns(reverse: boolean) {
    const visible = columns.filter(column => !workspaceRef.current.collapsed[column] && (!maximizedRef.current || maximizedRef.current === column));
    const index = visible.indexOf(workspaceRef.current.focus);
    const next = visible[(index + (reverse ? visible.length - 1 : 1)) % visible.length];
    if (!next) return;
    focusColumn(next);
    const id = workspaceRef.current.selected[next];
    (document.getElementById('document-tab-' + id) ?? document.querySelector<HTMLElement>(`.workspace-column[data-column="${next}"] .new-document > button`))?.focus();
  }
  useEffect(() => {
    if (!layoutReady || preserveLayout.current) return;
    const timer = setTimeout(() => { void repository.saveWorkspace(workspaceSnapshot()).catch(error => setError(String(error))); }, 500);
    return () => clearTimeout(timer);
  }, [workspace, extras, layoutReady, tabs.map(tab => tab.path).join('\u0000')]);
  useEffect(()=>repository.subscribe(()=>setLibrary(repository.snapshot)),[]);
  useEffect(()=>{const resize=()=>setViewport(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(() => {
    const change = () => setSystemTheme(systemColorScheme.matches ? 'dark' : 'light');
    systemColorScheme.addEventListener('change', change);
    change();
    return () => systemColorScheme.removeEventListener('change', change);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = colorScheme; document.documentElement.dataset.accent = accent; }, [colorScheme, accent]);
  useEffect(() => {
    const { style } = document.documentElement;
    style.setProperty('--ui-font-size', preferences.uiFontSize + 'px');
    style.setProperty('--translation-font-size', preferences.translationFontSize + 'px');
  }, [preferences.uiFontSize, preferences.translationFontSize]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(timer);},[notice]);
  useEffect(()=>{try{localStorage.setItem(WIDTHS_KEY,JSON.stringify(preferredWidths));}catch{}},[preferredWidths]);
  useEffect(()=>{if(!localReady)return;const timer=setTimeout(()=>{void repository.saveLayout(layoutRef.current).catch(()=>{});},400);return()=>clearTimeout(timer);},[localReady,left,reading,preferredWidths.left,preferredWidths.right,theme,accent]);
  useEffect(() => {
    const modal = translationDialog.current;
    if (translationConflict && !modal?.open) modal?.showModal();
    if (!translationConflict && modal?.open) modal.close();
  }, [translationConflict]);
  useEffect(() => {
    if (!automatic) { automaticSignature.current = ''; return; }
    if (!layoutReady || !reader?.selection || settingsOpen || operation) return;
    const signature = JSON.stringify([activeId, reader.selection, reader.selectionAnchor]);
    if (signature === automaticSignature.current) return;
    automaticSignature.current = signature;
    if (!translation) revealTranslation(activeId);
  }, [automatic, layoutReady, activeId, reader?.selection, reader?.selectionAnchor, settingsOpen, operation, translation]);
  useEffect(()=>{if(prompt&&!dialog.current?.open)dialog.current?.showModal();if(!prompt&&dialog.current?.open)dialog.current?.close();},[prompt]);
  useEffect(()=>{
    let disposed=false;const releases:(()=>void)[]=[];
    const local=repository.init().then(snapshot=>{if(!disposed){applyLayout(snapshot.book.layout);const preferences={...DEFAULT_READER_PREFERENCES,...snapshot.book.preferences};setPreferences(preferences);prefsRef.current=preferences;setLocalReady(true);}return snapshot;});
    const restore = local.then(async snapshot => {
      if (disposed) return false;
      const saved = readWorkspace(snapshot.book.workspace);
      const wasOpen = snapshot.book.layout.right;
      function recoverLegacyTranslation() {
        const focus = workspaceRef.current.focus;
        const column = workspaceRef.current.order.right.length ? 'lower' : 'right';
        addFeature('translation', column, 'upper');
        focusColumn(focus, true);
      }
      if (!saved) {
        preserveLayout.current = snapshot.book.workspace !== undefined;
        if (!preserveLayout.current && wasOpen) recoverLegacyTranslation();
        if (preserveLayout.current) setNotice('无法读取上次的工作区布局。已使用默认布局，原记录仍保留。');
        return false;
      }
      const restored = singleTranslation(saved);
      updateWorkspace(restored);
      updateExtras(restored.resources.filter(resource => resource.kind === 'chat' || resource.kind === 'translation'));
      if (wasOpen && !extrasRef.current.some(tab => tab.kind === 'translation')) recoverLegacyTranslation();
      if (isTauri()) await runOperation('opening', async () => {
        for (const resource of restored.resources) {
          if (!resource.path) continue;
          try {
            const path = await invoke<string>('reopen_workspace_document', { path: resource.path });
            if (!await openPath(path, '', undefined, columnOf(restored, resource.id), resource.id)) throw Error('未选择文件编码');
          } catch (error) {
            updateExtras([...extrasRef.current, resource]);
            setMissing(previous => ({ ...previous, [resource.id]: String(error) }));
          }
        }
      });
      return true;
    }).finally(() => {
      if (!disposed) { booted.current = true; setLayoutReady(true); }
    });
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
      try{const snapshot=await local;const restored=await restore;const batch=await invoke<{paths:string[];errors:string[]}>('startup_pdfs');if(disposed)return;if(batch.errors.length)setError(batch.errors.join('\n'));if(batch.paths.length)await queueOpen(()=>handlers.current.openPaths(batch.paths));else if(!restored&&prefsRef.current.restoreProgress){const recent=snapshot.book.recents.find(recent=>recent.path);if(recent){const path=await invoke<string>('reopen_pdf',{path:recent.path});await queueOpen(()=>handlers.current.openPaths([path]));}}}catch(error){if(!disposed)setError(String(error));}
    })().catch(error=>{if(!disposed)setError(String(error));});
    const key=(event:KeyboardEvent)=>{
      if (event.key === 'Escape') {
        dismissToolbarMenus();
        panes.current.get(activeRef.current)?.dismissLinkPreview();
      }
      if(event.isComposing||event.keyCode===229)return;
      if (event.key === 'F6' && !modalRef.current && !exclusive.current) { event.preventDefault(); handlers.current.cycleColumns(event.shiftKey); return; }
      if (!(event.ctrlKey||event.metaKey)) return;
      const value=event.key.toLowerCase();if(modalRef.current){if(value==='w'||value==='tab')event.preventDefault();return;}if(exclusive.current)return;
      if(event.shiftKey&&event.key==='Enter'&&panes.current.has(activeRef.current)){event.preventDefault();event.stopImmediatePropagation();handlers.current.requestTranslation(activeRef.current);}
      else if(value==='o'){event.preventDefault();void handlers.current.choose();}
      else if(value==='s'&&tabsRef.current.some(tab=>tab.id===activeRef.current)){event.preventDefault();void runOperation('saving',()=>handlers.current.saveTab(activeRef.current, event.shiftKey));}
      else if(value==='f'&&editors.current.has(activeRef.current)){event.preventDefault();editors.current.get(activeRef.current)?.find();}
      else if(value==='w'){event.preventDefault();if(activeRef.current)void handlers.current.closeTab(activeRef.current);}
      else if((value==='z'||value==='y')&&!event.altKey&&activeRef.current&&!(event.target instanceof Element&&event.target.closest('input,textarea,[contenteditable=true]'))){event.preventDefault();
        const command = value==='y'||event.shiftKey?'redo':'undo', editor = editors.current.get(activeRef.current);
        if (editor) editor[command]();
        else void action(command);}
      else if(value==='tab'||/^[1-9]$/.test(value)){event.preventDefault();activate(shortcutTabId(columns.flatMap(column=>workspaceRef.current.order[column]),activeRef.current,value==='tab'?'Tab':value,event.shiftKey));}
    };
    const unload=(event:BeforeUnloadEvent)=>{if(tabsRef.current.some(tab => dirty(tab) || !!pendingNote(tab.id))){event.preventDefault();event.returnValue='';}};
    const dismiss=(event:PointerEvent)=>{if(!(event.target as Element).closest('.toolbar-menu'))dismissToolbarMenus();};
    window.addEventListener('keydown',key,true);window.addEventListener('beforeunload',unload);document.addEventListener('pointerdown',dismiss);
    return()=>{disposed=true;releases.forEach(release=>release());progressTimers.current.forEach(clearTimeout);window.removeEventListener('keydown',key,true);window.removeEventListener('beforeunload',unload);document.removeEventListener('pointerdown',dismiss);};
  },[]);
  function resizeWorkspace(key: 'rightShare' | 'lowerShare', value: number) {
    updateWorkspace({ ...workspaceRef.current, [key]: Math.max(0.15, Math.min(0.85, value)) });
  }
  function documentTools(column: Column) {
    const tab = tabs.find(item => item.id === workspace.selected[column]);
    if (!tab) return null;
    const compact = column !== 'upper';
    const id = tab.id;
    if (tab.kind !== 'pdf') return <TextToolbar tab={tab} compact={compact} busy={!!operation} attachments={isTauri()}
      onSave={saveAs => { void runOperation('saving', () => saveTab(id, saveAs)); }}
      onFind={() => editors.current.get(id)?.find()} onUndo={() => editors.current.get(id)?.undo()}
      onRedo={() => editors.current.get(id)?.redo()} onWrap={() => patchText(id, { wrap: !tab.wrap })}
      onMode={mode => patchText(id, { mode })} onImage={() => { imageTarget.current = id; imageInput.current?.click(); }}
      onUtf8={() => patchText(id, { encoding: 'UTF-8', bom: false })} />;
    const translationColumn = translation && columnOf(workspace, translation.id);
    return <DocumentToolbar reader={tab.state} compact={compact} findAdapter={panes.current.get(id)}
      findModal={modalRef.current} keyboardActive={column === workspace.focus} busy={!!operation}
      right={!!translationColumn && openColumns.includes(translationColumn) && workspace.selected[translationColumn] === translation?.id} reading={reading}
      onExport={() => { void runOperation('exporting', () => exportTab(id)); }}
      onRight={() => { revealTranslation(id); }}
      onReading={() => { void action('hide-navigation', id); setReading(value => !value); }}
      onCitation={() => openCitation(id)} onAction={value => { void action(value, id); }}
      onPosition={(page, zoom) => { void position(id, page, zoom); }}
      onComment={() => { void panes.current.get(id)?.commentSelection().catch(error => setError(String(error))); }}
      onComments={() => { void panes.current.get(id)?.showComments().catch(error => setError(String(error))); }} />;
  }
  function renderTabs(column: Column) {
    const items = workspace.order[column].flatMap<HeaderTab>(id => {
      const tab = tabs.find(item => item.id === id);
      if (tab) return [{ ...tab, dirty: dirty(tab) || !!pendingNote(id) }];
      const extra = extras.find(item => item.id === id);
      return extra ? [{ ...extra, dirty: false }] : [];
    });
    const selected = workspace.selected[column];
    const source = translation?.source ?? 'upper';
    const sourceId = resolveTranslationSource(source);
    const actions = translation && selected === translation.id ? <TranslationSource source={source} available={pdfs.some(pdf => pdf.id === sourceId && pdf.state)}
      canPin={!!sourceId} onFollow={column => setTranslationSource(translation.id, column)}
      onPin={() => { if (sourceId) setTranslationSource(translation.id, sourceId); }} />
      : column !== 'upper' ? documentTools(column) : null;
    return <WorkspaceTabs actions={actions} column={column} tabs={items} selected={workspace.selected[column]} busy={!!operation} maximized={maximized === column}
      onSelect={id => activate(id)} onClose={id => { void closeTab(id); }} onMove={moveTab} onOpen={() => { void choose(column); }}
      onNew={kind => { if (kind === 'translation') newTranslation(column); else if (kind === 'chat') addFeature(kind, column); else createText(kind, column); }}
      onCollapse={openColumns.length > 1 && !maximized ? () => collapseColumn(column) : undefined}
      onMaximize={() => { focusColumn(column); setMaximized(maximized === column ? null : column); }} onReset={resetWorkspace} />;
  }
  async function relocateWorkspace(resource: Resource) {
    const column = columnOf(workspaceRef.current, resource.id);
    if (!column) return;
    await runOperation('choosing', async () => {
      const paths = resource.kind === 'pdf'
        ? [await invoke<string | null>('choose_pdf')]
        : await invoke<string[]>('choose_documents');
      const path = paths.find(value => value && documentKind(value) === resource.kind);
      if (!path) return;
      const id = await openPath(path, resource.fingerprint ?? '', undefined, column, resource.id);
      if (!id) return;
      updateExtras(extrasRef.current.filter(tab => tab.id !== resource.id));
      setMissing(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== resource.id)));
      if (id !== resource.id) updateWorkspace(remove(workspaceRef.current, resource.id));
    });
  }
  function openConversation(conversation: Conversation) {
    if (extrasRef.current.some(tab => tab.id === conversation.id)) { activate(conversation.id); return; }
    updateExtras([...extrasRef.current, { id: conversation.id, kind: 'chat', name: conversationName(conversation) }]);
    updateWorkspace(move(workspaceRef.current, conversation.id, workspaceRef.current.focus));
  }
  async function clearChatHistory(ids?: string[]) {
    const targets = ids ?? extrasRef.current.filter(tab => tab.kind === 'chat' && !temporaryChats.current.has(tab.id)).map(tab => tab.id);
    await Promise.all(targets.map(id => chatStops.current.get(id)?.()));
    await repository.deleteConversations(ids);
    setChatRevisions(previous => {
      const next = { ...previous };
      for (const id of targets) next[id] = (next[id] ?? 0) + 1;
      return next;
    });
  }
  async function makeMaterial(id: string, mode: 'selection' | 'page' | 'document'): Promise<Material> {
    const tab = tabsRef.current.find(item => item.id === id);
    if (!tab) throw Error('请先打开材料所在的文档。');
    if (tab.kind === 'pdf') {
      const state = tab.state;
      const pane = panes.current.get(id);
      if (!state || !pane) throw Error('PDF 尚未准备好。');
      const page = mode === 'page' ? state.page : state.selectionRects[0]?.page || state.page;
      const text = mode === 'page' ? await pane.pageText(page) : state.selectionRaw || state.selection;
      if (!text.trim()) throw Error('没有可用文字。扫描页可手动粘贴文字。');
      const rectangle = mode === 'selection' ? state.selectionRects[0] : undefined;
      return { id: crypto.randomUUID(), documentId: id, fingerprint: tab.fingerprint, name: tab.name, page, text,
        position: rectangle ? { x: rectangle.x, y: rectangle.y } : undefined };
    }
    if (mode === 'document') {
      if (!tab.source.trim()) throw Error('文档没有可用文字。');
      return { id: crypto.randomUUID(), documentId: id, name: tab.name, line: 1, text: tab.source };
    }
    const selection = editors.current.get(id)?.selection();
    if (!selection?.text.trim()) throw Error('请先在文档中选中文字。');
    return { id: crypto.randomUUID(), documentId: id, name: tab.name, line: selection.line, text: selection.text };
  }
  async function attachMaterial(id: string, mode: 'selection' | 'page') {
    try {
      const material = await makeMaterial(id, mode);
      const current = workspaceRef.current;
      const target = extrasRef.current.find(item => item.kind === 'chat' && item.id === current.selected.right);
      const chatId = target?.id ?? addFeature('chat', 'right');
      activate(chatId);
      setChatMaterials(previous => ({ ...previous, [chatId]: [...(previous[chatId] ?? []), material] }));
    } catch (error) { setError(String(error)); }
  }
  async function locateMaterial(material: Material) {
    const tab = tabsRef.current.find(item => item.kind === 'pdf' ? item.fingerprint === material.fingerprint : !material.fingerprint && item.id === material.documentId);
    if (!tab) throw Error('请重新打开原文。已发送的片段仍在对话中。');
    const sourceColumn = columnOf(workspaceRef.current, tab.id);
    if (sourceColumn && sourceColumn === workspaceRef.current.focus) {
      const target = columns.find(column => column !== sourceColumn && !workspaceRef.current.order[column].length);
      if (target) moveTab(tab.id, target);
    }
    activate(tab.id);
    if (tab.kind === 'pdf' && tab.state && material.page) await panes.current.get(tab.id)?.locateSource(material.page, material.position);
    if (tab.kind !== 'pdf' && material.line) {
      if (tab.mode === 'preview') patchText(tab.id, { mode: 'split' });
      requestAnimationFrame(() => editors.current.get(tab.id)?.locate(material.line!, material.text));
    }
  }
  const verticalSplit = showUpper && showLower;
  const horizontalSplit = showRight && (showUpper || showLower);
  const leftColumn = showUpper ? 'upper' : 'lower';
  const gridLayout: CSSProperties = {
    gridTemplateAreas: maximized ? `"${maximized}"` : verticalSplit ?
      horizontalSplit ? '"upper divider-right right" "divider-lower divider-right right" "lower divider-right right"' : '"upper" "divider-lower" "lower"'
      : horizontalSplit ? `"${leftColumn} divider-right right"` : `"${openColumns[0] ?? 'upper'}"`,
    gridTemplateRows: verticalSplit ? `minmax(88px, ${1 - workspace.lowerShare}fr) 5px minmax(88px, ${workspace.lowerShare}fr)` : 'minmax(0, 1fr)',
    gridTemplateColumns: horizontalSplit ? `minmax(135px, ${1 - workspace.rightShare}fr) 5px minmax(136px, ${workspace.rightShare}fr)` : 'minmax(0, 1fr)',
  };
  return <div className={'app workspace'+(reading?' reading-mode':'')} onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){if(!isTauri()) setDragging(true);event.preventDefault();}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDragging(false);}} onDrop={event=>{const handled = event.defaultPrevented;event.preventDefault();setDragging(false);if(!handled&&!isTauri())void fileOpen([...event.dataTransfer.files]);}}
    onPaste={event => {
      if (event.defaultPrevented || modalRef.current || text?.kind !== 'markdown' || !isTauri()) return;
      const files = [...event.clipboardData.files].filter(isImage);
      if (files.length) { event.preventDefault(); void insertImages(text.id, files); }
    }}>
    <div className="workspace-title-bar">
      <div className="workspace-brand" data-tauri-drag-region><img src={brandIcon} width={21} height={21} alt="" /><strong>PDFreader</strong></div>
      <button className="window-command" disabled={!!operation} title="打开文档 (Ctrl+O)" onClick={() => { void choose(); }}><FolderOpen20Regular />打开</button>
      <button className="window-command window-navigation" aria-label="文档导航" title="目录、最近文件与笔记" aria-pressed={left && !reading} onClick={() => {
        const id = navigationTabId;
        void action('hide-navigation', id);
        setNavigationId(id); setReading(false); setAnnotationTab(''); setLeft(value => !!annotationTab || !value);
      }}><PanelLeft20Regular /></button>
      <div className="workspace-drag" data-tauri-drag-region aria-hidden="true" />
      <details className="toolbar-menu workspace-layout-menu">
        <summary role="button" aria-label="布局" title="布局"><WindowMultiple20Regular />布局</summary>
        <div className="command-menu" onClick={event => {
          if ((event.target as Element).closest('button')) event.currentTarget.parentElement?.removeAttribute('open');
        }}>
          {columns.map(column => <button key={column} type="button" aria-label={columnName[column]} aria-pressed={!workspace.collapsed[column]}
            disabled={!workspace.collapsed[column] && columns.filter(item => !workspace.collapsed[item]).length === 1} onClick={() => {
              if (workspaceRef.current.collapsed[column]) focusColumn(column); else collapseColumn(column);
            }}>{workspace.collapsed[column] ? '显示' : '收起'}{columnName[column]}</button>)}
          {maximized && <button onClick={() => setMaximized(null)}>恢复三栏布局</button>}
          <button onClick={resetWorkspace}>恢复默认比例</button>
        </div>
      </details>
      <button className="window-command" aria-label="设置" title="设置" onClick={() => openSettings()}><Settings20Regular />设置</button>
      {isTauri() && <WindowControls busy={!!operation || !layoutReady} onClose={() => { void closeWindow(); }} onError={setError} />}
    </div>
    <input ref={input} type="file" multiple accept={acceptDocuments} hidden onChange={event=>{const files=[...(event.target.files||[])];event.target.value='';if(files.length)void fileOpen(files, pickerColumn.current);}} />
    {isTauri() && tabs.some(tab => tab.kind === 'markdown') && <input ref={imageInput} type="file" multiple accept="image/*,.svg,.avif,.ico" hidden onChange={event=>{
      const files = [...(event.target.files ?? [])]; event.target.value = '';
      if (files.length && imageTarget.current) void insertImages(imageTarget.current, files);
      imageTarget.current = '';
    }} />}
    {error&&<div className="error" role="alert">{error}<button aria-label="关闭错误提示" onClick={()=>setError('')}><Dismiss20Regular /></button></div>}{notice&&<div className="notice" role="status">{notice}<button aria-label="关闭通知" onClick={()=>setNotice('')}><Dismiss20Regular /></button></div>}
    {library.problems.map(problem=><div className="local-problem" role="alert" key={problem.kind+problem.document}><span>{problem.message}</span><button onClick={()=>{void repository.reload();}}>重新载入</button><button onClick={()=>{void repository.recover(problem).then(setNotice).catch(error=>setError(String(error)));}}>备份并恢复</button></div>)}
    <main>
      {left&&!reading&&<div className="panel-shell navigation-shell" style={{width:widths.left}}><ResizeHandle side="left" width={widths.left} max={widths.leftMax} onResize={resizeNavigation} />
        {navigationReader&&annotationTab===navigationTabId ? <AnnotationPanel key={navigationTabId} workspace={annotations[navigationTabId]} draftValue={draftValues.current.get(navigationTabId)?.value || ''}
          busy={!!operation} onClose={()=>{setAnnotationTab('');setLeft(false);}} onHistory={value=>{void action(value,navigationTabId);}}
          onDraftValue={value=>updateDraft(navigationTabId,value)}
          onNote={async (draftId,value)=>{try{await finishNote(navigationTabId,draftId,value);}catch(error){setError(String(error));}}}
          onAction={(value,item,width)=>annotationAction(navigationTabId,value,item,width)} /> : <LibraryPanel snapshot={library} reader={navigationReader} onNavigate={index=>panes.current.get(navigationTabId)?.navigate(index)} onRecent={recent=>{void openRecent(recent);}} onRelocate={recent=>{void relocate(recent);}} onNote={note=>{void locateNote(note);}} onError={setError} />}</div>}
      <section className="reader workspace-grid" data-split-lower={verticalSplit} aria-label="文档内容" style={gridLayout}>
        {openColumns.map(column => <div key={column} className="workspace-column" data-column={column} data-focused={column === workspace.focus} style={{ gridArea: column }}
          onPointerDownCapture={() => { if (workspaceRef.current.focus !== column) focusColumn(column); }}
          onFocusCapture={() => { if (workspaceRef.current.focus !== column) focusColumn(column); }}>
          <WorkspaceHeader column={column}>
            {renderTabs(column)}
            {column === 'upper' && documentTools(column)}
            {(() => {
              const pdf = pdfs.find(item => item.id === workspace.selected[column]);
              const style = pdf?.state?.textBox;
              return pdf && style && <TextBoxToolbar key={pdf.id} value={style} busy={!!operation}
                onChange={change => { void panes.current.get(pdf.id)?.updateTextBoxStyle(style.target, change).catch(error => setError(String(error))); }}
                onDone={() => { void action('finish-text-box', pdf.id); }} />;
            })()}
          </WorkspaceHeader>
          {!workspace.selected[column] && (column === 'upper' ? <div className="welcome"><DocumentPdf20Regular /><h1>打开文档</h1><p>选择或拖入 PDF、Markdown 和 TXT 文件。</p><button className="primary" disabled={!!operation} onClick={()=>{void choose();}}><FolderOpen20Regular />打开文档</button><span>Ctrl + O 打开 · Ctrl + Tab 切换标签</span><button onClick={()=>{void queueOpen(async()=>{const response=await fetch('/pdfjs/web/compressed.tracemonkey-pldi-09.pdf');if(!response.ok)throw Error('示例文件不可用');await openData(new Uint8Array(await response.arrayBuffer()),'示例论文.pdf');});}}>阅读示例论文</button></div> : <p className="empty-column">用加号打开或新建标签。</p>)}
        </div>)}
        {horizontalSplit && !maximized && <WorkspaceSeparator vertical value={workspace.rightShare} onChange={value => resizeWorkspace('rightShare', value)} />}
        {verticalSplit && !maximized && <WorkspaceSeparator value={workspace.lowerShare} onChange={value => resizeWorkspace('lowerShare', value)} />}
        {tabs.map(tab => {
          const column = columnOf(workspace, tab.id);
          const visible = !!column && openColumns.includes(column) && workspace.selected[column] === tab.id;
          return <div className="workspace-slot" key={tab.id} data-column={column} style={{ gridArea: column }} hidden={!visible}
            onPointerDownCapture={() => { if (column && workspaceRef.current.focus !== column) focusColumn(column); }}
            onFocusCapture={() => { if (column && workspaceRef.current.focus !== column) focusColumn(column); }}>
            {tab.kind==='pdf' ? <DocumentPane tab={tab} active={visible} linkPreviewActive={visible&&!modalRef.current&&!operation} theme={colorScheme} accent={accent} uiFontSize={preferences.uiFontSize} selectionToolbar={preferences.selectionPopup} register={register} onEvent={readerEvent} onOpened={opened} />
              : <TextPane tab={tab} active={visible} busy={!!operation} register={registerText} onEdit={editText}
                onMode={(id,mode)=>patchText(id,{mode})} onImages={(id,files,position)=>{void insertImages(id,files,position);}}
                onCopy={setNotice} onError={setError} />}
          </div>;
        })}
        {extras.map(tab => {
          const column = columnOf(workspace, tab.id);
          const visible = !!column && openColumns.includes(column) && workspace.selected[column] === tab.id;
          return <div className="workspace-slot" key={tab.id} data-column={column} style={{ gridArea: column }} hidden={!visible}
            onPointerDownCapture={() => { if (column && workspaceRef.current.focus !== column) focusColumn(column); }}
            onFocusCapture={() => { if (column && workspaceRef.current.focus !== column) focusColumn(column); }}>
            <div id={'document-pane-' + tab.id} role="tabpanel" aria-labelledby={'document-tab-' + tab.id} className="workspace-feature">
              {tab.kind === 'translation' ? <WorkspaceTranslation sourceId={resolveTranslationSource(tab.source)}
                pdfs={pdfs} visible={visible} focusedPdf={active?.kind === 'pdf' ? active.id : ''} automatic={automatic}
                signal={translationSignals[tab.id]} showMetadata={preferences.showMetadata} showOriginal={preferences.showOriginal}
                onSettings={() => openSettings('translation')} disabled={!localReady || !!operation || settingsOpen} />
              : tab.kind === 'chat' ? <ChatPane id={tab.id} visible={visible} incoming={chatMaterials[tab.id]} onReceive={() => setChatMaterials(previous => {
                const next = { ...previous }; delete next[tab.id]; return next;
              })} onTemporary={temporary => {
                if (temporary) temporaryChats.current.add(tab.id); else temporaryChats.current.delete(tab.id);
                updateExtras([...extrasRef.current]);
              }} documents={tabs.map(item => ({ id: item.id, name: item.name, kind: item.kind }))}
                getMaterial={makeMaterial} onLocate={locateMaterial} onOpenHistory={openConversation} onDeleteHistory={id => clearChatHistory([id])}
                onNew={() => addFeature('chat', column ?? workspaceRef.current.focus)}
                onSettings={provider => openSettings(provider === 'chatgpt' ? 'chatgpt' : provider === 'compatible' ? 'chat-api' : 'chat')}
                clearRevision={chatRevisions[tab.id] ?? 0} stopRegistration={(id, stop) => {
                  if (stop) chatStops.current.set(id, stop); else chatStops.current.delete(id);
                }} />
              : <div className="document-error" role="alert"><h2>文档无法恢复</h2><p>{missing[tab.id]}</p><button onClick={() => { void relocateWorkspace(tab); }}>重新定位</button></div>}
            </div>
          </div>;
        })}
      </section>
    </main>
    <footer><span>{tabs.length?`${tabs.length} 个文档`:'就绪'}{reader&&(reader.dirty||pendingNote(activeId))?' · 有未导出批注':text&&textDirty(text)?' · 有未保存修改':''}</span><span>{reader?`第 ${reader.page} / ${reader.pages} 页`:text?`第 ${text.position.line} 行，第 ${text.position.column} 列 · ${text.encoding}${text.bom?' BOM':''} · ${text.eol==='\r\n'?'CRLF':text.eol==='\r'?'CR':'LF'}`:active?.name||'PDFreader'}</span></footer>
    <SettingsDialog onClearChat={() => { void clearChatHistory().catch(error => setError(String(error))); }} open={settingsOpen} initialSection={settingsSection} onClose={()=>setSettingsOpen(false)} theme={theme} onTheme={setTheme} accent={accent} onAccent={setAccent} preferences={preferences} onPreferences={value=>{void changePreferences(value);}} automatic={automatic} onAutomatic={setAutomatic} documentKey={active?.kind==='pdf'?active.fingerprint:''} />
    {citationTab && citationAdapter && <CitationDialog key={citationTab.id} documentName={citationTab.name} adapter={citationAdapter} onClose={() => setCitationId('')} />}
    {encodingFile && <EncodingDialog name={encodingFile} error={encodingError} onAnswer={answerEncoding} />}
    <dialog ref={translationDialog} className="unsaved-dialog translation-conflict" aria-labelledby="translation-conflict-title"
      onCancel={event => { event.preventDefault(); answerTranslationConflict('cancel'); }}>
      {translationConflict && (() => {
        const from = columnOf(workspace, translationConflict.id);
        if (!from) return null;
        const to = translationConflict.to;
        return <>
          <h2 id="translation-conflict-title">译文已在{columnName[from]}打开</h2>
          <p>要把当前译文移到{columnName[to]}吗？</p>
          <div className="dialog-actions">
            <button onClick={() => answerTranslationConflict('cancel')}>取消</button>
            <button onClick={() => answerTranslationConflict('move')}>移到{columnName[to]}</button>
            <button className="primary" autoFocus onClick={() => answerTranslationConflict('locate')}>定位到{columnName[from]}</button>
          </div>
        </>;
      })()}
    </dialog>
    <dialog ref={dialog} className="unsaved-dialog" aria-labelledby="unsaved-title" onCancel={event=>{event.preventDefault();answer('cancel');}}><h2 id="unsaved-title">{text ? '有尚未保存的修改' : '有尚未导出的修改'}</h2>
      <p>{text ? `是否保存“${prompt?.name}”的修改？` : `是否先导出“${prompt?.name}”的批注？`}</p><div className="dialog-actions"><button onClick={()=>answer('discard')}>放弃修改</button><button autoFocus onClick={()=>answer('cancel')}>取消</button><button className="primary" onClick={()=>answer('save')}>保存并继续</button></div></dialog>
    {dragging&&!isTauri()&&<div className="drop-target">松开以在新标签打开文档</div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
