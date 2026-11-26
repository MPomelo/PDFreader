import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Add20Regular, Chat20Regular, ChevronDown20Regular, Dismiss20Regular, DocumentPdf20Regular, DocumentText20Regular, MoreHorizontal20Regular, Translate20Regular } from '@fluentui/react-icons';
import { columns, columnName, type Column } from './layout';

export type HeaderTab = { id: string; kind: string; name: string; path?: string; dirty?: boolean };
const dragType = 'application/x-pdfreader-tab';

export function WorkspaceTabs({ column, tabs, selected, busy, onSelect, onClose, onMove, onOpen, onNew, onCollapse, onMaximize, maximized, onReset, actions }: {
  column: Column; tabs: HeaderTab[]; selected: string; busy: boolean; maximized: boolean; actions?: ReactNode;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onMove: (id: string, column: Column, before?: string) => void;
  onOpen: () => void; onNew: (kind: 'markdown' | 'txt' | 'translation' | 'chat') => void;
  onCollapse?: () => void; onMaximize: () => void; onReset: () => void;
}) {
  const compact = column !== 'upper';
  const addMenuId = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  const addMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const button = addButton.current!;
    const menu = addMenu.current!;
    const columnHeader = button.closest('.column-tabs')!;
    const grid = button.closest('.workspace-grid')!;
    const gap = 4;
    function placeMenu() {
      if (!menu.matches(':popover-open')) {
        delete menu.dataset.positioned;
        return;
      }
      const anchor = button.getBoundingClientRect();
      const pane = columnHeader.getBoundingClientRect();
      const workspace = grid.getBoundingClientRect();
      const left = pane.left + gap;
      const right = pane.right - gap;
      menu.style.maxWidth = Math.max(0, right - left) + 'px';
      menu.style.left = Math.max(left, Math.min(anchor.left, right - menu.getBoundingClientRect().width)) + 'px';

      const below = workspace.bottom - anchor.bottom - 2 * gap;
      const above = anchor.top - workspace.top - 2 * gap;
      const height = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
      const openAbove = below < height && above > below;
      menu.style.maxHeight = Math.max(0, Math.min(420, openAbove ? above : below)) + 'px';
      menu.style.top = (openAbove ? anchor.top - gap - menu.offsetHeight : anchor.bottom + gap) + 'px';
      menu.dataset.positioned = '';
    }
    const resize = new ResizeObserver(placeMenu);
    for (const element of [button, menu, columnHeader, grid]) resize.observe(element);
    menu.addEventListener('toggle', placeMenu);
    window.addEventListener('resize', placeMenu);
    return () => {
      menu.removeEventListener('toggle', placeMenu);
      window.removeEventListener('resize', placeMenu);
      resize.disconnect();
    };
  }, []);
  return <div className="column-tabs" data-compact={compact} onDragOver={event => {
    if (event.dataTransfer.types.includes(dragType)) event.preventDefault();
  }} onDrop={event => {
    const id = event.dataTransfer.getData(dragType);
    if (!id) return;
    event.preventDefault();
    const before = (event.target as Element).closest<HTMLElement>('[data-tab-id]')?.dataset.tabId;
    onMove(id, column, before);
  }}>
    <div className="document-tabs" role="tablist" aria-label={column === 'upper' ? '文档标签' : columnName[column] + '标签'}>
      {tabs.map((tab, index) => <div className={'document-tab' + (tab.id === selected ? ' selected' : '')} key={tab.id} data-tab-id={tab.id}
        draggable={!busy} onDragStart={event => { event.dataTransfer.setData(dragType, tab.id); event.dataTransfer.effectAllowed = 'move'; }}>
        <button id={'document-tab-' + tab.id} role="tab" aria-label={tab.name} aria-controls={'document-pane-' + tab.id}
          aria-selected={tab.id === selected} tabIndex={tab.id === selected ? 0 : -1} title={tab.path || tab.name} onClick={() => onSelect(tab.id)}
          onKeyDown={event => {
            const targets: Record<string, number> = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 };
            const next = tabs[targets[event.key]];
            if (!next) return;
            event.preventDefault(); onSelect(next.id); document.getElementById('document-tab-' + next.id)?.focus();
          }}>
          {tab.kind === 'translation' ? <Translate20Regular /> : tab.kind === 'chat' ? <Chat20Regular />
            : tab.kind === 'pdf' ? <DocumentPdf20Regular /> : <DocumentText20Regular />}
          <span>{tab.name}</span>{tab.dirty && <span className="dirty-dot" aria-label={tab.kind === 'pdf' ? '有未导出修改' : '有未保存修改'} />}
        </button>
        <button className="close-document" aria-label={'关闭 ' + tab.name} title={'关闭 ' + tab.name} disabled={busy} onClick={() => onClose(tab.id)}><Dismiss20Regular /></button>
      </div>)}
    </div>
    <div className="toolbar-menu new-document">
      <button type="button" ref={addButton} popoverTarget={addMenuId}
        aria-label={column === 'upper' ? '新建或打开文档' : columnName[column] + '新建或打开文档'}><Add20Regular /></button>
      <div id={addMenuId} ref={addMenu} className="command-menu new-document-menu" popover="auto" onClick={event => {
        if ((event.target as Element).closest('button') && event.currentTarget.matches(':popover-open')) event.currentTarget.hidePopover();
      }}>
        <button disabled={busy} onClick={onOpen}>打开文档</button>
        <button disabled={busy} onClick={() => onNew('markdown')}>新建 Markdown</button>
        <button disabled={busy} onClick={() => onNew('txt')}>新建 TXT</button>
        <button disabled={busy} onClick={() => onNew('translation')}>新建译文</button>
        <button disabled={busy} onClick={() => onNew('chat')}>新建 AI 对话</button>
      </div>
    </div>
    <div className="column-header-actions">
      {actions}
      {selected && <details className="toolbar-menu workspace-tab-menu">
        <summary role="button" aria-label={columnName[column] + '标签操作'} title={columnName[column] + '标签操作'}><MoreHorizontal20Regular /></summary>
        <div className="command-menu" onClick={event => {
          if ((event.target as Element).closest('button')) event.currentTarget.parentElement?.removeAttribute('open');
        }}>
          {columns.filter(target => target !== column).map(target => <button key={target} disabled={busy} onClick={() => onMove(selected, target)}>移到{columnName[target]}</button>)}
          <button onClick={onMaximize}>{maximized ? '恢复三栏布局' : '最大化' + columnName[column]}</button>
          <button onClick={onReset}>恢复默认比例</button>
        </div>
      </details>}
      {onCollapse && <button type="button" aria-label={'收起' + columnName[column]} title={'收起' + columnName[column]} onClick={onCollapse}><ChevronDown20Regular /></button>}
    </div>
  </div>;
}

