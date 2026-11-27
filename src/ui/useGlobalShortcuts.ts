import { useEffect, useRef } from 'react';
import { shortcutTabId } from '../reader/tabs';
import type { TextEditor } from '../text/TextPane';

export function dismissToolbarMenus() {
  document.querySelectorAll('.toolbar-menu[open]').forEach(menu => menu.removeAttribute('open'));
  document.querySelectorAll<HTMLElement>('.new-document-menu:popover-open').forEach(menu => menu.hidePopover());
}

export type GlobalShortcutsOptions = {
  isModalOpen: () => boolean;
  isExclusive: () => boolean;
  getActiveId: () => string;
  hasPdfPane: (id: string) => boolean;
  hasDocumentTab: (id: string) => boolean;
  getTextEditor: (id: string) => TextEditor | undefined;
  getTabOrder: () => string[];
  onDismissLinkPreview: (id: string) => void;
  onCycleColumns: (reverse: boolean) => void;
  onRequestTranslation: (id: string) => void;
  onChoose: () => void;
  onSaveTab: (id: string, saveAs: boolean) => void;
  onCloseTab: (id: string) => void;
  onReaderUndoRedo: (command: 'undo' | 'redo') => void;
  onActivateTab: (id: string) => void;
  hasUnsavedChanges: () => boolean;
};

export function useGlobalShortcuts(options: GlobalShortcutsOptions) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const api = latest.current;
      if (event.key === 'Escape') {
        dismissToolbarMenus();
        api.onDismissLinkPreview(api.getActiveId());
      }
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'F6' && !api.isModalOpen() && !api.isExclusive()) {
        event.preventDefault();
        api.onCycleColumns(event.shiftKey);
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      const value = event.key.toLowerCase();
      if (api.isModalOpen()) {
        if (value === 'w' || value === 'tab') event.preventDefault();
        return;
      }
      if (api.isExclusive()) return;
      const activeId = api.getActiveId();
      if (event.shiftKey && event.key === 'Enter' && api.hasPdfPane(activeId)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        api.onRequestTranslation(activeId);
      } else if (value === 'o') {
        event.preventDefault();
        api.onChoose();
      } else if (value === 's' && api.hasDocumentTab(activeId)) {
        event.preventDefault();
        api.onSaveTab(activeId, event.shiftKey);
      } else if (value === 'f' && api.getTextEditor(activeId)) {
        event.preventDefault();
        api.getTextEditor(activeId)?.find();
      } else if (value === 'w') {
        event.preventDefault();
        if (activeId) api.onCloseTab(activeId);
      } else if ((value === 'z' || value === 'y') && !event.altKey && activeId &&
        !(event.target instanceof Element && event.target.closest('input,textarea,[contenteditable=true]'))) {
        event.preventDefault();
        const command = value === 'y' || event.shiftKey ? 'redo' : 'undo';
        const editor = api.getTextEditor(activeId);
        if (editor) editor[command]();
        else api.onReaderUndoRedo(command);
      } else if (value === 'tab' || /^[1-9]$/.test(value)) {
        event.preventDefault();
        api.onActivateTab(shortcutTabId(api.getTabOrder(), activeId, value === 'tab' ? 'Tab' : value, event.shiftKey));
      }
    };

    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (latest.current.hasUnsavedChanges()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };

    const dismissMenus = (event: PointerEvent) => {
      if (!(event.target as Element).closest('.toolbar-menu')) dismissToolbarMenus();
    };

    window.addEventListener('keydown', keydown, true);
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('pointerdown', dismissMenus);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('pointerdown', dismissMenus);
    };
  }, []);
}
