import { invoke } from '@tauri-apps/api/core';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { ChangeSpec } from '@codemirror/state';
import type { Destination, TextTab } from './document';

const processor = unified().use(remarkParse).use(remarkGfm);
type MarkdownNode = {
  type: string;
  url?: string;
  identifier?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};
type Span = { from: number; to: number };
type Attachment = { kind: 'staged'; name: string; data: string } | { kind: 'copy'; name: string };
type SaveResult = { name: string; path: string; revision: string; assetsDir: string; urls: string[] };

const imageExtensions = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const imageTypes: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/avif': 'avif', 'image/svg+xml': 'svg',
};

export function imageName(file: File) {
  const original = file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  if (imageExtensions.test(original)) return original;
  const extension = imageTypes[file.type];
  if (!extension) throw Error('请选择 PNG、JPEG、GIF、WebP、BMP、ICO、AVIF 或 SVG 图片。');
  return `截图-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
}

export function isImage(file: File) {
  return file.type.startsWith('image/') || imageExtensions.test(file.name);
}

export function markdownUrl(path: string) {
  return '<' + path.replace(/[%#?&<>\\"\u0000-\u001f\u007f]/g, character => encodeURIComponent(character)) + '>';
}

export function relativePath(url: string) {
  if (!url || /^[a-z][a-z\d+.-]*:|^[\\/]/i.test(url)) return null;
  try { return decodeURIComponent(url.split(/[?#]/, 1)[0]); } catch { return null; }
}

function readBase64(file: File): Promise<string> {
  if (!file.size || file.size > 16 * 1024 * 1024) throw Error('图片为空或超过 16 MiB。');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.readAsDataURL(file);
  });
}

export async function storeImage(tab: TextTab, file: File) {
  return invoke<string>('store_text_image', { path: tab.path, name: imageName(file), data: await readBase64(file) });
}

export async function readDroppedImage(path: string) {
  const image = await invoke<{ name: string; mime: string; data: string }>('read_dropped_image', { path });
  return new File([Uint8Array.from(atob(image.data), character => character.charCodeAt(0))], image.name, { type: image.mime });
}

export async function loadImage(path: string, relative: string) {
  const image = await invoke<{ mime: string; data: string }>('read_text_image', { path, relative });
  return `data:${image.mime};base64,${image.data}`;
}

function imageDestinations(source: string) {
  const direct: MarkdownNode[] = [], references = new Set<string>(), definitions = new Map<string, MarkdownNode>();
  function visit(node: MarkdownNode) {
    if (node.type === 'image') direct.push(node);
    if (node.type === 'imageReference' && node.identifier) references.add(node.identifier);
    if (node.type === 'definition' && node.identifier && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    node.children?.forEach(visit);
  }
  visit(processor.parse(source) as MarkdownNode);
  for (const reference of references) {
    const definition = definitions.get(reference);
    if (definition) direct.push(definition);
  }
  return direct.sort((a, b) => a.position!.start.offset! - b.position!.start.offset!);
}

function destinationSpan(source: string, node: MarkdownNode): Span | null {
  const start = node.position?.start.offset, end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  let index = start + (node.type === 'image' ? 2 : 1);
  let bracketDepth = 0;
  for (; index < end; index++) {
    const character = source[index];
    if (character === '\\') { index++; continue; }
    if (character === '[') bracketDepth++;
    if (character === ']' && bracketDepth-- === 0) break;
  }
  const separator = node.type === 'image' ? '(' : ':';
  if (source[++index] !== separator) return null;
  do { index++; } while (index < end && /\s/.test(source[index]));
  const from = index;
  if (source[index] === '<') {
    for (++index; index < end; index++) {
      if (source[index] === '\\') index++;
      else if (source[index] === '>') return { from, to: index + 1 };
    }
    return null;
  }
  let depth = 0;
  for (; index < end; index++) {
    const character = source[index];
    if (character === '\\') { index++; continue; }
    if (/\s/.test(character) || (character === ')' && depth === 0)) break;
    if (character === '(') depth++;
    if (character === ')') depth--;
  }
  return index > from ? { from, to: index } : null;
}

function managedName(path: string, folder: string) {
  const slash = path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const [directory, name, extra] = slash.split('/');
  return folder && directory.toLowerCase() === folder.toLowerCase() && name && extra === undefined ? name : '';
}

export async function saveNativeText(tab: TextTab, destination: Destination) {
  const copyManaged = Boolean(tab.path && tab.path !== destination.path);
  const parts: string[] = [];
  const links: number[] = [];
  const attachments: Attachment[] = [];
  const spans: Span[] = [];
  const indexes = new Map<string, number>();
  let offset = 0;
  if (tab.kind === 'markdown' && (copyManaged || Object.keys(tab.staged).length)) {
    for (const node of imageDestinations(tab.source)) {
      const path = relativePath(node.url || '');
      if (!path) continue;
      const staged = tab.staged[path];
      const name = copyManaged ? managedName(path, tab.assetsDir) : '';
      if (!(staged instanceof File) && !name) continue;
      const span = destinationSpan(tab.source, node);
      if (!span) throw Error('无法更新图片链接，请检查 Markdown 图片语法。');
      const key = staged instanceof File ? path : name.toLowerCase();
      let index = indexes.get(key);
      if (index === undefined) {
        index = attachments.length;
        indexes.set(key, index);
        attachments.push(staged instanceof File
          ? { kind: 'staged', name: imageName(staged), data: await readBase64(staged) }
          : { kind: 'copy', name });
      }
      parts.push(tab.source.slice(offset, span.from).replaceAll('\n', tab.eol));
      offset = span.to;
      spans.push(span);
      links.push(index);
    }
  }
  parts.push(tab.source.slice(offset).replaceAll('\n', tab.eol));
  const saved = await invoke<SaveResult>('save_text', { request: {
    path: destination.path, expectedRevision: destination.revision,
    sourcePath: attachments.some(attachment => attachment.kind === 'copy') ? tab.path : null,
    encoding: tab.encoding, bom: tab.bom, parts, attachments, links,
  } });
  const changes: ChangeSpec[] = spans.map((span, index) => ({ ...span, insert: saved.urls[links[index]] }));
  const source = spans.reduceRight((text, span, index) => text.slice(0, span.from) + saved.urls[links[index]] + text.slice(span.to), tab.source);
  return {
    tab: { ...tab, path: saved.path, name: saved.name, revision: saved.revision, assetsDir: saved.assetsDir,
      source, savedSource: source, savedEncoding: tab.encoding, savedBom: tab.bom },
    changes,
  };
}
