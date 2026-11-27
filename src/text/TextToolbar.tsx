import {
  Edit16Regular, Eye16Regular, ImageAdd20Regular, LayoutColumnTwo16Regular,
  Search20Regular, Save20Regular, TextEditStyle20Regular,
} from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import type { TextMode, TextTab } from './document';

const modes: [TextMode, string][] = [['edit', '编辑'], ['preview', '预览'], ['split', '左右分栏']];
const compactModes: [TextMode, string, ReactNode][] = [
  ['edit', '编辑', <Edit16Regular key="edit" />],
  ['split', '分栏', <LayoutColumnTwo16Regular key="split" />],
  ['preview', '预览', <Eye16Regular key="preview" />],
];

export function TextToolbar({ tab, busy, attachments, compact = false, onSave, onFind, onUndo, onRedo, onWrap, onMode, onImage, onUtf8 }: {
  tab: TextTab;
  busy: boolean;
  attachments: boolean;
  compact?: boolean;
  onSave: (saveAs: boolean) => void;
  onFind: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onWrap: () => void;
  onMode: (mode: TextMode) => void;
  onImage: () => void;
  onUtf8: () => void;
}) {
  const save = <button type="button" disabled={busy} onClick={() => onSave(false)} aria-label="保存" title="保存 (Ctrl+S)"><Save20Regular />{!compact && '保存'}</button>;
  const find = <button type="button" disabled={busy} onClick={onFind} aria-label="查找替换" title="查找替换 (Ctrl+F)"><Search20Regular />{!compact && '查找替换'}</button>;
  const tools = <>
    <div className="toolbar-group">
      {!compact && save}
      <button type="button" disabled={busy} onClick={() => onSave(true)} title="另存为 (Ctrl+Shift+S)">另存为</button>
    </div>
    <div className="toolbar-group">
      {!compact && find}
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
  </>;
  if (compact) return <div className="compact-document-actions">
    {tab.kind === 'markdown' && <div className="compact-text-modes" role="group" aria-label="Markdown 视图切换">
      {compactModes.map(([value, label, icon]) => (
        <button type="button" key={value} disabled={busy} aria-label={label} title={label} aria-pressed={tab.mode === value} onClick={() => onMode(value)}>
          {icon}
        </button>
      ))}
    </div>}
    {save}{find}
    <details className="toolbar-menu compact-document-menu">
      <summary role="button" aria-label="文本工具" title="文本工具"><TextEditStyle20Regular /></summary>
      <div className="compact-document-popup document-toolbar text-toolbar" role="group" aria-label="文本工具栏">{tools}</div>
    </details>
  </div>;
  return <div role="toolbar" className="document-toolbar text-toolbar" aria-label="文本工具栏">{tools}</div>;
}
