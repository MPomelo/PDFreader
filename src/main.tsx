import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { DocumentPdf20Regular, Dismiss20Regular, FolderOpen20Regular } from '@fluentui/react-icons';
import { ReaderAdapter, type ReaderEvent, type ReaderState, type ReaderAction, type AnnotationWorkspace, type AnnotationDraft, type AnnotationAction } from './reader/ReaderAdapter';
import { DocumentPane, type PdfTab } from './reader/DocumentPane';
import { useDocumentLifecycle } from './reader/useDocumentLifecycle';
import { LibraryPanel } from './local/LibraryPanel';
import { repository, DEFAULT_READER_PREFERENCES, type Layout, type ReaderPreferences } from './local/repository';
import { ResizeHandle } from './ui/ResizeHandle';
import { DEFAULT_WIDTHS, WIDTHS_KEY, panelLayout, parseWidths } from './ui/panel-widths';
import { SettingsDialog, type SettingsSection } from './ui/SettingsDialog';
import { DocumentToolbar } from './ui/DocumentToolbar';
import { TextBoxToolbar } from './ui/TextBoxToolbar';
import { AnnotationPanel } from './ui/AnnotationPanel';
import { TitleBar } from './ui/TitleBar';
import { StatusBar } from './ui/StatusBar';
import { ConfirmDialogs, type TranslationConflict } from './ui/ConfirmDialogs';
import { dismissToolbarMenus, useGlobalShortcuts } from './ui/useGlobalShortcuts';
import { DEFAULT_ACCENT, type Accent, type ColorScheme, type ThemeMode } from './ui/appearance';
import { CitationDialog } from './citation/CitationDialog';
import { TextPane, type TextEditor } from './text/TextPane';
import { TextToolbar } from './text/TextToolbar';
import { EncodingDialog } from './text/EncodingDialog';
import { cursorStore } from './text/cursor-store';
import { acceptDocuments, newTextTab, type TextKind, type TextTab } from './text/document';
import { imageName, isImage, markdownUrl, readDroppedImage, storeImage } from './text/attachments';
import { WorkspaceSeparator, WorkspaceTabs, type HeaderTab } from './workspace/WorkspaceTabs';
import { columns, columnOf, type Column } from './workspace/layout';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';
import { TranslationSource } from './workspace/TranslationSource';
import { WorkspaceTranslation } from './workspace/WorkspaceTranslation';
import { isTabDirty, useWorkspaceStore } from './workspace/useWorkspaceStore';
import { ChatPane, type Material } from './chat/ChatPane';
import './ui/tokens.css';
import './ui/base.css';
import './ui/workspace.css';
import './ui/annotations.css';

const systemColorScheme = window.matchMedia('(prefers-color-scheme: dark)');

