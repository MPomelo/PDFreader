import type { ReaderState } from '../reader/ReaderAdapter';
import { textDirty, type TextTab } from '../text/document';
import { useTextCursor } from '../text/cursor-store';

type Props = {
  documentCount: number;
  reader: ReaderState | null;
  hasPendingNote: boolean;
  text: TextTab | null;
  activeName?: string;
};

export function StatusBar({ documentCount, reader, hasPendingNote, text, activeName }: Props) {
  const position = useTextCursor(text?.id ?? '', text?.position);
  return <footer>
    <span>
      {documentCount ? `${documentCount} 个文档` : '就绪'}
      {reader && (reader.dirty || hasPendingNote) ? ' · 有未导出批注' : text && textDirty(text) ? ' · 有未保存修改' : ''}
    </span>
    <span>
      {reader
        ? `第 ${reader.page} / ${reader.pages} 页`
        : text
          ? `第 ${position.line} 行，第 ${position.column} 列 · ${text.encoding}${text.bom ? ' BOM' : ''} · ${text.eol === '\r\n' ? 'CRLF' : text.eol === '\r' ? 'CR' : 'LF'}`
          : activeName || 'PDFreader'}
    </span>
  </footer>;
}
