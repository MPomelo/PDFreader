import { memo, type ComponentType } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { common } from 'lowlight';
import { katexOptions, prepareDocumentMath } from './document-math';
import { mathSource, prepareMarkdown } from './markdown';
import 'katex/dist/katex.min.css';
import './markdown.css';

type PreviewImage = ComponentType<{ alt: string; src: string; title?: string }>;

export const MarkdownRenderer = memo(function MarkdownRenderer({ source, pending = false, onCopy, image, onCopyCode }: {
  source: string;
  pending?: boolean;
  onCopy?: (text: string) => void;
  image?: PreviewImage;
  onCopyCode?: (text: string) => void;
}) {
  const document = image ? prepareDocumentMath(source) : null;
  const { markdown, tail } = document ? { markdown: document.markdown, tail: '' } : prepareMarkdown(source, !pending);
  const Image = image;
  return <div className="markdown-body">
    <Markdown skipHtml remarkPlugins={document ? [remarkGfm, remarkMath, document.preserveInvalidMath] : [remarkGfm, remarkMath]}
      rehypePlugins={document ? [[rehypeKatex, katexOptions], [rehypeHighlight, { languages: common, detect: false }]] : [[rehypeKatex, katexOptions]]}
      components={{
        img: ({ alt, src, title }) => Image && typeof src === 'string'
          ? <Image alt={alt || ''} src={src} title={title ?? undefined} />
          : <span className="image-placeholder">[图片{alt ? `：${alt}` : ''}]</span>,
        pre: ({ node, children, ...props }) => {
          if (!onCopyCode) return <pre {...props}>{children}</pre>;
          function sourceText(value: unknown): string {
            const child = value as { value?: string; children?: unknown[] };
            return child.value ?? child.children?.map(sourceText).join('') ?? '';
          }
          return <div className="preview-code"><button type="button" onClick={() => onCopyCode(sourceText(node))}>复制代码</button>
            <pre {...props}>{children}</pre></div>;
        },
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
