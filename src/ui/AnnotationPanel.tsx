import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRedo20Regular, ArrowUndo20Regular, Delete20Regular, Dismiss20Regular, Edit20Regular } from '@fluentui/react-icons';
import type { AnnotationAction, AnnotationEntry, AnnotationWorkspace } from '../reader/ReaderAdapter';

const labels: Record<AnnotationEntry['kind'], string> = {
  highlight: '高亮', underline: '下划线', strikeout: '删除线', comment: '注释', freetext: '文本框', ink: '画笔',
};

type Props = {
  workspace?: AnnotationWorkspace;
  draftValue: string;
  busy: boolean;
  onClose: () => void;
  onHistory: (action: 'undo' | 'redo') => void;
  onDraftValue: (value: string) => void;
  onNote: (id: string, value: string | null) => Promise<void>;
  onAction: (action: AnnotationAction, id: string, value?: number) => Promise<boolean>;
};

export function AnnotationPanel({ workspace, draftValue, busy, onClose, onHistory, onDraftValue, onNote, onAction }: Props) {
  const [all, setAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [widthEditor, setWidthEditor] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const draft = workspace?.draft;
  useEffect(() => { if (draft) input.current?.focus(); }, [draft?.id]);
  const disabled = busy || sending;

  async function run(task: () => Promise<unknown>) {
    setSending(true);
    try { await task(); } finally { setSending(false); }
  }
  function noteKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || disabled || !draft) return;
    if (event.key === 'Escape' || event.key === 'Enter' && (event.ctrlKey || event.metaKey) && draftValue.trim()) {
      event.preventDefault();
      void run(() => onNote(draft.id, event.key === 'Escape' ? null : draftValue));
    }
  }
  const entries = workspace?.entries.filter(item => all || item.changed) || [];
  const pages = new Map<number, AnnotationEntry[]>();
  for (const item of entries) {
    const items = pages.get(item.page);
    if (items) items.push(item);
    else pages.set(item.page, [item]);
  }

  return <aside className="annotation-panel" aria-label="批注管理">
    <div className="panel-heading">
      <h2>{draft ? (draft.readOnly ? '查看注释' : draft.existing ? '编辑注释' : '添加注释') : '管理批注'}</h2>
      <button aria-label="关闭批注侧栏" title="关闭侧栏" onClick={onClose}><Dismiss20Regular /></button>
    </div>
    {draft ? <>
      <p className="annotation-meta">第 {draft.page} 页</p>
      {draft.quote && <blockquote>{draft.quote}</blockquote>}
      {draft.readOnly ? <>
        <p className="annotation-note">{draft.value}</p>
        <button disabled={disabled} onClick={() => void run(() => onNote(draft.id, null))}>返回批注列表</button>
      </> : <form onSubmit={event => {
        event.preventDefault();
        if (!disabled && draftValue.trim()) void run(() => onNote(draft.id, draftValue));
      }}>
        <label className="field">注释内容
          <textarea ref={input} value={draftValue} rows={7} onChange={event => onDraftValue(event.target.value)} onKeyDown={noteKey} />
        </label>
        <div className="panel-actions">
          <button type="submit" className="primary" disabled={disabled || !draftValue.trim()}>保存批注</button>
          <button type="button" disabled={disabled} onClick={() => void run(() => onNote(draft.id, null))}>取消</button>
        </div>
      </form>}
    </> : <>
      <div className="annotation-controls">
        <button aria-pressed={!all} onClick={() => setAll(false)}>本次修改</button>
        <button aria-pressed={all} onClick={() => setAll(true)}>全部批注</button>
        <button aria-label="撤销批注" title="撤销" disabled={disabled || !workspace?.undo} onClick={() => onHistory('undo')}><ArrowUndo20Regular /></button>
        <button aria-label="重做批注" title="重做" disabled={disabled || !workspace?.redo} onClick={() => onHistory('redo')}><ArrowRedo20Regular /></button>
      </div>
      {!!workspace?.deleted && <p className="annotation-meta">待导出的删除操作 · {workspace.deleted} 项</p>}
      {!entries.length && <p className="hint">{workspace ? (all ? '此文档暂无批注。' : '暂无未导出的批注。') : '正在读取批注…'}</p>}
      {[...pages].map(([page, items]) => <section key={page} className="annotation-page">
        <h3>第 {page} 页</h3>
        {items.map(item => {
          const label = labels[item.kind];
          return <div key={item.id} className="annotation-item">
            <div className="annotation-item-row">
              <button className="annotation-entry" disabled={disabled} onClick={() => void run(() => onAction('locate', item.id))} title="定位到批注">
                <strong>{label}{item.lastPage ? ` · 至第 ${item.lastPage} 页` : ''}</strong>
                {(item.text || item.quote) && <span>{item.text || item.quote}</span>}
              </button>
              {item.editable && (item.kind === 'comment' || item.kind === 'freetext') && <button disabled={disabled} aria-label={`编辑${label}`} title={`编辑${label}`} onClick={() => void run(() => onAction('edit', item.id))}><Edit20Regular /></button>}
              {item.editable && <button disabled={disabled} aria-label={`删除${label}`} title={`删除${label}`} onClick={() => void run(() => onAction('delete', item.id))}><Delete20Regular /></button>}
            </div>
            {!!item.width && item.editable && (widthEditor === item.id
              ? <form className="annotation-width" onSubmit={event => {
                event.preventDefault();
                const width = Number(new FormData(event.currentTarget).get('width'));
                void run(async () => { if (await onAction('resize', item.id, width)) setWidthEditor(undefined); });
              }}>
                <label>宽度（pt） <input type="number" min="12" name="width" defaultValue={item.width} required /></label>
                <button type="submit" disabled={disabled}>应用</button>
              </form>
              : <button className="annotation-width-button" disabled={disabled} onClick={() => setWidthEditor(item.id)}>调整宽度</button>)}
          </div>;
        })}
      </section>)}
    </>}
  </aside>;
}
