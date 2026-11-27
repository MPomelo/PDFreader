import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  api, RequestGate, StreamAccumulator, selectionIdentity,
  type ApiConfig, type ApiResult, type DisplayResult, type SecretStatus,
} from './client';
import { APP_EVENTS, onAppEvent } from '../local/events';
import type { ReaderState } from '../reader/ReaderAdapter';
import { TranslationOutput } from './TranslationOutput';
import { repository, cacheKey } from '../local/repository';

export type RememberedSelection = {
  documentId: string;
  text: string;
  raw: string;
  rects: ReaderState['selectionRects'];
  anchor?: string;
  page: number;
};

export type TranslationSnapshot = {
  result: DisplayResult | null;
  selection: RememberedSelection | null;
  lastAutomatic: string;
};

type Props = {
  sourceId: string;
  reader: ReaderState | null;
  documentKey: string;
  documentName: string;
  active: boolean;
  automatic: boolean;
  showMetadata?: boolean;
  showOriginal?: boolean;
  translateSignal?: number;
  isSignalConsumed?: (count: number) => boolean;
  onSignalConsumed?: (count: number) => void;
  sourceClosed?: boolean;
  disabled: boolean;
  onSettings: () => void;
  getSnapshot: (sourceId: string) => TranslationSnapshot | undefined;
  onSnapshotChange: (sourceId: string, snapshot: TranslationSnapshot) => void;
};

