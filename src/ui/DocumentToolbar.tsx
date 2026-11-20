import { useEffect, useState } from 'react';
import { FolderOpen20Regular, SaveArrowRight20Regular, PanelLeft20Regular, ChevronLeft20Regular, ChevronRight20Regular, ZoomIn20Regular, ZoomOut20Regular, Highlight20Regular, TextUnderline20Regular, TextStrikethrough20Regular, TextT20Regular as Text20Regular, Edit20Regular as DrawShape20Regular, Comment20Regular, Translate20Regular, Wrench20Regular, Settings20Regular, Search20Regular, Cursor20Regular, Print20Regular, ArrowRotateClockwise20Regular, BookOpen20Regular } from '@fluentui/react-icons';
import type { ReaderAction, ReaderState } from '../reader/ReaderAdapter';

const moreTools: ReadonlyArray<{ label: string; items: ReadonlyArray<readonly [ReaderAction, string]> }> = [
  { label: '页面', items: [['first-page', '首页'], ['last-page', '末页'], ['rotate-left', '逆时针旋转']] },
  { label: '光标', items: [['cursor-select', '选择文字'], ['cursor-hand', '手形拖动']] },
  { label: '滚动方式', items: [['scroll-page', '逐页滚动'], ['scroll-vertical', '垂直滚动'], ['scroll-horizontal', '水平滚动'], ['scroll-wrapped', '多页滚动']] },
  { label: '页面布局', items: [['spread-none', '单页'], ['spread-odd', '双页（奇数页在左）'], ['spread-even', '双页（偶数页在左）']] },
  { label: '文档', items: [['document-properties', '文档属性']] },
];