export function WorkspaceSeparator({ vertical, value, onChange }: { vertical?: boolean; value: number; onChange: (value: number) => void }) {
  return <div className={'workspace-separator ' + (vertical ? 'workspace-separator-right' : 'workspace-separator-lower')} role="separator"
    tabIndex={0} aria-orientation={vertical ? 'vertical' : 'horizontal'} aria-label={vertical ? '调整右栏宽度' : '调整下栏高度'}
    aria-valuenow={Math.round(value * 100)} aria-valuemin={15} aria-valuemax={85}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      document.documentElement.classList.add('resizing-panels');
    }}
    onPointerMove={event => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
      onChange(vertical ? (bounds.right - event.clientX) / bounds.width : (bounds.bottom - event.clientY) / bounds.height);
    }}
    onLostPointerCapture={() => document.documentElement.classList.remove('resizing-panels')}
    onKeyDown={event => {
      const directions: Record<string, number> = vertical ? { ArrowLeft: 1, ArrowRight: -1 } : { ArrowUp: 1, ArrowDown: -1 };
      if (!directions[event.key]) return;
      event.preventDefault(); onChange(value + directions[event.key] * (event.shiftKey ? 0.1 : 0.02));
    }}
    onDoubleClick={() => onChange(vertical ? 0.34 : 0.4)} />;
}
