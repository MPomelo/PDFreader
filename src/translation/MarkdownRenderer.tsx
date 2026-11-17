import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { mathSource, prepareMarkdown } from './markdown';
import 'katex/dist/katex.min.css';
import './markdown.css';

export const MarkdownRenderer = memo(function MarkdownRenderer({ source, pending = false, onCopy }: { source: string; pending?: boolean; onCopy?: (text: string) => void }) {
  const { markdown, tail } = prepareMarkdown(source, !pending);
  return <div className="markdown-body">
    <Markdown skipHtml remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: 'warn', maxExpand: 500, maxSize: 20, errorColor: '#a4262c' }]]}
      components={{
        img: ({ alt }) => <span className="image-placeholder">[图片{alt ? `：${alt}` : ''}]</span>,
        a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
        span: ({ node, children, ...props }) => {
          if (props.className?.split(' ').some(name => name === 'katex' || name === 'katex-error')) {
            const latex = mathSource(node) || (props.className.includes('katex-error') ? (node?.children || []).map(child => 'value' in child ? child.value : '').join('') : '');
            return <span className="math-unit"><span {...props}>{children}</span>{latex && onCopy && <button className="copy-math" onClick={() => onCopy(latex)} title="复制此公式的 LaTeX 源码">复制公式</button>}</span>;
          }
          return <span {...props}>{children}</span>;
        },
      }}>{markdown}</Markdown>
    {tail && <span className="math-pending" title={pending ? '公式尚未闭合，暂显示原文' : '公式未闭合，保留原文'}>{tail}</span>}
  </div>;
});