function App() {
  const [translationSignals, setTranslationSignals] = useState<Record<string, { pdf: string; count: number }>>({});
  const [chatMaterials, setChatMaterials] = useState<Record<string, Material[]>>({});
  const chatStops = useRef(new Map<string, () => Promise<void>>());
  const [chatRevisions, setChatRevisions] = useState<Record<string, number>>({});
  const panes = useRef(new Map<string, ReaderAdapter>());
  const editors = useRef(new Map<string, TextEditor>());
  const imageInput = useRef<HTMLInputElement>(null);
  const imageTarget = useRef('');
  const [translationConflict, setTranslationConflict] = useState<TranslationConflict | null>(null);
  const automaticSignature = useRef('');
  const input = useRef<HTMLInputElement>(null);
  const exclusive = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [left, setLeft] = useState(false);
  const [reading, setReading] = useState(false);
  const [navigationId, setNavigationId] = useState('');
  const [annotationTab, setAnnotationTab] = useState('');
  const [annotations, setAnnotations] = useState<Record<string, AnnotationWorkspace>>({});
  const draftValues = useRef(new Map<string, { draft: AnnotationDraft; value: string }>());
  const [, refreshDraft] = useState(0);
  const [theme, setTheme] = useState<ThemeMode>('system');
  const [systemTheme, setSystemTheme] = useState<ColorScheme>(() => systemColorScheme.matches ? 'dark' : 'light');
  const [accent, setAccent] = useState<Accent>(DEFAULT_ACCENT);
  const colorScheme = theme === 'system' ? systemTheme : theme;
  const [library, setLibrary] = useState(repository.snapshot);
  const [localReady, setLocalReady] = useState(false);
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_READER_PREFERENCES);
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;
  const [automatic, setAutomatic] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [citationId, setCitationId] = useState('');
  const [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState(window.innerWidth);
  const [preferredWidths, setPreferredWidths] = useState(() => {
    try { return parseWidths(localStorage.getItem(WIDTHS_KEY)); } catch { return DEFAULT_WIDTHS; }
  });
  const pickerColumn = useRef<Column>('upper');

  const widths = panelLayout(preferredWidths, viewport, left && !reading, false);
  const layout: Layout = { left, reading, leftWidth: preferredWidths.left, rightWidth: preferredWidths.right, theme, accent };
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const {
    tabs, tabsRef, activeId, activeRef, workspace, workspaceRef, extras, extrasRef,
    maximized, setMaximized, layoutReady, setLayoutReady, preserveLayout, temporaryChats,
    active, translation, pdfs, reader, text, openColumns, verticalSplit, horizontalSplit, gridLayout,
    updateTabs, updateWorkspace, updateExtras, focusColumn, moveTab, collapseColumn, resetWorkspace, resizeWorkspace,
    resolveTranslationSource, setTranslationSource, addFeature, addDocument, patchText, activate,
    revealTranslation, openConversation, setTemporaryChat, removeFromWorkspace, workspaceSnapshot, cycleColumns,
  } = useWorkspaceStore({
    isExclusive: () => exclusive.current,
    onActiveChanged: previousId => {
      dismissToolbarMenus();
      panes.current.get(previousId)?.dismissSelectionMenu();
    },
    onActivateTab: id => {
      if (layoutRef.current.left) void panes.current.get(id)?.action('hide-navigation').catch(() => {});
    },
    onExitReading: () => setReading(false),
  });

  const layoutReadyRef = useRef(layoutReady);
  layoutReadyRef.current = layoutReady;
  const modalRef = useRef(false);

  function pendingNote(id: string) {
    const note = draftValues.current.get(id);
    return note && note.value !== note.draft.value ? note : undefined;
  }
  async function finishNote(tabId: string, draftId: string, value: string | null) {
    await panes.current.get(tabId)?.annotationNote(draftId, value);
    draftValues.current.delete(tabId);
    setAnnotations(previous => {
      const current = previous[tabId];
      return current?.draft?.id === draftId ? { ...previous, [tabId]: { ...current, draft: null } } : previous;
    });
  }
  function showAnnotations(id: string) {
    setNavigationId(id); setAnnotationTab(id); setReading(false); setLeft(true);
    void panes.current.get(id)?.action('hide-navigation').catch(() => {});
  }
  function applyLayout(value: Layout) {
    setLeft(value.left); setReading(value.reading); setTheme(value.theme);
    setAccent(value.accent ?? DEFAULT_ACCENT);
    setPreferredWidths({ left: value.leftWidth, right: value.rightWidth });
  }

  const {
    operation, missing, prompt, answerLeave, encodingFile, encodingError, answerEncoding,
    runOperation, queueOpen, scheduleProgress, openData, fileOpen, choose, openRecent, relocate, locateNote,
    exportTab, saveTab, closeTab, closeWindow, relocateWorkspace,
  } = useDocumentLifecycle({
    exclusiveRef: exclusive,
    tabsRef,
    workspaceRef,
    extrasRef,
    layoutReadyRef,
    preserveLayout,
    temporaryChats,
    updateTabs,
    updateWorkspace,
    updateExtras,
    focusColumn,
    addFeature,
    addDocument,
    patchText,
    activate,
    removeFromWorkspace,
    workspaceSnapshot,
    panes,
    editors,
    chatStops,
    prefsRef,
    layoutRef,
    fileInputRef: input,
    pickerColumnRef: pickerColumn,
    pendingNote,
    showAnnotations,
    finishNote,
    onCleanupPdfTab: id => {
      draftValues.current.delete(id);
      setAnnotations(previous => { const next = { ...previous }; delete next[id]; return next; });
      setAnnotationTab(previous => previous === id ? '' : previous);
    },
    onCleanupExtraTab: id => {
      setTranslationSignals(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
      setChatMaterials(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
    },
    onImagesDropped: (paths, x, y) => {
      const id = activeRef.current;
      if (modalRef.current) return;
      if (tabsRef.current.find(tab => tab.id === id)?.kind !== 'markdown') { setError('请在 Markdown 标签中拖入图片。'); return; }
      void insertImageBatch(id, () => Promise.all(paths.map(readDroppedImage)), editors.current.get(id)?.atCoordinates(x, y));
    },
    onInitLocal: snapshot => {
      applyLayout(snapshot.book.layout);
      const nextPreferences = { ...DEFAULT_READER_PREFERENCES, ...snapshot.book.preferences };
      setPreferences(nextPreferences);
      prefsRef.current = nextPreferences;
      setLocalReady(true);
    },
    onLayoutReady: () => setLayoutReady(true),
    onError: setError,
    onNotice: setNotice,
  });

  const navigationPdf = active?.kind === 'pdf' ? active : pdfs.find(tab => tab.id === navigationId) ?? pdfs.find(tab => tab.id === workspace.selected.upper);
  const navigationReader = navigationPdf?.state ?? null;
  const navigationTabId = navigationPdf?.id ?? '';
  const citationTab = tabs.find(tab => tab.id === citationId);
  const citationAdapter = panes.current.get(citationId);
  modalRef.current = settingsOpen || !!prompt || !!citationTab || !!encodingFile || !!translationConflict;

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
  function createText(kind: TextKind, column = workspaceRef.current.focus) {
    if (exclusive.current) return;
    const extension = kind === 'txt' ? '.txt' : '.md';
    let name = '未命名' + extension;
    for (let index = 2; tabsRef.current.some(tab => tab.name === name); index++) name = `未命名-${index}${extension}`;
    addDocument(newTextTab(kind, name), column);
  }
  function registerText(id: string, editor: TextEditor | null) {
    if (editor) editors.current.set(id, editor);
    else editors.current.delete(id);
  }
  function editText(id: string, source: string | undefined, position: TextTab['position']) {
    cursorStore.set(id, position);
    if (source !== undefined) patchText(id, { source });
  }
  function openSettings(section: SettingsSection = 'general') {
    dismissToolbarMenus();
    panes.current.get(activeRef.current)?.dismissSelectionMenu();
    setSettingsSection(section);
    setSettingsOpen(true);
  }
  function openCitation(id = activeRef.current) {
    if (exclusive.current || modalRef.current || !panes.current.get(id)?.hasDocument) return;
    dismissToolbarMenus();
    panes.current.get(id)?.dismissSelectionMenu();
    setCitationId(id);
  }
  function resizeNavigation(value: number) {
    setPreferredWidths(previous => ({ ...previous, left: Math.max(160, Math.min(widths.leftMax, value)) }));
  }
  async function changePreferences(value: ReaderPreferences) {
    setPreferences(value); prefsRef.current = value;
    try { await repository.savePreferences(value); } catch (error) { setError(String(error)); }
  }
  async function annotationAction(id: string, action: AnnotationAction, item: string, value?: number) {
    try { return await panes.current.get(id)?.annotationAction(action, item, value) ?? false; }
    catch (error) { setError(String(error)); return false; }
  }
  function updateDraft(id: string, value: string) {
    const note = draftValues.current.get(id);
    if (note) { note.value = value; refreshDraft(version => version + 1); }
  }
  function insertImages(id: string, files: File[], position?: number) {
    return insertImageBatch(id, async () => files, position);
  }
  async function insertImageBatch(id: string, makeFiles: () => Promise<File[]>, position?: number) {
    const tab = tabsRef.current.find(item => item.id === id);
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
  async function action(value: ReaderAction, id = activeRef.current) {
    const pane = panes.current.get(id);
    if (value === 'thumbnails') setLeft(false);
    try { await pane?.action(value); } catch (error) { setError(String(error)); }
  }
  async function position(id: string, page: number, zoom?: string) {
    const tab = tabsRef.current.find(item => item.id === id);
    if (tab?.kind !== 'pdf' || !tab.state) return;
    try { await panes.current.get(tab.id)?.restore(page, zoom || tab.state.zoom); } catch (error) { setError(String(error)); }
  }
  function register(id: string, pane: ReaderAdapter | null) {
    if (pane) panes.current.set(id, pane); else panes.current.delete(id);
  }
  function opened(id: string, state?: ReaderState, message?: string) {
    updateTabs(items => items.map(tab => tab.id === id && tab.kind === 'pdf' ? { ...tab, bytes: undefined, state: state || null, error: message } : tab));
    if (state) scheduleProgress(id);
  }
  function requestTranslation(pdfId: string) {
    const column = columnOf(workspaceRef.current, pdfId);
    if (!column) return;
    const id = revealTranslation(pdfId);
    const target = extrasRef.current.find(tab => tab.id === id);
    if (resolveTranslationSource(target?.source) !== pdfId) setTranslationSource(id, column);
    setTranslationSignals(previous => ({ ...previous, [id]: { pdf: pdfId, count: (previous[id]?.count ?? 0) + 1 } }));
  }
  function readerEvent(id: string, event: ReaderEvent) {
    const previous = tabsRef.current.find(tab => tab.id === id);
    if (previous?.kind !== 'pdf') return;
    if (event.type === 'state') {
      updateTabs(items => items.map(tab => tab.id === id && tab.kind === 'pdf' ? { ...tab, state: event.state } : tab));
      if (!previous.bytes && (previous.state?.page !== event.state.page || previous.state?.zoom !== event.state.zoom)) scheduleProgress(id);
    } else if (event.type === 'error') {
      setError(previous.name + '：' + event.message);
    } else if (event.type === 'export-requested') {
      void runOperation('exporting', () => exportTab(id));
    } else if (event.type === 'annotations') {
      const draft = event.workspace.draft;
      if (draft) {
        if (draftValues.current.get(id)?.draft.id !== draft.id) draftValues.current.set(id, { draft, value: draft.value });
      } else draftValues.current.delete(id);
      setAnnotations(current => ({ ...current, [id]: event.workspace }));
    } else if (event.type === 'file-open-requested') {
      void fileOpen([new File([new Uint8Array(event.bytes)], event.filename, { type: 'application/pdf' })]);
    } else if (event.type === 'focus') {
      const column = columnOf(workspaceRef.current, id);
      if (column && workspaceRef.current.selected[column] === id && workspaceRef.current.focus !== column) focusColumn(column);
    } else if (event.type === 'shortcut') {
      const column = columnOf(workspaceRef.current, id);
      if (column && workspaceRef.current.selected[column] === id && workspaceRef.current.focus !== column) focusColumn(column);
      if (id === activeRef.current) window.dispatchEvent(new KeyboardEvent('keydown', { ...event.keys, bubbles: true, cancelable: true }));
    } else if (id === activeRef.current) {
      if (event.type === 'annotations-open') showAnnotations(id);
      if (event.type === 'dismiss-menus') dismissToolbarMenus();
      if (event.type === 'translate-selection' && !exclusive.current && !modalRef.current) requestTranslation(id);
      if (event.type === 'ask-selection' && !exclusive.current && !modalRef.current) void attachMaterial(id, 'selection');
      if (event.type === 'selection-copied') setNotice('已复制选区');
      if (event.type === 'cite-document') openCitation(id);
    }
  }

  useGlobalShortcuts({
    isModalOpen: () => modalRef.current,
    isExclusive: () => exclusive.current,
    getActiveId: () => activeRef.current,
    hasPdfPane: id => panes.current.has(id),
    hasDocumentTab: id => tabsRef.current.some(tab => tab.id === id),
    getTextEditor: id => editors.current.get(id),
    getTabOrder: () => columns.flatMap(column => workspaceRef.current.order[column]),
    onDismissLinkPreview: id => panes.current.get(id)?.dismissLinkPreview(),
    onCycleColumns: cycleColumns,
    onRequestTranslation: requestTranslation,
    onChoose: () => { void choose(); },
    onSaveTab: (id, saveAs) => { void runOperation('saving', () => saveTab(id, saveAs)); },
    onCloseTab: id => { void closeTab(id); },
    onReaderUndoRedo: command => { void action(command); },
    onActivateTab: id => activate(id),
    hasUnsavedChanges: () => tabsRef.current.some(tab => isTabDirty(tab) || !!pendingNote(tab.id)),
  });

  useEffect(() => {
    if (!layoutReady || preserveLayout.current) return;
    const timer = setTimeout(() => { void repository.saveWorkspace(workspaceSnapshot()).catch(error => setError(String(error))); }, 500);
    return () => clearTimeout(timer);
  }, [workspace, extras, layoutReady, tabs.map(tab => tab.path).join('\u0000')]);
  useEffect(() => repository.subscribe(() => setLibrary(repository.snapshot)), []);
  useEffect(() => { const resize = () => setViewport(window.innerWidth); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
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
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(preferredWidths)); } catch {} }, [preferredWidths]);
  useEffect(() => {
    if (!localReady) return;
    const timer = setTimeout(() => { void repository.saveLayout(layoutRef.current).catch(() => {}); }, 400);
    return () => clearTimeout(timer);
  }, [localReady, left, reading, preferredWidths.left, preferredWidths.right, theme, accent]);
  useEffect(() => {
    if (!automatic) { automaticSignature.current = ''; return; }
    if (!layoutReady || !reader?.selection || settingsOpen || operation) return;
    const signature = JSON.stringify([activeId, reader.selection, reader.selectionAnchor]);
    if (signature === automaticSignature.current) return;
    automaticSignature.current = signature;
    if (!translation) revealTranslation(activeId);
  }, [automatic, layoutReady, activeId, reader?.selection, reader?.selectionAnchor, settingsOpen, operation, translation]);

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
      if (tab) return [{ ...tab, dirty: isTabDirty(tab) || !!pendingNote(id) }];
      const extra = extras.find(item => item.id === id);
      return extra ? [{ ...extra, dirty: false }] : [];
    });
    const selected = workspace.selected[column];
    const source = translation?.source ?? 'upper';
    const sourceId = resolveTranslationSource(source);
    const actions = translation && selected === translation.id ? <TranslationSource source={source} available={pdfs.some(pdf => pdf.id === sourceId && pdf.state)}
      canPin={!!sourceId} onFollow={target => setTranslationSource(translation.id, target)}
      onPin={() => { if (sourceId) setTranslationSource(translation.id, sourceId); }} />
      : column !== 'upper' ? documentTools(column) : null;
    return <WorkspaceTabs actions={actions} column={column} tabs={items} selected={workspace.selected[column]} busy={!!operation} maximized={maximized === column}
      onSelect={id => activate(id)} onClose={id => { void closeTab(id); }} onMove={moveTab} onOpen={() => { void choose(column); }}
      onNew={kind => { if (kind === 'translation') newTranslation(column); else if (kind === 'chat') addFeature(kind, column); else createText(kind, column); }}
      onCollapse={openColumns.length > 1 && !maximized ? () => collapseColumn(column) : undefined}
      onMaximize={() => { focusColumn(column); setMaximized(maximized === column ? null : column); }} onReset={resetWorkspace} />;
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

  return <div className={'app workspace' + (reading ? ' reading-mode' : '')}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { if (!isTauri()) setDragging(true); event.preventDefault(); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
    onDrop={event => { const handled = event.defaultPrevented; event.preventDefault(); setDragging(false); if (!handled && !isTauri()) void fileOpen([...event.dataTransfer.files]); }}
    onPaste={event => {
      if (event.defaultPrevented || modalRef.current || text?.kind !== 'markdown' || !isTauri()) return;
      const files = [...event.clipboardData.files].filter(isImage);
      if (files.length) { event.preventDefault(); void insertImages(text.id, files); }
    }}>
    <TitleBar busy={!!operation} layoutReady={layoutReady} navigationPressed={left && !reading}
      workspace={workspace} maximized={maximized}
      onOpen={() => { void choose(); }}
      onToggleNavigation={() => {
        const id = navigationTabId;
        void action('hide-navigation', id);
        setNavigationId(id); setReading(false); setAnnotationTab(''); setLeft(value => !!annotationTab || !value);
      }}
      onToggleColumn={column => { if (workspaceRef.current.collapsed[column]) focusColumn(column); else collapseColumn(column); }}
      onRestoreMaximized={() => setMaximized(null)}
      onResetWorkspace={resetWorkspace}
      onOpenSettings={() => openSettings()}
      onCloseWindow={() => { void closeWindow(); }}
      onError={setError} />
    <input ref={input} type="file" multiple accept={acceptDocuments} hidden onChange={event => { const files = [...(event.target.files || [])]; event.target.value = ''; if (files.length) void fileOpen(files, pickerColumn.current); }} />
    {isTauri() && tabs.some(tab => tab.kind === 'markdown') && <input ref={imageInput} type="file" multiple accept="image/*,.svg,.avif,.ico" hidden onChange={event => {
      const files = [...(event.target.files ?? [])]; event.target.value = '';
      if (files.length && imageTarget.current) void insertImages(imageTarget.current, files);
      imageTarget.current = '';
    }} />}
    {error && <div className="error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}><Dismiss20Regular /></button></div>}
    {notice && <div className="notice" role="status">{notice}<button aria-label="关闭通知" onClick={() => setNotice('')}><Dismiss20Regular /></button></div>}
    {library.problems.map(problem => <div className="local-problem" role="alert" key={problem.kind + problem.document}>
      <span>{problem.message}</span>
      <button onClick={() => { void repository.reload(); }}>重新载入</button>
      <button onClick={() => { void repository.recover(problem).then(setNotice).catch(error => setError(String(error))); }}>备份并恢复</button>
    </div>)}
    <main>
      {left && !reading && <div className="panel-shell navigation-shell" style={{ width: widths.left }}>
        <ResizeHandle side="left" width={widths.left} max={widths.leftMax} onResize={resizeNavigation} />
        {navigationReader && annotationTab === navigationTabId
          ? <AnnotationPanel key={navigationTabId} workspace={annotations[navigationTabId]} draftValue={draftValues.current.get(navigationTabId)?.value || ''}
            busy={!!operation} onClose={() => { setAnnotationTab(''); setLeft(false); }} onHistory={value => { void action(value, navigationTabId); }}
            onDraftValue={value => updateDraft(navigationTabId, value)}
            onNote={async (draftId, value) => { try { await finishNote(navigationTabId, draftId, value); } catch (error) { setError(String(error)); } }}
            onAction={(value, item, width) => annotationAction(navigationTabId, value, item, width)} />
          : <LibraryPanel snapshot={library} reader={navigationReader} onNavigate={index => panes.current.get(navigationTabId)?.navigate(index)}
            onRecent={recent => { void openRecent(recent); }} onRelocate={recent => { void relocate(recent); }}
            onNote={note => { void locateNote(note); }} onError={setError} />}
      </div>}
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
          {!workspace.selected[column] && (column === 'upper'
            ? <div className="welcome"><DocumentPdf20Regular /><h1>打开文档</h1><p>选择或拖入 PDF、Markdown 和 TXT 文件。</p><button className="primary" disabled={!!operation} onClick={() => { void choose(); }}><FolderOpen20Regular />打开文档</button><span>Ctrl + O 打开 · Ctrl + Tab 切换标签</span><button onClick={() => { void queueOpen(async () => { const response = await fetch('/pdfjs/web/compressed.tracemonkey-pldi-09.pdf'); if (!response.ok) throw Error('示例文件不可用'); await openData(new Uint8Array(await response.arrayBuffer()), '示例论文.pdf'); }); }}>阅读示例论文</button></div>
            : <p className="empty-column">用加号打开或新建标签。</p>)}
        </div>)}
        {horizontalSplit && !maximized && <WorkspaceSeparator vertical value={workspace.rightShare} onChange={value => resizeWorkspace('rightShare', value)} />}
        {verticalSplit && !maximized && <WorkspaceSeparator value={workspace.lowerShare} onChange={value => resizeWorkspace('lowerShare', value)} />}
        {tabs.map(tab => {
          const column = columnOf(workspace, tab.id);
          const visible = !!column && openColumns.includes(column) && workspace.selected[column] === tab.id;
          return <div className="workspace-slot" key={tab.id} data-column={column} style={{ gridArea: column }} hidden={!visible}
            onPointerDownCapture={() => { if (column && workspaceRef.current.focus !== column) focusColumn(column); }}
            onFocusCapture={() => { if (column && workspaceRef.current.focus !== column) focusColumn(column); }}>
            {tab.kind === 'pdf'
              ? <DocumentPane tab={tab} active={visible} linkPreviewActive={visible && !modalRef.current && !operation} theme={colorScheme} accent={accent} uiFontSize={preferences.uiFontSize} selectionToolbar={preferences.selectionPopup} register={register} onEvent={readerEvent} onOpened={opened} />
              : <TextPane tab={tab} active={visible} busy={!!operation} register={registerText} onEdit={editText}
                onMode={(id, mode) => patchText(id, { mode })} onImages={(id, files, position) => { void insertImages(id, files, position); }}
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
              {tab.kind === 'translation'
                ? <WorkspaceTranslation sourceId={resolveTranslationSource(tab.source)}
                  pdfs={pdfs} visible={visible} focusedPdf={active?.kind === 'pdf' ? active.id : ''} automatic={automatic}
                  signal={translationSignals[tab.id]} showMetadata={preferences.showMetadata} showOriginal={preferences.showOriginal}
                  onSettings={() => openSettings('translation')} disabled={!localReady || !!operation || settingsOpen} />
                : tab.kind === 'chat'
                  ? <ChatPane id={tab.id} visible={visible} incoming={chatMaterials[tab.id]} onReceive={() => setChatMaterials(previous => {
                    const next = { ...previous }; delete next[tab.id]; return next;
                  })} onTemporary={temporary => setTemporaryChat(tab.id, temporary)}
                    documents={tabs.map(item => ({ id: item.id, name: item.name, kind: item.kind }))}
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
    <StatusBar documentCount={tabs.length} reader={reader} hasPendingNote={!!pendingNote(activeId)} text={text} activeName={active?.name} />
    <SettingsDialog onClearChat={() => { void clearChatHistory().catch(error => setError(String(error))); }}
      onInstallUpdate={() => closeWindow(true)} installUpdateDisabled={!!operation || !layoutReady}
      open={settingsOpen} initialSection={settingsSection} onClose={() => setSettingsOpen(false)} theme={theme} onTheme={setTheme} accent={accent} onAccent={setAccent} preferences={preferences} onPreferences={value => { void changePreferences(value); }} automatic={automatic} onAutomatic={setAutomatic} documentKey={active?.kind === 'pdf' ? active.fingerprint : ''} />
    {citationTab && citationAdapter && <CitationDialog key={citationTab.id} documentName={citationTab.name} adapter={citationAdapter} onClose={() => setCitationId('')} />}
    {encodingFile && <EncodingDialog name={encodingFile} error={encodingError} onAnswer={answerEncoding} />}
    <ConfirmDialogs workspace={workspace} translationConflict={translationConflict} onAnswerTranslationConflict={answerTranslationConflict}
      prompt={prompt} fallbackIsText={!!text} onAnswerLeave={answerLeave} />
    {dragging && !isTauri() && <div className="drop-target">松开以在新标签打开文档</div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
