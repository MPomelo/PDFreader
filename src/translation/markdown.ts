import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

function escaped(source: string, index: number) {
  let count = 0; while (index > 0 && source[--index] === '\\') ++count; return count % 2 === 1;
}
function closeAt(source: string, delimiter: string, start: number) {
  let next = source.indexOf(delimiter, start);
  while (next >= 0) {
    if (!escaped(source, next)) {
      if (delimiter === '$') {
        if (source[next + 1] === '$' || source[next - 1] === '$' || /\d/.test(source[next + 1] || '') || /\s/.test(source[next - 1] || '') || source.slice(start, next).includes('\n\n')) return -1;
      }
      return next;
    }
    next = source.indexOf(delimiter, next + delimiter.length);
  }
  return -1;
}
/** Render-only normalization. The raw Markdown remains the authoritative value. */
export function prepareMarkdown(source: string, complete = false): { markdown: string; tail: string } {
  let markdown = '', i = 0;
  while (i < source.length) {
    if (i === 0 || source[i - 1] === '\n') {
      const opening = /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source.slice(i));
      if (opening) {
        const marker = opening[2]; const start = i; i += opening[0].length;
        while (i < source.length) {
          const end = source.indexOf('\n', i); const stop = end < 0 ? source.length : end + 1;
          const line = source.slice(i, stop);
          i = stop;
          if (new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}\\s*$').test(line)) break;
        }
        markdown += source.slice(start, i); continue;
      }
    }
    if (source[i] === '`') {
      const marker = /^`+/.exec(source.slice(i))![0]; const end = source.indexOf(marker, i + marker.length);
      if (end >= 0) { markdown += source.slice(i, end + marker.length); i = end + marker.length; continue; }
    }
    let opening = '', closing = '', block = false;
    if (source.startsWith('\\(', i)) { opening = '\\('; closing = '\\)'; }
    else if (source.startsWith('\\[', i)) { opening = '\\['; closing = '\\]'; block = true; }
    else if (source.startsWith('$$', i)) { opening = closing = '$$'; block = true; }
    else if (source[i] === '$' && source[i + 1] && !/\s/.test(source[i + 1])) {
      const end = closeAt(source, '$', i + 1);
      const money = /^\$[+-]?\d[\d,.]*(?=\s|$|[、，。;；:：!?！？)\]元美])/.test(source.slice(i));
      if (!money || (end >= 0 && /[+*/^_=\\{}<>-]/.test(source.slice(i + 1, end)))) opening = closing = '$';
    }
    if (opening) {
      const end = closeAt(source, closing, i + opening.length);
      if (end < 0) {
        // Once the answer is complete, a clearly separated later paragraph can
        // still render. During streaming the entire unclosed tail stays raw.
        const nextParagraph = complete ? source.indexOf('\n\n', i + opening.length) : -1;
        if (nextParagraph >= 0) {
          const raw = source.slice(i, nextParagraph);
          const ticks = String.fromCharCode(96).repeat(Math.max(3, ...Array.from(raw.matchAll(/`+/g), match => match[0].length + 1)));
          markdown += '\n\n' + ticks + 'text\n' + raw + '\n' + ticks + '\n\n';
          i = nextParagraph + 2; continue;
        }
        return { markdown, tail: source.slice(i) };
      }
      const math = source.slice(i + opening.length, end);
      markdown += block ? '\n\n$$\n' + math + '\n$$\n\n' : '$' + math + '$';
      i = end + closing.length; continue;
    }
    if (source[i] === '\\' && i + 1 < source.length) { markdown += source.slice(i, i + 2); i += 2; continue; }
    // Prevent the Markdown extension from interpreting two monetary $ as math.
    markdown += source[i] === '$' ? '\\$' : source[i]; ++i;
  }
  return { markdown, tail: '' };
}
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
type Node = { type: string; value?: string; alt?: string; children?: Node[] };
function plain(node: Node): string {
  if (node.type === 'html') return '';
  if (node.type === 'image') return node.alt || '';
  if (node.value != null) return node.value;
  if (node.type === 'break') return '\n';
  const separator = node.type === 'tableRow' ? '\t' : ['root', 'list', 'listItem', 'table', 'blockquote'].includes(node.type) ? '\n' : '';
  return (node.children || []).map(plain).join(separator);
}
export function plainText(source: string) {
  const { markdown, tail } = prepareMarkdown(source, true);
  return plain(processor.parse(markdown) as Node) + (tail ? '\n' + tail : '');
}

export function mathSource(node: unknown): string {
  const element = node as { tagName?: string; children?: unknown[]; value?: string };
  if (element.tagName === 'annotation') return (element.children || []).map(child => (child as { value?: string }).value || '').join('');
  for (const child of element.children || []) { const source = mathSource(child); if (source) return source; }
  return '';
}
