import { useEffect, useRef, useState } from 'react';
import { Dismiss20Regular, ArrowDownload20Regular, Delete20Regular, History20Regular, Note20Regular, TextBulletListLtr20Regular } from '@fluentui/react-icons';
import { MarkdownRenderer } from '../translation/MarkdownRenderer';
import { repository, exportNotes, type Note, type Recent, type Snapshot } from './repository';
import type { ReaderState } from '../reader/ReaderAdapter';
export function LibraryPanel({ snapshot, reader, onNavigate, onRecent, onRelocate, onNote, onError }: { snapshot: Snapshot; reader: ReaderState | null; onNavigate: (index: number) => void; onRecent: (recent: Recent) => void; onRelocate: (recent: Recent) => void; onNote: (note: Note) => void; onError: (message: string) => void }) {
  const [tab, setTab] = useState<'outline' | 'recent' | 'notes'>('outline');
  const [opened, setOpened] = useState<Note | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (opened && !dialog.current?.open) dialog.current?.showModal(); }, [opened]);
  const act = (promise: Promise<unknown>) => { void promise.catch(error => onError(String(error))); };
  async function copy(value: string) { try { await navigator.clipboard.writeText(value); } catch { onError('复制失败，可使用导出 Markdown'); } }
  return <aside id="left-panel" className="navigation" aria-label="文档导航面板">
    <h2>文档导航</h2>
    <div className="library-tabs" role="tablist" aria-label="本地文档"><button role="tab" aria-selected={tab === 'outline'} title="文档目录" onClick={() => setTab('outline')}><TextBulletListLtr20Regular />目录</button><button role="tab" aria-selected={tab === 'recent'} title="最近文件" onClick={() => setTab('recent')}><History20Regular />最近</button><button role="tab" aria-selected={tab === 'notes'} title="本地翻译笔记" onClick={() => setTab('notes')}><Note20Regular />笔记</button></div>
    {tab === 'outline' && <nav>{reader?.outline.length ? reader.outline.map(item => <button key={item.index} onClick={() => onNavigate(item.index)}>{item.title}</button>) : <p className="muted">{reader ? '此文档没有目录' : '打开 PDF 后查看目录'}</p>}</nav>}
    {tab === 'recent' && <div>{!snapshot.book.recents.length && <p className="hint">打开的文档将在这里保留阅读进度。</p>}{snapshot.book.recents.map(recent => <article className="library-item" key={recent.fingerprint}>
      <button className="recent-open" title={recent.path || recent.name} onClick={() => onRecent(recent)}>{recent.name}</button><p className="muted">第 {recent.page} 页 · {new Date(recent.time).toLocaleDateString()}</p><div className="panel-actions"><button onClick={() => onRelocate(recent)}>重新定位</button><button onClick={() => act(repository.removeRecent(recent.fingerprint))}>移除记录</button></div>
    </article>)}</div>}
    {tab === 'notes' && <div><button disabled={!snapshot.notes.length} title="导出全部笔记为 Markdown" onClick={() => act(exportNotes(snapshot.notes))}><ArrowDownload20Regular />导出全部笔记</button><p className="muted">{snapshot.notes.length} 条 · 清缓存不会删除笔记</p>{!snapshot.notes.length && <p className="hint">完成翻译后点击“保存为笔记”。</p>}{snapshot.notes.map(note => <article className="library-item" key={note.id}><button title={note.original} onClick={() => setOpened(note)}>{note.name} · 第 {note.page} 页</button><p className="note-excerpt">{note.original.slice(0,110)}</p><p className="muted">{note.model}</p></article>)}</div>}
    {opened && <dialog ref={dialog} className="note-overlay" aria-label="翻译笔记" onCancel={event => { event.preventDefault(); setOpened(null); }}>
      <div className="note-sheet"><div className="panel-heading"><h2>{opened.name} · 第 {opened.page} 页</h2><button autoFocus aria-label="关闭笔记" title="关闭笔记" onClick={() => setOpened(null)}><Dismiss20Regular /></button></div><p className="muted">{opened.service} · {opened.model} · {new Date(opened.time).toLocaleString()}</p><details><summary>原文</summary><p className="selection">{opened.originalRaw}</p></details><MarkdownRenderer source={opened.markdown} onCopy={value => { void copy(value); }} /><div className="panel-actions"><button onClick={() => { onNote(opened); setOpened(null); }}>定位到原文页</button><button onClick={() => { void copy(opened.markdown); }}>复制 Markdown / LaTeX</button><button onClick={() => act(exportNotes([opened]))}><ArrowDownload20Regular />导出此笔记</button><button onClick={() => { act(repository.deleteNote(opened.id)); setOpened(null); }}><Delete20Regular />删除笔记</button></div></div>
    </dialog>}
  </aside>;
}
