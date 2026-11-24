import { invoke, isTauri } from '@tauri-apps/api/core';
import { digest } from '../local/repository';

export type TextKind = 'markdown' | 'txt';
export type TextEncoding = 'UTF-8' | 'UTF-16LE' | 'UTF-16BE' | 'GB18030' | 'Big5' | 'windows-1252';
export type TextMode = 'edit' | 'preview' | 'split';

export interface TextTab {
  kind: TextKind;
  id: string;
  name: string;
  path: string;
  revision: string | null;
  encoding: TextEncoding;
  bom: boolean;
  eol: '\n' | '\r\n' | '\r';
  source: string;
  savedSource: string;
  savedEncoding: TextEncoding;
  savedBom: boolean;
  mode: TextMode;
  wrap: boolean;
  position: { line: number; column: number };
  assetsDir: string;
  staged: Record<string, File>;
  handle?: FileSystemFileHandle;
}

export interface OpenedText {
  name: string;
  path: string;
  revision: string;
  encoding: TextEncoding | null;
  bom: boolean;
  content: string | null;
  assetsDir: string;
}

export const encodings: readonly TextEncoding[] = ['UTF-8', 'UTF-16LE', 'UTF-16BE', 'GB18030', 'Big5', 'windows-1252'];
export const acceptDocuments = '.pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain';

export function documentKind(name: string): TextKind | 'pdf' | undefined {
  const extension = name.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
  if (extension === 'txt' || extension === 'pdf') return extension;
  if (extension === 'md' || extension === 'markdown') return 'markdown';
}

export function newTextTab(kind: TextKind, name: string): TextTab {
  return {
    kind, id: crypto.randomUUID(), name, path: '', revision: null,
    encoding: 'UTF-8', bom: false, eol: '\n', source: '', savedSource: '',
    savedEncoding: 'UTF-8', savedBom: false, mode: 'edit', wrap: true, position: { line: 1, column: 1 },
    assetsDir: '', staged: {},
  };
}

export function openedTextTab(kind: TextKind, file: OpenedText): TextTab {
  if (file.content === null || !file.encoding) throw Error('无法读取文件编码');
  const counts = new Map<TextTab['eol'], number>();
  const source = file.content.replace(/\r\n|\r|\n/g, match => {
    const eol = match as TextTab['eol'];
    counts.set(eol, (counts.get(eol) || 0) + 1);
    return '\n';
  });
  const eol = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '\n';
  return {
    ...newTextTab(kind, file.name), path: file.path, revision: file.revision, eol,
    encoding: file.encoding, bom: file.bom, source, savedSource: source, savedEncoding: file.encoding,
    savedBom: file.bom, mode: kind === 'markdown' ? 'preview' : 'edit', assetsDir: file.assetsDir,
  };
}

export function textDirty(tab: TextTab) {
  return tab.source !== tab.savedSource || tab.encoding !== tab.savedEncoding || tab.bom !== tab.savedBom;
}

export function openNativeText(path: string, encoding?: TextEncoding) {
  return invoke<OpenedText>('read_text', { path, encoding });
}

export async function openBrowserText(file: File, chosen?: TextEncoding): Promise<OpenedText> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const signature = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'UTF-8'
    : bytes[0] === 0xff && bytes[1] === 0xfe ? 'UTF-16LE'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'UTF-16BE' : null;
  const encoding = chosen || signature || 'UTF-8';
  const bom = encoding === signature;
  const identity = { name: file.name, path: '', revision: await digest(bytes), assetsDir: '' };
  try {
    const content = new TextDecoder(encoding, { fatal: true, ignoreBOM: true })
      .decode(bytes.subarray(bom ? encoding === 'UTF-8' ? 3 : 2 : 0));
    return { ...identity, encoding, bom, content };
  } catch {
    if (chosen) throw Error('无法用所选编码读取此文件，请选择其他编码。');
    return { ...identity, encoding: null, bom: false, content: null };
  }
}

export interface Destination {
  path: string;
  revision: string | null;
}

export function chooseTextDestination(tab: TextTab) {
  return invoke<Destination | null>('choose_text_destination', { name: tab.name, kind: tab.kind });
}

export async function saveBrowserText(tab: TextTab, saveAs: boolean) {
  const picker = (window as Window & { showSaveFilePicker?: (options: object) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if ((!tab.handle || saveAs) && !picker) throw Error('当前浏览器不支持直接保存，请使用桌面版。');
  let handle = tab.handle;
  if (!handle || saveAs) {
    try {
      handle = await picker!.call(window, {
        suggestedName: tab.name,
        types: tab.kind === 'txt' ? [{ description: 'TXT', accept: { 'text/plain': ['.txt'] } }]
          : [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }],
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
  }
  if (tab.handle && await tab.handle.isSameEntry(handle)) {
    const disk = await handle.getFile().catch(() => null);
    if (!disk || await digest(new Uint8Array(await disk.arrayBuffer())) !== tab.revision) {
      throw Error('保存冲突：磁盘文件已被修改或移除。可另存为以保留当前编辑。');
    }
  }
  const source = tab.source.replaceAll('\n', tab.eol);
  let bytes: Uint8Array<ArrayBuffer>;
  if (tab.encoding === 'UTF-8') {
    bytes = new TextEncoder().encode((tab.bom ? '\ufeff' : '') + source);
  } else if (tab.encoding === 'UTF-16LE' || tab.encoding === 'UTF-16BE') {
    const text = (tab.bom ? '\ufeff' : '') + source;
    bytes = new Uint8Array(text.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < text.length; index++) view.setUint16(index * 2, text.charCodeAt(index), tab.encoding === 'UTF-16LE');
  } else {
    throw Error('浏览器版仅支持保存 Unicode 编码文件。可选择转为 UTF-8，或在桌面版中保留当前编码。');
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  return { ...tab, handle, name: handle.name, revision: await digest(bytes), savedSource: tab.source,
    savedEncoding: tab.encoding, savedBom: tab.bom };
}

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}

export function supportsNativeAttachments() {
  return isTauri();
}