export function DocumentToolbar({ reader, busy, left, right, reading, onOpen, onExport, onLeft, onRight, onReading, onSettings, onAction, onPosition, onComment, onComments }: { reader: ReaderState | null; busy: boolean; left: boolean; right: boolean; reading: boolean; onOpen: () => void; onExport: () => void; onLeft: () => void; onRight: () => void; onReading: () => void; onSettings: () => void; onAction: (action: ReaderAction) => void; onPosition: (page: number, zoom?: string) => void; onComment: () => void; onComments: () => void }) {
  const [page, setPage] = useState('');
  useEffect(() => setPage(reader ? String(reader.page) : ''), [reader?.page, reader?.documentId]);
  const disabled = !reader || busy;
  function commit() { const value = Number(page); if (reader && Number.isSafeInteger(value) && value >= 1 && value <= reader.pages) { if (value !== reader.page) onPosition(value); } else setPage(reader ? String(reader.page) : ''); }
  const zoom = reader?.zoom || 'auto', options = [['auto','自动'],['page-width','适合页宽'],['page-fit','适合页面'],['1','100%'],['1.25','125%'],['1.5','150%'],['2','200%']];
  function dismissMenu(event: React.MouseEvent<HTMLDivElement>) { if ((event.target as Element).closest('button')) event.currentTarget.parentElement?.removeAttribute('open'); }
  return <header className="document-toolbar" aria-label="文档工具栏">
    <div className="toolbar-group file-group"><button aria-label="文档导航" aria-pressed={left && !reading} title="目录、最近文件与笔记" onClick={onLeft}><PanelLeft20Regular /><span>文档</span></button><button disabled={busy} title="打开 PDF (Ctrl+O)" onClick={onOpen}><FolderOpen20Regular /><span>打开</span></button><button disabled={disabled} title="另存带批注的副本 (Ctrl+S)" onClick={onExport}><SaveArrowRight20Regular /><span>导出</span></button></div>
    <div className="toolbar-group paging-group"><button aria-label="上一页" title="上一页" disabled={disabled || reader?.page === 1} onClick={() => onAction('previous')}><ChevronLeft20Regular /></button><label className="page-control"><input aria-label="页码" inputMode="numeric" value={page} disabled={disabled} onChange={event => setPage(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') setPage(reader ? String(reader.page) : ''); }} /><span>/ {reader?.pages || '—'}</span></label><button aria-label="下一页" title="下一页" disabled={disabled || reader?.page === reader?.pages} onClick={() => onAction('next')}><ChevronRight20Regular /></button></div>
    <div className="toolbar-group zoom-group"><button aria-label="缩小" title="缩小" disabled={disabled} onClick={() => onAction('zoom-out')}><ZoomOut20Regular /></button><select aria-label="缩放" disabled={disabled} value={zoom} onChange={event => { if (reader) onPosition(reader.page, event.target.value); }}>{options.map(([value,label]) => <option key={value} value={value}>{label}</option>)}{!options.some(([value]) => value === zoom) && <option value={zoom}>{Math.round(Number(zoom) * 100)}%</option>}</select><button aria-label="放大" title="放大" disabled={disabled} onClick={() => onAction('zoom-in')}><ZoomIn20Regular /></button></div>
    <div className="toolbar-group action-group"><button aria-label="查找" title="查找文档文字 (Ctrl+F)" disabled={disabled} onClick={() => onAction('find')}><Search20Regular /></button><details className="toolbar-menu"><summary role="button" title="批注工具" aria-label="批注工具"><Highlight20Regular /><span>批注</span></summary>
      <div className="command-menu" onClick={dismissMenu} onMouseDown={event => event.preventDefault()}>
        <button disabled={disabled} onClick={() => onAction('select')}><Cursor20Regular />选择文字</button>
        <button disabled={disabled} onClick={() => onAction('highlight')}><Highlight20Regular />高亮</button>
        <button disabled={disabled || !reader?.selection} onClick={() => onAction('underline')}><TextUnderline20Regular />下划线</button>
        <button disabled={disabled || !reader?.selection} onClick={() => onAction('strikeout')}><TextStrikethrough20Regular />删除线</button>
        <button disabled={disabled} onClick={() => onAction('text')}><Text20Regular />添加文本</button>
        <button disabled={disabled} onClick={() => onAction('ink')}><DrawShape20Regular />画笔</button>
        <button disabled={disabled || !reader?.selection} onClick={onComment}><Comment20Regular />为选区写注释</button>
        <button disabled={disabled} onClick={onComments}><Comment20Regular />注释列表</button>
      </div></details><button disabled={disabled} aria-label="翻译侧栏" title="打开或关闭译文" aria-pressed={right && !reading} onClick={onRight}><Translate20Regular /><span>翻译</span></button></div>
    <div className="toolbar-group utilities-group">
      <details className="toolbar-menu" onToggle={event => {
        if (event.target === event.currentTarget && !event.currentTarget.open) event.currentTarget.querySelector('.more-pdf-tools')?.removeAttribute('open');
      }}>
        <summary role="button" aria-label="阅读工具" title="阅读工具"><Wrench20Regular /><span>工具</span></summary>
        <div className="command-menu" onClick={dismissMenu}>
          <button disabled={disabled} onClick={() => onAction('thumbnails')}>页面缩略图</button>
          <button disabled={disabled} onClick={() => onAction('rotate')}><ArrowRotateClockwise20Regular />旋转页面</button>
          <button disabled={disabled} onClick={() => onAction('print')}><Print20Regular />打印</button>
          <button aria-pressed={reading} onClick={onReading}><BookOpen20Regular />{reading ? '退出专注阅读' : '专注阅读'}</button>
          {!disabled && <details className="more-pdf-tools"><summary role="button">更多 PDF 工具</summary>
            {moreTools.map(group => <section key={group.label} aria-label={group.label}>
              <p>{group.label}</p>
              {group.items.map(([action, label]) => <button key={action} onClick={() => onAction(action)}>{label}</button>)}
            </section>)}
          </details>}
        </div>
      </details>
      <button aria-label="设置" title="设置" onClick={onSettings}><Settings20Regular /><span>设置</span></button>
    </div>
  </header>;
}
