import { useEffect, useRef, useState } from 'react';
import { Dismiss20Regular, Copy20Regular } from '@fluentui/react-icons';
import type { ReaderAdapter } from '../reader/ReaderAdapter';
import { EMPTY_CITATION, FORMATS, formatCitation, type CitationData, type CitationFormat, type CitationKind } from './format';
import './citation.css';

const kinds = { '': '未指定', article: '期刊论文', conference: '会议论文', book: '图书', report: '报告' } as const;

export function CitationDialog({ documentName, adapter, onClose }: {
  documentName: string; adapter: ReaderAdapter; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const output = useRef<HTMLTextAreaElement>(null);
  const [fields, setFields] = useState<CitationData>(EMPTY_CITATION);
  const [format, setFormat] = useState<CitationFormat>(FORMATS[0]);
  const [loading, setLoading] = useState(true);
  const [inferred, setInferred] = useState({ title: false, doi: false });
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    dialog.current?.showModal();
    void adapter.citationMetadata().then(({ inferredTitle, inferredDOI, ...metadata }) => {
      if (cancelled) return;
      setFields(metadata);
      setInferred({ title: inferredTitle, doi: inferredDOI });
    }).catch(() => {
      if (!cancelled) setNotice('读取 PDF 元数据失败。可手动填写。');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [adapter]);

  const year = fields.year.trim();
  const doi = fields.doi.trim().replace(/^(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/iu, '');
  const invalid = year && !/^\d{4}$/u.test(year) ? '出版年应为四位数字。' :
    doi && !/^10\.\d{4,9}\/[^\s<>]+$/iu.test(doi) ? '请输入有效的 DOI。' : '';
  const citation = loading || invalid ? '' : formatCitation({ ...fields, title: fields.title.trim(), year, doi,
    container: fields.container.trim(), publisher: fields.publisher.trim(), volume: fields.volume.trim(),
    issue: fields.issue.trim(), pages: fields.pages.trim(), url: fields.url.trim(),
  }, format);
  const update = (name: keyof CitationData, value: string) => {
    setFields(previous => ({ ...previous, [name]: value }));
    if (name === 'title' || name === 'doi') setInferred(previous => ({ ...previous, [name]: false }));
    setNotice('');
  };
  function close() {
    dialog.current?.close();
    onClose();
  }
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw Error('Clipboard unavailable');
      await navigator.clipboard.writeText(citation);
    } catch {
      output.current?.select();
      try {
        if (!document.execCommand('copy')) throw Error('Copy unavailable');
      } catch { setNotice('请按 Ctrl+C 复制已选中的引文。'); return; }
    }
    setNotice('已复制引文。');
  }
  const input = (field: Exclude<keyof CitationData, 'kind' | 'authors'>, label: string, maxLength = 500) =>
    <label className="field">{label}<input type="text" value={fields[field]} onChange={event => update(field, event.target.value)} maxLength={maxLength}
      inputMode={field === 'year' ? 'numeric' : undefined} /></label>;
  return <dialog ref={dialog} className="citation-dialog" aria-labelledby="citation-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="settings-title"><h1 id="citation-title">生成引文</h1><button autoFocus aria-label="关闭引文" onClick={close}><Dismiss20Regular /></button></header>
    <div className="citation-body">
      <p className="citation-document" title={documentName}>{documentName}</p>
      {loading && <p role="status">正在读取 PDF 元数据…</p>}
      <fieldset className="citation-fields" disabled={loading}>
        <div className="citation-field-wide">{input('title', '标题', 1000)}
          {inferred.title && <p className="citation-hint">标题来自首页版面，请核对。</p>}
        </div>
        <label className="field citation-field-wide">作者<textarea value={fields.authors} onChange={event => update('authors', event.target.value)} rows={2} maxLength={8000} placeholder="每行一位作者，也可用分号分隔" /></label>
        <label className="field">文献类型<select value={fields.kind} onChange={event => update('kind', event.target.value as CitationKind)}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {input('year', '出版年', 4)}
        {(fields.kind === 'article' || fields.kind === 'conference' || !fields.kind) && input('container', '期刊或会议名称')}
        {fields.kind !== 'article' && input('publisher', '出版社或机构')}
        {fields.kind === 'article' && <>{input('volume', '卷', 32)}{input('issue', '期', 32)}</>}
        {fields.kind !== 'book' && input('pages', '页码或文章号', 50)}
        <div>{input('doi', 'DOI')}{inferred.doi && <p className="citation-hint">DOI 来自首页文字，请核对。</p>}</div>
        {input('url', '网址')}
      </fieldset>
      <div className="citation-output">
        <label className="field">引文格式<select value={format} onChange={event => { setFormat(event.target.value as CitationFormat); setNotice(''); }}>{FORMATS.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="field">引文预览<textarea readOnly ref={output} value={citation} rows={format === 'BibTeX' ? 6 : 3} placeholder="填写标题后生成引文" className={format === 'BibTeX' ? 'citation-code' : undefined} /></label>
        <div className="citation-footer"><p role={invalid ? 'alert' : 'status'}>{invalid || notice}</p><button className="primary" disabled={!citation} onClick={() => { void copy(); }}><Copy20Regular />复制引文</button></div>
      </div>
    </div>
  </dialog>;
}
