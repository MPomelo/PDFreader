import { useEffect, useRef, useState, type RefObject } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AnnotationDraft, ReaderAdapter } from './ReaderAdapter';
import type { PdfTab } from './DocumentPane';
import { mayLeaveDocument, type LeaveChoice } from './leave-document';
import { repository, digest, type Layout, type Note, type Recent, type ReaderPreferences } from '../local/repository';
import type { UnsavedPrompt } from '../ui/ConfirmDialogs';
import type { TextEditor } from '../text/TextPane';
import { cursorStore } from '../text/cursor-store';
import {
  chooseTextDestination, documentKind, openedTextTab, openBrowserText, openNativeText,
  saveBrowserText, textDirty, type OpenedText, type TextEncoding, type TextKind, type TextTab,
} from '../text/document';
import { saveNativeText } from '../text/attachments';
import { columnOf, readWorkspace, saveWorkspace, singleTranslation, type Column, type Resource, type Workspace } from '../workspace/layout';
import type { DocumentTab } from '../workspace/useWorkspaceStore';

export type LocalSnapshot = typeof repository.snapshot;

export type DocumentLifecycleOptions = {
  exclusiveRef: RefObject<boolean>;
  tabsRef: RefObject<DocumentTab[]>;
  workspaceRef: RefObject<Workspace>;
  extrasRef: RefObject<Resource[]>;
  layoutReadyRef: RefObject<boolean>;
  preserveLayout: RefObject<boolean>;
  temporaryChats: RefObject<Set<string>>;
  updateTabs: (mutate: (previous: DocumentTab[]) => DocumentTab[]) => void;
  updateWorkspace: (next: Workspace) => void;
  updateExtras: (next: Resource[]) => void;
  focusColumn: (column: Column, force?: boolean) => void;
  addFeature: (kind: 'translation' | 'chat', column: Column, source?: string) => string;
  addDocument: (tab: DocumentTab, column: Column, restoring?: boolean) => void;
  patchText: (id: string, patch: Partial<TextTab>) => void;
  activate: (id: string, force?: boolean) => void;
  removeFromWorkspace: (id: string) => void;
  workspaceSnapshot: (current?: Workspace) => ReturnType<typeof saveWorkspace>;
  panes: RefObject<Map<string, ReaderAdapter>>;
  editors: RefObject<Map<string, TextEditor>>;
  chatStops: RefObject<Map<string, () => Promise<void>>>;
  prefsRef: RefObject<ReaderPreferences>;
  layoutRef: RefObject<Layout>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  pickerColumnRef: RefObject<Column>;
  pendingNote: (id: string) => { draft: AnnotationDraft; value: string } | undefined;
  showAnnotations: (id: string) => void;
  finishNote: (tabId: string, draftId: string, value: string | null) => Promise<void>;
  onCleanupPdfTab: (id: string) => void;
  onCleanupExtraTab: (id: string) => void;
  onImagesDropped: (paths: string[], x: number, y: number) => void;
  onInitLocal: (snapshot: LocalSnapshot) => void;
  onLayoutReady: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
};

