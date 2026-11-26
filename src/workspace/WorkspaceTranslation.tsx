import { useRef } from 'react';
import type { PdfTab } from '../reader/DocumentPane';
import { TranslationPanel } from '../translation/TranslationPanel';

export function WorkspaceTranslation({ sourceId, pdfs, visible, focusedPdf, automatic, signal, showMetadata, showOriginal,
  onSettings, disabled }: {
  sourceId: string; pdfs: PdfTab[]; visible: boolean; focusedPdf: string; automatic: boolean;
  signal?: { pdf: string; count: number }; showMetadata: boolean; showOriginal: boolean;
  onSettings: () => void; disabled: boolean;
}) {
  const known = useRef(new Map<string, Pick<PdfTab, 'id' | 'name' | 'fingerprint' | 'state'>>());
  const last = useRef('');
  const current = pdfs.find(pdf => pdf.id === sourceId && pdf.state);
  if (current) last.current = current.id;
  const display = current?.id ?? last.current;
  const openIds = new Set(pdfs.map(pdf => pdf.id));
  for (const id of known.current.keys()) if (!openIds.has(id) && id !== display) known.current.delete(id);
  for (const pdf of pdfs) {
    if (pdf.state && (pdf.id === sourceId || known.current.has(pdf.id))) {
      known.current.set(pdf.id, { id: pdf.id, name: pdf.name, fingerprint: pdf.fingerprint, state: pdf.state });
    }
  }
  return <>
    {!current && <p className="translation-source-status" role="status">来源暂不可用。请打开 PDF 或切换来源。</p>}
    {[...known.current.values()].map(pdf => <div key={pdf.id} className="tab-translation" hidden={display !== pdf.id || !visible}>
      <TranslationPanel reader={pdf.state} documentKey={pdf.fingerprint} documentName={pdf.name}
        keepSnapshot active={visible && current?.id === pdf.id && focusedPdf === pdf.id} automatic={automatic}
        showMetadata={showMetadata} showOriginal={showOriginal} translateSignal={signal?.pdf === pdf.id ? signal.count : 0}
        visible={visible && display === pdf.id} onSettings={onSettings} sourceClosed={!openIds.has(pdf.id)}
        disabled={disabled || current?.id !== pdf.id} />
    </div>)}
  </>;
}