export function TranslationView({
  sourceId, reader, documentKey, documentName, active, automatic,
  showMetadata = false, showOriginal = false, translateSignal = 0,
  isSignalConsumed, onSignalConsumed, sourceClosed = false, disabled,
  onSettings, getSnapshot, onSnapshotChange,
}: Props) {
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<SecretStatus>({ available: false, mode: 'missing' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const [result, setResult] = useState<DisplayResult | null>(() => getSnapshot(sourceId)?.result ?? null);
  const [live, setLive] = useState<DisplayResult | null>(null);
  const [savedSelection, setSavedSelection] = useState<RememberedSelection | null>(() => getSnapshot(sourceId)?.selection ?? null);

  const latestResult = useRef<DisplayResult | null>(result);
  const latestLive = useRef<DisplayResult | null>(null);
  const latestSelection = useRef<RememberedSelection | null>(savedSelection);
  const lastAutomatic = useRef(getSnapshot(sourceId)?.lastAutomatic ?? '');
  const activeSourceId = useRef(sourceId);
  const snapshotCallbacks = useRef({ getSnapshot, onSnapshotChange, isSignalConsumed, onSignalConsumed });
  const gate = useRef(new RequestGate(api.cancel));
  const runLock = useRef(false);
  const statusRevision = useRef(0);
  const settingsRef = useRef('');
  const runRef = useRef<(retry?: DisplayResult) => Promise<void>>(async () => {});

  const currentConfig = config ? JSON.stringify(config) : '';
  const profile = config?.profiles.find(item => item.id === config.activeId);
  const documentId = reader?.documentId || '';

  // 纯派生当前有效选区：优先使用实时选区，点击侧栏按钮导致选区折叠时回退到该文档上次选区
  const liveSelection: RememberedSelection | null = reader?.selection
    ? {
        documentId,
        text: reader.selection,
        raw: reader.selectionRaw,
        rects: reader.selectionRects,
        anchor: reader.selectionAnchor,
        page: reader.selectionRects[0]?.page || reader.page,
      }
    : null;
  const effectiveSelection = liveSelection ?? (savedSelection?.documentId === documentId ? savedSelection : null);
  const text = effectiveSelection?.text || '';
  const selectedRaw = effectiveSelection?.raw || text;
  const selectedPage = effectiveSelection?.page || reader?.page || 0;
  const selectionKey = selectionIdentity(text, effectiveSelection?.rects || [], effectiveSelection?.anchor);

  const context = useRef({ sourceId, documentId, text, selectedRaw, selectedPage, rects: effectiveSelection?.rects || [], anchor: effectiveSelection?.anchor, selectionKey });

  function updateResult(value: DisplayResult | null, targetSourceId = activeSourceId.current) {
    latestResult.current = value;
    setResult(value);
    snapshotCallbacks.current.onSnapshotChange(targetSourceId, {
      result: value,
      selection: latestSelection.current,
      lastAutomatic: lastAutomatic.current,
    });
  }

  function updateLive(value: DisplayResult | null) {
    latestLive.current = value;
    setLive(value);
  }

  function saveSnapshotFor(targetSourceId: string, overrideResult?: DisplayResult | null) {
    const fallback = latestResult.current ?? (latestLive.current && latestLive.current.outcome !== 'streaming' ? latestLive.current : null);
    const persisted = overrideResult !== undefined ? overrideResult : fallback;
    snapshotCallbacks.current.onSnapshotChange(targetSourceId, {
      result: persisted,
      selection: latestSelection.current,
      lastAutomatic: lastAutomatic.current,
    });
  }

  // 在 commit 阶段同步 refs，避免 render 阶段写入 ref
  useLayoutEffect(() => {
    settingsRef.current = currentConfig;
    snapshotCallbacks.current = { getSnapshot, onSnapshotChange, isSignalConsumed, onSignalConsumed };
    context.current = {
      sourceId,
      documentId,
      text,
      selectedRaw,
      selectedPage,
      rects: effectiveSelection?.rects || [],
      anchor: effectiveSelection?.anchor,
      selectionKey,
    };
    if (liveSelection) latestSelection.current = liveSelection;
  });

  // 实时选区变化时持久化到当前文档快照
  useEffect(() => {
    if (!liveSelection) return;
    latestSelection.current = liveSelection;
    setSavedSelection(liveSelection);
    saveSnapshotFor(sourceId);
  }, [sourceId, documentId, liveSelection?.text, liveSelection?.raw, liveSelection?.anchor, liveSelection?.page]);

  // 切换来源文档时：保存旧文档中断快照并恢复目标文档快照
  useLayoutEffect(() => {
    const previousId = activeSourceId.current;
    if (previousId === sourceId) return;
    if (runLock.current || latestLive.current) {
      gate.current.invalidate();
      runLock.current = false;
      const stopped = latestLive.current
        ? { ...latestLive.current, outcome: latestLive.current.outcome === 'streaming' ? 'cancelled' as const : latestLive.current.outcome }
        : latestResult.current;
      saveSnapshotFor(previousId, stopped);
    } else {
      saveSnapshotFor(previousId);
    }
    activeSourceId.current = sourceId;
    const next = snapshotCallbacks.current.getSnapshot(sourceId);
    latestResult.current = next?.result ?? null;
    latestLive.current = null;
    latestSelection.current = next?.selection ?? null;
    lastAutomatic.current = next?.lastAutomatic ?? '';
    setResult(next?.result ?? null);
    setLive(null);
    setSavedSelection(next?.selection ?? null);
    setBusy('');
    setError('');
    setNotice('');
  }, [sourceId]);

  async function load() {
    try {
      setLoadError('');
      const loaded = await api.load();
      setConfig(loaded);
    } catch {
      setLoadError('无法读取 API 设置。请检查配置文件，原设置不会被覆盖。');
    }
  }

  useEffect(() => {
    if (api.desktop()) void load();
    const refresh = () => {
      gate.current.invalidate();
      runLock.current = false;
      setBusy('');
      if (latestLive.current?.outcome === 'streaming') {
        const cancelled = { ...latestLive.current, outcome: 'cancelled' as const };
        updateLive(cancelled);
        saveSnapshotFor(activeSourceId.current, cancelled);
      }
      void load();
    };
    const stopListening = onAppEvent(APP_EVENTS.apiSettingsChanged, refresh);
    return () => {
      stopListening();
      if (latestLive.current?.outcome === 'streaming') {
        saveSnapshotFor(activeSourceId.current, { ...latestLive.current, outcome: 'cancelled' });
      }
      gate.current.invalidate();
      runLock.current = false;
      ++statusRevision.current;
    };
  }, []);

  useEffect(() => {
    setStatus({ mode: 'missing', available: false });
    const revision = ++statusRevision.current;
    if (!profile || !api.desktop()) return;
    void api.status(profile.id)
      .then(value => { if (statusRevision.current === revision) setStatus(value); })
      .catch(() => { if (statusRevision.current === revision) setStatus({ mode: 'unavailable', available: false }); });
  }, [currentConfig]);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice('已复制。');
    } catch {
      setError('复制失败，请选择源码后手动复制。');
    }
  }

  function cancel() {
    gate.current.invalidate();
    runLock.current = false;
    setBusy('');
    setNotice('已取消请求，保留的内容尚未完成。');
    if (latestLive.current) {
      const cancelled = { ...latestLive.current, outcome: 'cancelled' as const };
      updateLive(cancelled);
      saveSnapshotFor(activeSourceId.current, cancelled);
    }
  }

  async function run(retry?: DisplayResult) {
    if (!config || !profile || runLock.current) return;
    const source = { ...context.current };
    if (retry && retry.response.documentId === source.documentId) source.text = retry.original;
    if (!source.text.trim()) return;
    const configSnapshot = settingsRef.current;
    const id = crypto.randomUUID();
    const generation = gate.current.begin(id);
    runLock.current = true;
    setBusy('translate');
    setError('');
    setNotice('');
    latestResult.current = null;
    setResult(null);
    updateLive(null);
    const metadata = {
      original: source.text,
      originalRaw: retry?.originalRaw || source.selectedRaw || source.text,
      page: retry?.page || source.selectedPage,
      test: false,
      service: profile.name,
      domain: config.prompt,
      language: config.targetLanguage,
    };
    const request = { requestId: id, documentId: source.documentId, profileId: profile.id, kind: 'translate' as const, text: source.text };
    try {
      let response: ApiResult;
      const key = documentKey ? await cacheKey(documentKey, source.text, source.rects, config, profile, source.anchor) : '';
      if (!gate.current.accepts(generation, id)) return;
      if (key && !retry) {
        const cached = await repository.cached(documentKey, key).catch(() => null);
        if (!gate.current.accepts(generation, id)) return;
        if (cached) {
          updateResult({ ...metadata, cached: true, outcome: 'complete', response: { ...cached, requestId: id, documentId: source.documentId } }, source.sourceId);
          updateLive(null);
          return;
        }
      }
      if (config.streaming !== false) {
        const accumulator = new StreamAccumulator();
        updateLive({
          ...metadata,
          outcome: 'streaming',
          response: { requestId: id, documentId: source.documentId, text: '', reasoning: '', model: profile.model, elapsedMs: 0, usage: null, models: [] },
        });
        response = await api.stream(request, chunk => {
          if (!gate.current.accepts(generation, id) || chunk.requestId !== id || chunk.documentId !== source.documentId
            || context.current.documentId !== source.documentId || settingsRef.current !== configSnapshot) return;
          try {
            if (accumulator.push(chunk)) {
              updateLive({
                ...metadata,
                outcome: 'streaming',
                response: { requestId: id, documentId: source.documentId, text: accumulator.text, reasoning: accumulator.reasoning, model: profile.model, elapsedMs: 0, usage: null, models: [] },
              });
            }
          } catch (error) {
            gate.current.invalidate();
            runLock.current = false;
            setBusy('');
            setError(String(error));
            if (latestLive.current) {
              const failed = { ...latestLive.current, outcome: 'error' as const };
              updateLive(failed);
              saveSnapshotFor(source.sourceId, failed);
            }
          }
        });
      } else {
        response = await api.request(request);
      }
      if (!gate.current.accepts(generation, id) || settingsRef.current !== configSnapshot
        || context.current.documentId !== source.documentId || response.requestId !== id || response.documentId !== source.documentId) return;
      updateResult({ response, ...metadata, outcome: 'complete' }, source.sourceId);
      updateLive(null);
      if (key) {
        void repository.cache(documentKey, key, response).catch(() => setNotice('译文已完成，但本地缓存未保存；请查看本地数据提示。'));
      }
    } catch (error) {
      if (gate.current.accepts(generation, id)) {
        setError(String(error));
        if (latestLive.current) {
          const failed = { ...latestLive.current, outcome: 'error' as const };
          updateLive(failed);
          saveSnapshotFor(source.sourceId, failed);
        }
      }
    } finally {
      if (gate.current.accepts(generation, id)) {
        gate.current.finish(generation, id);
        runLock.current = false;
        setBusy('');
      }
    }
  }

  useLayoutEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    if (sourceClosed && runLock.current) cancel();
  }, [sourceClosed]);

  useEffect(() => {
    if (!automatic) lastAutomatic.current = '';
  }, [automatic]);

  useEffect(() => {
    if (!translateSignal || disabled || !config || !profile) return;
    if (snapshotCallbacks.current.isSignalConsumed?.(translateSignal)) return;
    snapshotCallbacks.current.onSignalConsumed?.(translateSignal);
    if (runLock.current) cancel();
    void runRef.current();
  }, [translateSignal, disabled, config, profile]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key !== 'Enter' || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true]')) return;
      if (active && context.current.text && !disabled) {
        event.preventDefault();
        void runRef.current();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [disabled, active]);

  useEffect(() => {
    if (!active || !automatic || !api.desktop() || !config || !profile || disabled || !selectionKey || !profile.model.trim() || (profile.auth !== 'none' && !status.available)) return;
    const signature = JSON.stringify([documentId, selectionKey, currentConfig]);
    if (signature === lastAutomatic.current) return;
    const timer = setTimeout(() => {
      if (!runLock.current) {
        lastAutomatic.current = signature;
        saveSnapshotFor(activeSourceId.current);
        void runRef.current();
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [active, automatic, documentId, selectionKey, currentConfig, disabled, status.available, busy]);

  const displayed = result || live;

  async function saveAsNote() {
    if (!displayed || displayed.outcome !== 'complete' || displayed.test || !documentKey || !config) return;
    try {
      await repository.saveNote({
        id: crypto.randomUUID(),
        fingerprint: documentKey,
        name: documentName,
        page: displayed.page || 1,
        original: displayed.original,
        originalRaw: displayed.originalRaw,
        markdown: displayed.response.text,
        model: displayed.response.model,
        service: displayed.service,
        domain: displayed.domain || config.prompt,
        language: displayed.language || config.targetLanguage,
        time: new Date().toISOString(),
      });
      setNotice('笔记已保存');
    } catch (error) {
      setError(String(error));
    }
  }

  return <aside className="translation" aria-label="翻译面板">
    {loadError ? <p className="panel-error" role="alert">{loadError}</p>
      : !api.desktop() ? <p className="hint">在桌面版设置中配置翻译服务。</p>
      : !config || !profile ? <p className="hint">正在读取设置…</p>
      : <>
        {!displayed && <>
          {text ? <>
            <details className="selection-preview">
              <summary>已选 {text.length} 字 · 第 {selectedPage} 页</summary>
              <p className="selection">{text}</p>
            </details>
            <button className="primary translate-primary"
              disabled={disabled || !!busy || !profile.model.trim() || (profile.auth !== 'none' && !status.available)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => void run()}>翻译选区</button>
            {profile.auth !== 'none' && !status.available && <button className="muted" onClick={onSettings}>配置翻译服务</button>}
          </> : <div className="translation-empty">
            <p>{reader?.pageHasText === false ? '此页暂无可提取文字' : '选择文字，开始翻译'}</p>
            <span>Ctrl + Shift + Enter</span>
          </div>}
        </>}
        {displayed && !!text && displayed.originalRaw !== selectedRaw && <button className="translate-primary"
          disabled={disabled || !!busy || !profile.model.trim() || (profile.auth !== 'none' && !status.available)}
          onMouseDown={event => event.preventDefault()}
          onClick={() => { void run(); }}>翻译当前选区</button>}
        {!!busy && <div className="request-actions"><span role="status">翻译中</span><button onClick={cancel}>取消</button></div>}
        {displayed && <TranslationOutput result={displayed} copy={value => { void copy(value); }}
          showMetadata={showMetadata} showOriginal={showOriginal}
          saveNote={documentKey ? () => { void saveAsNote(); } : undefined}
          retry={() => { void run(displayed); }}
          disabled={disabled || !!busy || (profile.auth !== 'none' && !status.available)} />}
      </>}
    {error && <p className="panel-error" role="alert">{error}</p>}
    {notice && <p className="translation-notice" role="status">{notice}</p>}
  </aside>;
}
