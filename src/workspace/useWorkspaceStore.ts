import { useRef, useState, type CSSProperties } from 'react';
import type { PdfTab } from '../reader/DocumentPane';
import { textDirty, type TextTab } from '../text/document';
import { conversationName, type Conversation } from '../chat/model';
import { columns, columnOf, defaultWorkspace, move, remove, saveWorkspace, select, type Column, type Resource, type Workspace } from './layout';

export type DocumentTab = PdfTab | TextTab;

export function isTabDirty(tab: DocumentTab) {
  return tab.kind === 'pdf' ? Boolean(tab.state?.dirty) : textDirty(tab);
}

type WorkspaceStoreOptions = {
  isExclusive: () => boolean;
  onActiveChanged: (previousId: string) => void;
  onActivateTab: (id: string) => void;
  onExitReading: () => void;
};

export function useWorkspaceStore(options: WorkspaceStoreOptions) {
  const callbacks = useRef(options);
  callbacks.current = options;

  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const tabsRef = useRef<DocumentTab[]>([]);
  const [activeId, setActiveId] = useState('');
  const activeRef = useRef('');
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  const workspaceRef = useRef(workspace);
  const [extras, setExtras] = useState<Resource[]>([]);
  const extrasRef = useRef(extras);
  const [maximized, setMaximized] = useState<Column | null>(null);
  const maximizedRef = useRef(maximized);
  maximizedRef.current = maximized;
  const [layoutReady, setLayoutReady] = useState(false);
  const preserveLayout = useRef(false);
  const lastPdf = useRef<Record<Column, string>>({ upper: '', lower: '', right: '' });
  const temporaryChats = useRef(new Set<string>());

  function updateTabs(mutate: (previous: DocumentTab[]) => DocumentTab[]) {
    const next = mutate(tabsRef.current);
    tabsRef.current = next;
    setTabs(next);
  }

  function updateWorkspace(next: Workspace) {
    workspaceRef.current = next;
    for (const column of columns) {
      if (tabsRef.current.some(tab => tab.kind === 'pdf' && tab.id === next.selected[column])) {
        lastPdf.current[column] = next.selected[column];
      }
    }
    setWorkspace(next);
    const id = next.selected[next.focus];
    if (activeRef.current !== id) callbacks.current.onActiveChanged(activeRef.current);
    activeRef.current = id;
    setActiveId(id);
  }

  function updateExtras(next: Resource[]) {
    extrasRef.current = next;
    setExtras(next);
  }

  function focusColumn(column: Column, force = false) {
    if (callbacks.current.isExclusive() && !force) return;
    if (maximizedRef.current && maximizedRef.current !== column) setMaximized(null);
    updateWorkspace(select(workspaceRef.current, column));
  }

  function moveTab(id: string, column: Column, before?: string) {
    if (callbacks.current.isExclusive() || !columnOf(workspaceRef.current, id)) return;
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

  function resizeWorkspace(key: 'rightShare' | 'lowerShare', value: number) {
    updateWorkspace({ ...workspaceRef.current, [key]: Math.max(0.15, Math.min(0.85, value)) });
  }

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

  function patchText(id: string, patch: Partial<TextTab>) {
    updateTabs(items => items.map(tab => tab.id === id && tab.kind !== 'pdf' ? { ...tab, ...patch } : tab));
  }

  function activate(id: string, force = false) {
    if (callbacks.current.isExclusive() && !force) return;
    const column = columnOf(workspaceRef.current, id);
    if (!column) return;
    if (maximizedRef.current && maximizedRef.current !== column) setMaximized(null);
    updateWorkspace(select(workspaceRef.current, column, id));
    callbacks.current.onActivateTab(id);
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
    callbacks.current.onExitReading();
    return id;
  }

  function openConversation(conversation: Conversation) {
    if (extrasRef.current.some(tab => tab.id === conversation.id)) {
      activate(conversation.id);
      return;
    }
    updateExtras([...extrasRef.current, { id: conversation.id, kind: 'chat', name: conversationName(conversation) }]);
    updateWorkspace(move(workspaceRef.current, conversation.id, workspaceRef.current.focus));
  }

  function setTemporaryChat(id: string, temporary: boolean) {
    if (temporary) temporaryChats.current.add(id);
    else temporaryChats.current.delete(id);
    updateExtras([...extrasRef.current]);
  }

  function removeFromWorkspace(id: string) {
    updateWorkspace(remove(workspaceRef.current, id));
  }

  function workspaceSnapshot(current = workspaceRef.current) {
    const documents: Resource[] = tabsRef.current.filter(tab => tab.path).map(tab => ({
      id: tab.id,
      kind: tab.kind,
      name: tab.name,
      path: tab.path,
      fingerprint: tab.kind === 'pdf' ? tab.fingerprint : undefined,
    }));
    return saveWorkspace(
      current,
      [...documents, ...extrasRef.current.filter(tab => tab.kind !== 'chat' || !temporaryChats.current.has(tab.id))],
    );
  }

  function cycleColumns(reverse: boolean) {
    const visible = columns.filter(column => !workspaceRef.current.collapsed[column] && (!maximizedRef.current || maximizedRef.current === column));
    const index = visible.indexOf(workspaceRef.current.focus);
    const next = visible[(index + (reverse ? visible.length - 1 : 1)) % visible.length];
    if (!next) return;
    focusColumn(next);
    const id = workspaceRef.current.selected[next];
    (document.getElementById('document-tab-' + id) ?? document.querySelector<HTMLElement>(`.workspace-column[data-column="${next}"] .new-document > button`))?.focus();
  }

  const active = tabs.find(tab => tab.id === activeId) || null;
  const translation = extras.find(tab => tab.kind === 'translation');
  const pdfs = tabs.filter((tab): tab is PdfTab => tab.kind === 'pdf');
  const reader = active?.kind === 'pdf' ? active.state : null;
  const text = active && active.kind !== 'pdf' ? active : null;
  const openColumns = columns.filter(column => !workspace.collapsed[column] && (!maximized || maximized === column));
  const showUpper = openColumns.includes('upper');
  const showLower = openColumns.includes('lower');
  const showRight = openColumns.includes('right');
  const verticalSplit = showUpper && showLower;
  const horizontalSplit = showRight && (showUpper || showLower);
  const leftColumn = showUpper ? 'upper' : 'lower';
  const gridLayout: CSSProperties = {
    gridTemplateAreas: maximized ? `"${maximized}"` : verticalSplit
      ? horizontalSplit ? '"upper divider-right right" "divider-lower divider-right right" "lower divider-right right"' : '"upper" "divider-lower" "lower"'
      : horizontalSplit ? `"${leftColumn} divider-right right"` : `"${openColumns[0] ?? 'upper'}"`,
    gridTemplateRows: verticalSplit ? `minmax(88px, ${1 - workspace.lowerShare}fr) 5px minmax(88px, ${workspace.lowerShare}fr)` : 'minmax(0, 1fr)',
    gridTemplateColumns: horizontalSplit ? `minmax(135px, ${1 - workspace.rightShare}fr) 5px minmax(136px, ${workspace.rightShare}fr)` : 'minmax(0, 1fr)',
  };

  return {
    tabs, tabsRef,
    activeId, activeRef,
    workspace, workspaceRef,
    extras, extrasRef,
    maximized, maximizedRef, setMaximized,
    layoutReady, setLayoutReady,
    preserveLayout, temporaryChats,
    active, translation, pdfs, reader, text,
    openColumns, verticalSplit, horizontalSplit, gridLayout,
    updateTabs, updateWorkspace, updateExtras,
    focusColumn, moveTab, collapseColumn, resetWorkspace, resizeWorkspace,
    resolveTranslationSource, setTranslationSource,
    addFeature, addDocument, patchText, activate,
    revealTranslation, openConversation, setTemporaryChat,
    removeFromWorkspace, workspaceSnapshot, cycleColumns,
  };
}
