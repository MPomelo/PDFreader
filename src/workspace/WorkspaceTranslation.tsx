import { useCallback, useEffect, useRef, useState } from 'react';
import type { PdfTab } from '../reader/DocumentPane';
import { TranslationView, type TranslationSnapshot } from '../translation/TranslationView';

type SourceRecord = Pick<PdfTab, 'id' | 'name' | 'fingerprint' | 'state'>;

export function WorkspaceTranslation({ sourceId, pdfs, visible, focusedPdf, automatic, signal, showMetadata, showOriginal,
  onSettings, disabled }: {
  sourceId: string; pdfs: PdfTab[]; visible: boolean; focusedPdf: string; automatic: boolean;
  signal?: { pdf: string; count: number }; showMetadata: boolean; showOriginal: boolean;
  onSettings: () => void; disabled: boolean;
}) {
  // 按文档 ID 在内存 Map 中缓存上次译文与选区快照，避免挂载多个隐藏译文实例
  const snapshotsRef = useRef(new Map<string, TranslationSnapshot>());
  const consumedSignalRef = useRef(0);
  const [lastSource, setLastSource] = useState<SourceRecord | null>(null);

  const current = pdfs.find(pdf => pdf.id === sourceId && pdf.state) ?? null;
  const activeSource: SourceRecord | null = current
    ? { id: current.id, name: current.name, fingerprint: current.fingerprint, state: current.state }
    : lastSource;

  useEffect(() => {
    if (current && current.state) {
      setLastSource({ id: current.id, name: current.name, fingerprint: current.fingerprint, state: current.state });
    }
  }, [current]);

  useEffect(() => {
    const openIds = new Set(pdfs.map(pdf => pdf.id));
    const keepId = current?.id ?? lastSource?.id ?? '';
    for (const id of snapshotsRef.current.keys()) {
      if (!openIds.has(id) && id !== keepId) snapshotsRef.current.delete(id);
    }
  }, [pdfs, current?.id, lastSource?.id]);

  const getSnapshot = useCallback((id: string) => snapshotsRef.current.get(id), []);
  const saveSnapshot = useCallback((id: string, snapshot: TranslationSnapshot) => {
    if (id) snapshotsRef.current.set(id, snapshot);
  }, []);
  const isSignalConsumed = useCallback((count: number) => count <= consumedSignalRef.current, []);
  const markSignalConsumed = useCallback((count: number) => {
    consumedSignalRef.current = Math.max(consumedSignalRef.current, count);
  }, []);

  const sourceClosed = activeSource ? !pdfs.some(pdf => pdf.id === activeSource.id) : false;

  return <>
    {!current && <p className="translation-source-status" role="status">来源暂不可用。请打开 PDF 或切换来源。</p>}
    {visible && activeSource && <div className="tab-translation">
      <TranslationView
        sourceId={activeSource.id}
        reader={activeSource.state}
        documentKey={activeSource.fingerprint}
        documentName={activeSource.name}
        active={current?.id === activeSource.id && focusedPdf === activeSource.id}
        automatic={automatic}
        showMetadata={showMetadata}
        showOriginal={showOriginal}
        translateSignal={signal?.pdf === activeSource.id ? signal.count : 0}
        isSignalConsumed={isSignalConsumed}
        onSignalConsumed={markSignalConsumed}
        sourceClosed={sourceClosed}
        disabled={disabled || current?.id !== activeSource.id}
        onSettings={onSettings}
        getSnapshot={getSnapshot}
        onSnapshotChange={saveSnapshot}
      />
    </div>}
  </>;
}
