import katex from 'katex';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

type Node = {
  type: string;
  value?: string;
  lang?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
};
const markup = unified().use(remarkParse).use(remarkGfm);
const delimiters = [
  ['\\\\(', '\\\\)', false], ['\\\\[', '\\\\]', true],
  ['\\(', '\\)', false], ['\\[', '\\]', true], ['$$', '$$', true], ['$', '$', false],
] as const;

export const katexOptions = { trust: false, strict: 'warn' as const, maxExpand: 500, maxSize: 20, errorColor: '#a4262c' };

function escaped(source: string, index: number) {
  let count = 0;
  while (index > 0 && source[--index] === '\\') count++;
  return count % 2 === 1;
}

function protectLiteral(text: string) {
  return text.replace(/[\\`*_{}[\]()#+.\-!|<>$~&]/g, '\\$&');
}

export function prepareDocumentMath(source: string) {
  const skip = new Map<number, number>();
  function visit(node: Node) {
    if (['code', 'inlineCode', 'image', 'imageReference', 'definition', 'html'].includes(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) skip.set(start, end);
    } else node.children?.forEach(visit);
  }
  visit(markup.parse(source) as Node);
  const formulas = new Map<number, string>();
  let markdown = '';
  for (let offset = 0; offset < source.length;) {
    const ignored = skip.get(offset);
    if (ignored !== undefined) {
      markdown += source.slice(offset, ignored);
      offset = ignored;
      continue;
    }
    const at = offset;
    const delimiter = escaped(source, at) ? undefined : delimiters.find(([open]) => source.startsWith(open, at));
    if (!delimiter) {
      markdown += source[offset++];
      continue;
    }
    const [open, close, block] = delimiter;
    const start = at + open.length;
    const nextLine = source.indexOf('\n', start);
    const nextParagraph = block ? /\n[ \t]*\n/.exec(source.slice(start)) : null;
    const limit = block ? (nextParagraph ? start + nextParagraph.index : source.length)
      : (nextLine === -1 ? source.length : nextLine);
    let end = source.indexOf(close, start);
    while (end >= 0 && end < limit && (escaped(source, end) || (close === '$' && (source[end + 1] === '$' || /\s/.test(source[end - 1]))))) {
      // Two dollar signs open a different expression.
      if (close === '$' && source[end + 1] === '$') { end = -1; break; }
      end = source.indexOf(close, end + close.length);
    }
    if (close === '$') {
      const money = /^\$[+-]?\d[\d,.]*(?=\s|$|[、，。;；:：!?！？)\]元美])/.test(source.slice(at));
      const mathematical = end >= 0 && end < limit && /[+*/^_=\\{}<>-]/.test(source.slice(start, end));
      if (!source[start] || /\s/.test(source[start]) || (money && !mathematical)) {
        markdown += '\\$';
        offset++;
        continue;
      }
      if (end >= 0 && /\d/.test(source[end + 1] || '')) end = -1;
    }
    if (end < 0 || end >= limit) {
      // Keep each following line and paragraph available to the Markdown parser.
      const stop = Math.min(limit, nextLine === -1 ? source.length : nextLine);
      markdown += protectLiteral(source.slice(at, Math.max(start, stop)));
      offset = Math.max(start, stop);
      continue;
    }
    const body = source.slice(start, end);
    const raw = source.slice(at, end + close.length);
    if (block) markdown += '\n\n';
    formulas.set(markdown.length, raw);
    if (block) markdown += '$$\n' + body.trim() + '\n$$\n\n';
    else markdown += '$' + body + '$';
    offset = end + close.length;
  }

  const preserveInvalidMath = () => (tree: Node) => {
    function repair(node: Node): Node {
      if (node.type === 'code' && node.lang?.toLowerCase() === 'math') return { ...node, lang: 'text' };
      if (node.type === 'math' || node.type === 'inlineMath') {
        const raw = formulas.get(node.position?.start.offset ?? -1);
        if (raw !== undefined) {
          try {
            katex.renderToString(node.value ?? '', { ...katexOptions, strict: 'ignore', displayMode: node.type === 'math', throwOnError: true });
          } catch {
            if (node.type === 'math') return { type: 'paragraph', children: [{ type: 'inlineCode', value: raw }] };
            return { type: 'inlineCode', value: raw };
          }
        }
      }
      if (node.children) node.children = node.children.map(repair);
      return node;
    }
    repair(tree);
  };
  return { markdown, preserveInvalidMath };
}
