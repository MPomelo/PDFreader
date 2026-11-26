import { useRef } from 'react';
import type { PdfTab } from '../reader/DocumentPane';
import { TranslationPanel } from '../translation/TranslationPanel';
import { columns, columnName, type Column } from './layout';

export function WorkspaceTranslation({ source = 'upper', onSource, selected, pdfs, visible, focusedPdf, automatic, signal, showMetadata, showOriginal, onSettings, disabled }: {
  source?: string; onSource: (source: string) => void; selected: Record<Column, string>; pdfs: PdfTab[];
  visible: boolean; focusedPdf: string; automatic: boolean; signal?: { pdf: string; count: number }; showMetadata: boolean; showOriginal: boolean;
  onSettings: () => void; disabled: boolean;
}) {
  const known = useRef(new Map<string, { id: string; name: string; fingerprint: string; state: PdfTab['state'] }>());
  const sourceId = columns.includes(source as Column) ? selected[source as Column] : source;
  const current = pdfs.find(pdf => pdf.id === sourceId);
  const last = useRef('');
  if (current) last.current = current.id;
  for (const pdf of pdfs) {
    if (pdf.id === sourceId || pdf.id === signal?.pdf || known.current.has(pdf.id)) {
      known.current.set(pdf.id, { id: pdf.id, name: pdf.name, fingerprint: pdf.fingerprint, state: pdf.state });
    }
  }
  const display = current?.id || last.current;
  return <>
    <div className="workspace-feature-header">
      <label>译文来源 <select value={source} onChange={event => onSource(event.target.value)}>
        {columns.map(column => <option key={column} value={column}>跟随{columnName[column]}</option>)}
        {pdfs.map(pdf => <option key={pdf.id} value={pdf.id}>固定 · {pdf.name}</option>)}
        {!columns.includes(source as Column) && !current && <option value={source}>固定 · 来源已关闭</option>}
      </select></label>
      {current ? <span>{current.name}</span> : <span>请选择包含 PDF 的来源。{display && '仍显示此前的来源。'}</span>}
    </div>
    {[...known.current.values()].map(pdf => <div key={pdf.id} className="tab-translation" hidden={display !== pdf.id || !visible}>
      <TranslationPanel reader={pdf.state} documentKey={pdf.fingerprint} documentName={pdf.name}
        keepSnapshot active={visible && current?.id === pdf.id && focusedPdf === pdf.id} automatic={automatic}
        showMetadata={showMetadata} showOriginal={showOriginal} translateSignal={signal?.pdf === pdf.id ? signal.count : 0}
        visible={visible && display === pdf.id} settingsOpen={false} onSettings={onSettings} disabled={disabled || current?.id !== pdf.id} onComment={() => {}} />
    </div>)}
  </>;
}
