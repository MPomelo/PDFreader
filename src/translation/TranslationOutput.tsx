import { useEffect, useState } from 'react';
import { Copy20Regular, ArrowClockwise20Regular, NoteAdd20Regular, Code20Regular, ChevronDown16Regular, ChevronRight16Regular } from '@fluentui/react-icons';
import type { DisplayResult } from './client';
import { MarkdownRenderer } from './MarkdownRenderer';
import { plainText } from './markdown';

export function TranslationOutput({ result, copy, retry, disabled, saveNote, showMetadata = false, showOriginal = false }: {
  result: DisplayResult;
  copy: (value: string) => void;
  retry: () => void;
  disabled: boolean;
  saveNote?: () => void;
  showMetadata?: boolean;
  showOriginal?: boolean;
}) {
  const [originalOpen, setOriginalOpen] = useState(showOriginal);
  useEffect(() => { setOriginalOpen(showOriginal); }, [showOriginal]);

  const finished = result.outcome === 'complete';
  const statusLabel = finished
    ? '已完成'
    : result.outcome === 'streaming'
      ? '接收中'
      : result.outcome === 'cancelled'
        ? '已取消 · 内容未完成'
        : '已中断 · 内容未完成';
  const metadata = (
    <p className="muted">
      {result.service} · {result.response.model}
      {finished ? ` · ${(result.response.elapsedMs / 1000).toFixed(1)} 秒` : ''}
      {result.page && !result.test ? ` · 第 ${result.page} 页` : ''}
      {result.response.usage?.total_tokens != null ? ` · ${result.response.usage.total_tokens} tokens` : ''}
    </p>
  );

  return <section className="translation-result" aria-label="翻译结果">
    <div className="result-header">
      <div className="result-state">
        <span className={`stream-status ${finished ? '' : 'stream-incomplete'}`} role="status">{statusLabel}</span>
        {result.cached && <span className="cache-badge" title="来自本地缓存，重译会请求新结果">缓存</span>}
      </div>
      <button
        type="button"
        className="result-original-toggle"
        aria-expanded={originalOpen}
        onClick={() => setOriginalOpen(open => !open)}
      >
        {originalOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
        原文
      </button>
    </div>
    {originalOpen && <p className="selection result-original-body">{result.original}</p>}
    {result.response.reasoning && (
      <details className="thinking">
        <summary title="思考内容不计入译文">思考</summary>
        <pre>{result.response.reasoning}</pre>
      </details>
    )}
    <MarkdownRenderer source={result.response.text} pending={!finished} onCopy={copy} />
    <div className="result-actions">
      <button type="button" aria-label={finished ? '复制纯文本' : '复制当前文本（未完成）'} title="复制纯文本" disabled={!result.response.text} onClick={() => copy(plainText(result.response.text))}>
        <Copy20Regular />复制
      </button>
      <button type="button" aria-label="重新翻译" title="重新翻译，绕过缓存" disabled={disabled} onClick={retry}>
        <ArrowClockwise20Regular />重译
      </button>
      {finished && !result.test && saveNote && (
        <button type="button" aria-label="保存为笔记" title="保存为笔记" onClick={saveNote}>
          <NoteAdd20Regular />笔记
        </button>
      )}
      <button type="button" aria-label="复制 Markdown / LaTeX" title="复制 Markdown / LaTeX" disabled={!result.response.text} onClick={() => copy(result.response.text)}>
        <Code20Regular />复制 MD
      </button>
    </div>
    <div className="result-footer-meta">
      {showMetadata ? metadata : <details className="result-details"><summary>详情</summary>{metadata}</details>}
      <details className="result-source">
        <summary>查看源码</summary>
        <textarea className="translation-source" rows={7} readOnly value={result.response.text} aria-label="译文 Markdown 与 LaTeX 源码" />
      </details>
      {result.originalRaw !== result.original && (
        <details className="result-raw">
          <summary>原始提取文本</summary>
          <pre className="selection">{result.originalRaw}</pre>
        </details>
      )}
    </div>
  </section>;
}