export function useDocumentLifecycle(options: DocumentLifecycleOptions) {
  const opts = useRef(options);
  opts.current = options;

  const [operation, setOperation] = useState('');
  const [missing, setMissing] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState<UnsavedPrompt | null>(null);
  const leaveAnswer = useRef<((choice: LeaveChoice) => void) | null>(null);
  const [encodingFile, setEncodingFile] = useState('');
  const [encodingError, setEncodingError] = useState('');
  const encodingAnswer = useRef<((value: TextEncoding | null) => void) | null>(null);
  const progressTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // 用启动就绪 Promise 与独占空闲等待队列替代定时轮询锁
  const [bootGate] = useState(() => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  });
  const idleWaiters = useRef<(() => void)[]>([]);
  const openQueue = useRef(Promise.resolve());

  function waitUntilIdle() {
    if (!opts.current.exclusiveRef.current) return Promise.resolve();
    return new Promise<void>(resolve => { idleWaiters.current.push(resolve); });
  }

  function notifyIdle() {
    const waiters = idleWaiters.current.splice(0);
    for (const resolve of waiters) resolve();
  }

  async function runOperation<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    if (opts.current.exclusiveRef.current) return;
    opts.current.exclusiveRef.current = true;
    setOperation(label);
    opts.current.onError('');
    opts.current.onNotice('');
    try {
      return await work();
    } catch (error) {
      opts.current.onError(String(error));
    } finally {
      opts.current.exclusiveRef.current = false;
      setOperation('');
      notifyIdle();
    }
  }

  function queueOpen(work: () => Promise<void>) {
    openQueue.current = openQueue.current.catch(() => {}).then(async () => {
      await bootGate.promise;
      while (opts.current.exclusiveRef.current) await waitUntilIdle();
      await runOperation('opening', work);
    });
    return openQueue.current;
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

  function answerLeave(choice: LeaveChoice) {
    const resolve = leaveAnswer.current;
    leaveAnswer.current = null;
    setPrompt(null);
    resolve?.(choice);
  }

  async function persist(tab: DocumentTab) {
    if (tab.kind === 'pdf' && tab.state) {
      await repository.progress({
        fingerprint: tab.fingerprint,
        name: tab.name,
        path: tab.path,
        page: tab.state.page,
        zoom: tab.state.zoom || 'auto',
        time: new Date().toISOString(),
      });
    }
  }

  function scheduleProgress(id: string) {
    clearTimeout(progressTimers.current.get(id));
    progressTimers.current.set(id, setTimeout(() => {
      progressTimers.current.delete(id);
      const tab = opts.current.tabsRef.current.find(item => item.id === id);
      if (tab) void persist(tab).catch(() => {});
    }, 500));
  }

  async function openData(
    bytes: Uint8Array,
    name: string,
    path = '',
    expected = '',
    page?: number,
    column = opts.current.workspaceRef.current.focus,
    restoredId?: string,
  ): Promise<string> {
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw Error(`${name} 不是有效的 PDF`);
    const fingerprint = await digest(bytes);
    if (expected && fingerprint !== expected) throw Error('所选文件内容不匹配，未替换旧记录。');
    const existing = opts.current.tabsRef.current.find((tab): tab is PdfTab =>
      tab.kind === 'pdf' && (path ? tab.path.toLowerCase() === path.toLowerCase() : !tab.path && tab.name === name && tab.fingerprint === fingerprint),
    );
    if (existing) {
      if (path) opts.current.updateTabs(items => items.map(tab => tab.id === existing.id ? { ...tab, path } : tab));
      opts.current.activate(existing.id, true);
      if (page && existing.state) await opts.current.panes.current.get(existing.id)?.restore(page, existing.state.zoom);
      return existing.id;
    }
    const saved = opts.current.prefsRef.current.restoreProgress
      ? repository.snapshot.book.recents.find(item => item.fingerprint === fingerprint)
      : null;
    const id = restoredId ?? crypto.randomUUID();
    opts.current.addDocument({
      kind: 'pdf',
      id,
      name,
      path,
      fingerprint,
      bytes,
      initialPage: page || saved?.page || 1,
      initialZoom: saved?.zoom || opts.current.prefsRef.current.defaultZoom,
      state: null,
    }, column, !!restoredId);
    return id;
  }

  async function openText(
    kind: TextKind,
    load: (encoding?: TextEncoding) => Promise<OpenedText>,
    column = opts.current.workspaceRef.current.focus,
    restoredId?: string,
  ) {
    let file = await load();
    setEncodingError('');
    const existing = opts.current.tabsRef.current.find(tab => tab.kind !== 'pdf' && file.path && tab.path.toLowerCase() === file.path.toLowerCase());
    if (existing) {
      opts.current.activate(existing.id, true);
      return existing.id;
    }
    while (file.content === null) {
      const encoding = await selectEncoding(file.name);
      if (!encoding) return '';
      try { file = await load(encoding); }
      catch (error) { setEncodingError(String(error)); }
    }
    const tab = openedTextTab(kind, file);
    if (restoredId) tab.id = restoredId;
    opts.current.addDocument(tab, column, !!restoredId);
    return tab.id;
  }

  async function openPath(
    path: string,
    expected = '',
    page?: number,
    column = opts.current.workspaceRef.current.focus,
    restoredId?: string,
  ) {
    const kind = documentKind(path);
    if (!kind) throw Error('请选择 PDF、Markdown 或 TXT 文件');
    if (kind !== 'pdf') {
      if (expected) throw Error('请选择匹配的 PDF 文件');
      return openText(kind, encoding => openNativeText(path, encoding), column, restoredId);
    }
    const meta = await invoke<{ name: string; path: string }>('resolve_pdf_meta', { path });
    const buffer = await invoke<ArrayBuffer>('read_pdf_bytes', { path: meta.path });
    return openData(new Uint8Array(buffer), meta.name, meta.path, expected, page, column, restoredId);
  }

  async function openPaths(paths: string[], column = opts.current.workspaceRef.current.focus) {
    for (const path of paths) {
      try { await openPath(path, '', undefined, column); }
      catch (error) { opts.current.onError(String(error)); }
    }
  }

  function fileOpen(files: File[], column = opts.current.workspaceRef.current.focus) {
    return queueOpen(async () => {
      for (const file of files) {
        try {
          const kind = documentKind(file.name);
          if (kind === 'pdf') await openData(new Uint8Array(await file.arrayBuffer()), file.name, '', '', undefined, column);
          else if (kind) await openText(kind, encoding => openBrowserText(file, encoding), column);
          else throw Error(`不支持此文档格式：${file.name}`);
        } catch (error) {
          opts.current.onError(String(error));
        }
      }
    });
  }

  async function choose(column = opts.current.workspaceRef.current.focus) {
    opts.current.pickerColumnRef.current = column;
    opts.current.focusColumn(column);
    if (!isTauri()) { opts.current.fileInputRef.current?.click(); return; }
    await runOperation('choosing', async () => {
      const paths = await invoke<string[]>('choose_documents');
      await openPaths(paths, column);
    });
  }

  async function openRecent(recent: Recent) {
    await queueOpen(async () => {
      if (!recent.path || !isTauri()) throw Error('请重新选择同一 PDF，以恢复阅读进度。');
      await openPath(await invoke<string>('reopen_pdf', { path: recent.path }));
    });
  }

  async function relocate(recent: Recent) {
    if (!isTauri()) { opts.current.fileInputRef.current?.click(); return; }
    await runOperation('choosing', async () => {
      const path = await invoke<string | null>('choose_pdf');
      if (path) await openPath(path, recent.fingerprint);
    });
  }

  async function locateNote(note: Note) {
    await queueOpen(async () => {
      const opened = opts.current.tabsRef.current.find((tab): tab is PdfTab => tab.kind === 'pdf' && tab.fingerprint === note.fingerprint);
      if (opened) {
        opts.current.activate(opened.id, true);
        if (opened.state) await opts.current.panes.current.get(opened.id)?.restore(note.page, opened.state.zoom);
        return;
      }
      const recent = repository.snapshot.book.recents.find(item => item.fingerprint === note.fingerprint);
      if (!recent?.path || !isTauri()) throw Error('请先打开这条笔记对应的 PDF。');
      await openPath(await invoke<string>('reopen_pdf', { path: recent.path }), note.fingerprint, note.page);
    });
  }

  async function exportTab(id: string): Promise<boolean> {
    const tab = opts.current.tabsRef.current.find(item => item.id === id);
    const pane = opts.current.panes.current.get(id);
    if (tab?.kind !== 'pdf' || !tab.state || !pane) return false;
    const note = opts.current.pendingNote(id);
    if (note) {
      opts.current.showAnnotations(id);
      if (!note.value.trim()) throw Error('请填写、取消或删除当前注释后再导出。');
      await opts.current.finishNote(id, note.draft.id, note.value);
    }
    setOperation('exporting');
    const { bytes, token } = await pane.export();
    const suggestedName = tab.name.replace(/\.pdf$/i, '') + '-批注.pdf';
    let destination: string | null;
    if (isTauri()) {
      destination = await invoke<string | null>('export_pdf', { bytes: Array.from(bytes), suggestedName });
    } else {
      const picker = (window as any).showSaveFilePicker;
      if (!picker) {
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = suggestedName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        opts.current.onNotice('已发起下载，尚无法确认文件落盘。');
        return false;
      }
      let file;
      try {
        file = await picker({ suggestedName, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      } catch (error) {
        if ((error as DOMException).name === 'AbortError') return false;
        throw error;
      }
      const writable = await file.createWritable();
      try {
        await writable.write(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }));
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
      destination = file.name;
    }
    if (!destination) {
      opts.current.onNotice('已取消导出，批注仍保留在标签中。');
      return false;
    }
    const state = await pane.markExported(token);
    opts.current.updateTabs(items => items.map(item => item.id === id && item.kind === 'pdf' ? { ...item, state } : item));
    opts.current.onNotice('已导出 ' + destination);
    return !state.dirty;
  }

  async function saveTab(id: string, saveAs = false): Promise<boolean> {
    const tab = opts.current.tabsRef.current.find(item => item.id === id);
    if (!tab) return false;
    if (tab.kind === 'pdf') return exportTab(id);
    if (!saveAs && (tab.path || tab.handle) && !textDirty(tab)) return true;
    setOperation('saving');
    if (isTauri()) {
      const destination = saveAs || !tab.path ? await chooseTextDestination(tab) : { path: tab.path, revision: tab.revision };
      if (!destination) return false;
      if (opts.current.tabsRef.current.some(item => item.id !== id && item.path && item.path.toLowerCase() === destination.path.toLowerCase())) {
        throw Error('目标文件已在另一个标签中打开，请选择其他文件。');
      }
      if (destination.path.toLowerCase() === tab.path.toLowerCase()) destination.revision = tab.revision;
      const saved = await saveNativeText(tab, destination);
      opts.current.editors.current.get(id)?.apply(saved.changes);
      opts.current.patchText(id, saved.tab);
      opts.current.onNotice('已保存 ' + saved.tab.name);
    } else {
      const saved = await saveBrowserText(tab, saveAs);
      if (!saved) return false;
      opts.current.patchText(id, saved);
      opts.current.onNotice('已保存 ' + saved.name);
    }
    return true;
  }

  async function mayClose(tab: DocumentTab) {
    const pane = opts.current.panes.current.get(tab.id);
    if (tab.kind === 'pdf' && (!tab.state || !pane)) return true;
    return mayLeaveDocument(
      async () => ({ dirty: tab.kind === 'pdf' ? !!opts.current.pendingNote(tab.id) || (await pane!.flush()).dirty : textDirty(tab) }),
      () => {
        opts.current.activate(tab.id, true);
        return new Promise<LeaveChoice>(resolve => {
          leaveAnswer.current = resolve;
          setPrompt({ id: tab.id, name: tab.name, kind: tab.kind });
        });
      },
      () => saveTab(tab.id),
    );
  }

  async function closeTab(id: string) {
    if (opts.current.exclusiveRef.current) return;
    if (!opts.current.tabsRef.current.some(tab => tab.id === id)) {
      await opts.current.chatStops.current.get(id)?.();
      opts.current.updateExtras(opts.current.extrasRef.current.filter(tab => tab.id !== id));
      setMissing(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)));
      opts.current.temporaryChats.current.delete(id);
      opts.current.onCleanupExtraTab(id);
      opts.current.removeFromWorkspace(id);
      return;
    }
    await runOperation('closing', async () => {
      const tab = opts.current.tabsRef.current.find(item => item.id === id);
      if (!tab || !await mayClose(tab)) return;
      await persist(tab).catch(() => {});
      clearTimeout(progressTimers.current.get(id));
      progressTimers.current.delete(id);
      cursorStore.delete(id);
      opts.current.onCleanupPdfTab(id);
      opts.current.updateTabs(items => items.filter(item => item.id !== id));
      opts.current.removeFromWorkspace(id);
    });
  }

  async function closeWindow(installUpdate = false) {
    return runOperation('closing', async () => {
      const initialWorkspace = opts.current.workspaceRef.current;
      for (const tab of [...opts.current.tabsRef.current]) {
        if (!await mayClose(tab)) return;
        await persist(opts.current.tabsRef.current.find(item => item.id === tab.id) || tab).catch(() => {});
      }
      await Promise.all([...opts.current.chatStops.current.values()].map(stop => stop()));
      await repository.saveLayout(opts.current.layoutRef.current).catch(() => {});
      if (opts.current.layoutReadyRef.current && !opts.current.preserveLayout.current) {
        await repository.saveWorkspace(opts.current.workspaceSnapshot(initialWorkspace)).catch(() => {});
      }
      await repository.flush();
      if (installUpdate) return invoke<void>('update_install').catch(error => String(error));
      await invoke('finish_close');
    });
  }

  async function relocateWorkspace(resource: Resource) {
    const column = columnOf(opts.current.workspaceRef.current, resource.id);
    if (!column) return;
    await runOperation('choosing', async () => {
      const paths = resource.kind === 'pdf'
        ? [await invoke<string | null>('choose_pdf')]
        : await invoke<string[]>('choose_documents');
      const path = paths.find(value => value && documentKind(value) === resource.kind);
      if (!path) return;
      const id = await openPath(path, resource.fingerprint ?? '', undefined, column, resource.id);
      if (!id) return;
      opts.current.updateExtras(opts.current.extrasRef.current.filter(tab => tab.id !== resource.id));
      setMissing(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== resource.id)));
      if (id !== resource.id) opts.current.removeFromWorkspace(resource.id);
    });
  }

  const handlersRef = useRef({ closeWindow, openPaths, openPath, queueOpen, runOperation });
  handlersRef.current = { closeWindow, openPaths, openPath, queueOpen, runOperation };

  // 启动恢复、本地数据初始化与 Tauri 原生文件事件订阅
  useEffect(() => {
    let disposed = false;
    const releases: (() => void)[] = [];
    const local = repository.init().then(snapshot => {
      if (!disposed) opts.current.onInitLocal(snapshot);
      return snapshot;
    });
    const restore = local.then(async snapshot => {
      if (disposed) return false;
      const saved = readWorkspace(snapshot.book.workspace);
      const wasOpen = Boolean(snapshot.book.layout.right);
      function recoverLegacyTranslation() {
        const focus = opts.current.workspaceRef.current.focus;
        const column = opts.current.workspaceRef.current.order.right.length ? 'lower' : 'right';
        opts.current.addFeature('translation', column, 'upper');
        opts.current.focusColumn(focus, true);
      }
      if (!saved) {
        opts.current.preserveLayout.current = snapshot.book.workspace !== undefined;
        if (!opts.current.preserveLayout.current && wasOpen) recoverLegacyTranslation();
        if (opts.current.preserveLayout.current) {
          opts.current.onNotice('无法读取上次的工作区布局。已使用默认布局，原记录仍保留。');
        }
        return false;
      }
      const restored = singleTranslation(saved);
      opts.current.updateWorkspace(restored);
      opts.current.updateExtras(restored.resources.filter(resource => resource.kind === 'chat' || resource.kind === 'translation'));
      if (wasOpen && !opts.current.extrasRef.current.some(tab => tab.kind === 'translation')) recoverLegacyTranslation();
      if (isTauri()) {
        await handlersRef.current.runOperation('opening', async () => {
          for (const resource of restored.resources) {
            if (!resource.path) continue;
            try {
              const path = await invoke<string>('reopen_workspace_document', { path: resource.path });
              if (!await handlersRef.current.openPath(path, '', undefined, columnOf(restored, resource.id), resource.id)) {
                throw Error('未选择文件编码');
              }
            } catch (error) {
              opts.current.updateExtras([...opts.current.extrasRef.current, resource]);
              setMissing(previous => ({ ...previous, [resource.id]: String(error) }));
            }
          }
        });
      }
      return true;
    }).finally(() => {
      if (!disposed) {
        bootGate.resolve();
        opts.current.onLayoutReady();
      }
    });

    if (isTauri()) {
      void (async () => {
        for (const [name, callback] of [
          ['images-dropped', (event: { payload: { paths: string[]; x: number; y: number } }) => {
            const { paths, x, y } = event.payload;
            opts.current.onImagesDropped(paths, x, y);
          }],
          ['pdfs-dropped', (event: { payload: string[] }) => {
            void handlersRef.current.queueOpen(() => handlersRef.current.openPaths(event.payload));
          }],
          ['pdfs-queued', () => {
            void handlersRef.current.queueOpen(async () => {
              const batch = await invoke<{ paths: string[]; errors: string[] }>('startup_pdfs');
              if (batch.errors.length) opts.current.onError(batch.errors.join('\n'));
              await handlersRef.current.openPaths(batch.paths);
            });
          }],
          ['pdf-open-error', (event: { payload: string }) => opts.current.onError(event.payload)],
          ['close-requested', () => { void handlersRef.current.closeWindow(); }],
        ] as const) {
          const release = await listen<any>(name, callback);
          if (disposed) release(); else releases.push(release);
        }
        try {
          const snapshot = await local;
          const restored = await restore;
          const batch = await invoke<{ paths: string[]; errors: string[] }>('startup_pdfs');
          if (disposed) return;
          if (batch.errors.length) opts.current.onError(batch.errors.join('\n'));
          if (batch.paths.length) {
            await handlersRef.current.queueOpen(() => handlersRef.current.openPaths(batch.paths));
          } else if (!restored && opts.current.prefsRef.current.restoreProgress) {
            const recent = snapshot.book.recents.find(item => item.path);
            if (recent) {
              const path = await invoke<string>('reopen_pdf', { path: recent.path });
              await handlersRef.current.queueOpen(() => handlersRef.current.openPaths([path]));
            }
          }
        } catch (error) {
          if (!disposed) opts.current.onError(String(error));
        }
      })().catch(error => {
        if (!disposed) opts.current.onError(String(error));
      });
    }

    return () => {
      disposed = true;
      releases.forEach(release => release());
      progressTimers.current.forEach(clearTimeout);
    };
  }, [bootGate]);

  return {
    operation,
    missing,
    prompt,
    answerLeave,
    encodingFile,
    encodingError,
    answerEncoding,
    runOperation,
    queueOpen,
    persist,
    scheduleProgress,
    openData,
    openText,
    openPath,
    openPaths,
    fileOpen,
    choose,
    openRecent,
    relocate,
    locateNote,
    exportTab,
    saveTab,
    closeTab,
    closeWindow,
    relocateWorkspace,
  };
}
