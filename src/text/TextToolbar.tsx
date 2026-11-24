import { FolderOpen20Regular, ImageAdd20Regular, Search20Regular, Save20Regular, Settings20Regular } from '@fluentui/react-icons';
import type { TextMode, TextTab } from './document';

const modes: [TextMode, string][] = [['edit', '编辑'], ['preview', '预览'], ['split', '左右分栏']];

export function TextToolbar({ tab, busy, attachments, onOpen, onSave, onFind, onUndo, onRedo, onWrap, onMode, onImage, onUtf8, onSettings }: {
  tab: TextTab;
  busy: boolean;
  attachments: boolean;
  onOpen: () => void;
  onSave: (saveAs: boolean) => void;
  onFind: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onWrap: () => void;
  onMode: (mode: TextMode) => void;
  onImage: () => void;
  onUtf8: () => void;
  onSettings: () => void;
}) {
  return <header className="document-toolbar text-toolbar" aria-label="文本工具栏">
    <div className="toolbar-group">
      <button type="button" disabled={busy} onClick={onOpen} title="打开 (Ctrl+O)"><FolderOpen20Regular />打开</button>
      <button type="button" disabled={busy} onClick={() => onSave(false)} title="保存 (Ctrl+S)"><Save20Regular />保存</button>
      <button type="button" disabled={busy} onClick={() => onSave(true)} title="另存为 (Ctrl+Shift+S)">另存为</button>
    </div>
    <div className="toolbar-group">
      <button type="button" disabled={busy} onClick={onFind} title="查找替换 (Ctrl+F)"><Search20Regular />查找替换</button>
      <details className="toolbar-menu">
        <summary role="button">文本</summary>
        <div className="command-menu" onClick={event => {
          if ((event.target as Element).closest('button')) event.currentTarget.parentElement?.removeAttribute('open');
        }}>
          <button type="button" disabled={busy} onClick={onUndo}>撤销</button>
          <button type="button" disabled={busy} onClick={onRedo}>重做</button>
          <button type="button" disabled={busy} aria-pressed={tab.wrap} onClick={onWrap}>自动换行</button>
          {(tab.encoding !== 'UTF-8' || tab.bom) && <button type="button" disabled={busy} onClick={onUtf8}>转换为 UTF-8</button>}
        </div>
      </details>
    </div>
    {tab.kind === 'markdown' && <div className="toolbar-group text-modes" role="group" aria-label="Markdown 显示模式">
      {modes.map(([value, label]) => <button type="button" key={value} disabled={busy} aria-pressed={tab.mode === value} onClick={() => onMode(value)}>{label}</button>)}
      {attachments && <button type="button" disabled={busy} onClick={onImage}><ImageAdd20Regular />插入图片</button>}
    </div>}
    <div className="toolbar-group utilities-group">
      <button type="button" aria-label="设置" title="设置" onClick={onSettings}><Settings20Regular />设置</button>
    </div>
  </header>;
}
