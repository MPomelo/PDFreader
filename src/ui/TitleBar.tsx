import { isTauri } from '@tauri-apps/api/core';
import { FolderOpen20Regular, PanelLeft20Regular, Settings20Regular, WindowMultiple20Regular } from '@fluentui/react-icons';
import { columns, columnName, type Column, type Workspace } from '../workspace/layout';
import { WindowControls } from './WindowControls';

const brandIcon = new URL('../../src-tauri/icons/app-icon.svg', import.meta.url).href;

type Props = {
  busy: boolean;
  layoutReady: boolean;
  navigationPressed: boolean;
  workspace: Workspace;
  maximized: Column | null;
  onOpen: () => void;
  onToggleNavigation: () => void;
  onToggleColumn: (column: Column) => void;
  onRestoreMaximized: () => void;
  onResetWorkspace: () => void;
  onOpenSettings: () => void;
  onCloseWindow: () => void;
  onError: (message: string) => void;
};

export function TitleBar({
  busy, layoutReady, navigationPressed, workspace, maximized,
  onOpen, onToggleNavigation, onToggleColumn, onRestoreMaximized,
  onResetWorkspace, onOpenSettings, onCloseWindow, onError,
}: Props) {
  return <div className="workspace-title-bar">
    <div className="workspace-brand" data-tauri-drag-region>
      <img src={brandIcon} width={21} height={21} alt="" />
      <strong>PDFreader</strong>
    </div>
    <button className="window-command" disabled={busy} title="打开文档 (Ctrl+O)" onClick={onOpen}>
      <FolderOpen20Regular />打开
    </button>
    <button className="window-command window-navigation" aria-label="文档导航" title="目录、最近文件与笔记"
      aria-pressed={navigationPressed} onClick={onToggleNavigation}>
      <PanelLeft20Regular />
    </button>
    <div className="workspace-drag" data-tauri-drag-region aria-hidden="true" />
    <details className="toolbar-menu workspace-layout-menu">
      <summary role="button" aria-label="布局" title="布局"><WindowMultiple20Regular />布局</summary>
      <div className="command-menu" onClick={event => {
        if ((event.target as Element).closest('button')) event.currentTarget.parentElement?.removeAttribute('open');
      }}>
        {columns.map(column => <button key={column} type="button" aria-label={columnName[column]}
          aria-pressed={!workspace.collapsed[column]}
          disabled={!workspace.collapsed[column] && columns.filter(item => !workspace.collapsed[item]).length === 1}
          onClick={() => onToggleColumn(column)}>
          {workspace.collapsed[column] ? '显示' : '收起'}{columnName[column]}
        </button>)}
        {maximized && <button onClick={onRestoreMaximized}>恢复三栏布局</button>}
        <button onClick={onResetWorkspace}>恢复默认比例</button>
      </div>
    </details>
    <button className="window-command" aria-label="设置" title="设置" onClick={onOpenSettings}>
      <Settings20Regular />设置
    </button>
    {isTauri() && <WindowControls busy={busy || !layoutReady} onClose={onCloseWindow} onError={onError} />}
  </div>;
}
