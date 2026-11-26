import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, MATH_TEST_TEXT, RequestGate, StreamAccumulator, selectionIdentity, type ApiConfig, type ApiKind, type ApiResult, type Profile, type SecretStatus } from './client';
import type { ReaderState } from '../reader/ReaderAdapter';
import { TranslationOutput } from './TranslationOutput';
import { repository, cacheKey } from '../local/repository';

export const API_SETTINGS_CHANGED = 'pdfreader-api-settings-changed';
type Props = { keepSnapshot?: boolean; mode?: 'panel' | 'settings'; settingsSection?: 'translation' | 'api'; active?: boolean; automatic?: boolean; onAutomatic?: (enabled: boolean) => void; onDirtyChange?: (dirty: boolean) => void; showMetadata?: boolean; showOriginal?: boolean; reader: ReaderState | null; visible: boolean; sourceClosed?: boolean;
  onSettings: (open: boolean) => void; disabled: boolean; documentKey?: string; documentName?: string; translateSignal?: number };
export type DisplayResult = { response: ApiResult; original: string; originalRaw: string; page: number; test: boolean; domain?: string; language?: string; cached?: boolean; testKind?: 'test' | 'math-test'; service: string; outcome: 'complete' | 'streaming' | 'cancelled' | 'error' };
const prompts = {
  general: '准确翻译为目标语言，保持原文语气与段落，只输出译文。',
  academic: '忠实翻译学术文本，保留公式、引用编号、变量及 Markdown 结构；只输出译文，不补写原文缺失内容。',
  ai: '准确翻译计算机与人工智能论文，注意模型、训练流程、数据集和指标术语；保留数学公式、变量、引用编号，只输出译文。',
};
export function TranslationPanel({ keepSnapshot = false, mode = 'panel', settingsSection = 'translation', active = true, automatic = false, onAutomatic, onDirtyChange, showMetadata = false, showOriginal = false, reader, visible, sourceClosed = false, onSettings, disabled, documentKey = '', documentName = '', translateSignal = 0 }: Props) {
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [saved, setSaved] = useState('');
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<SecretStatus>({ available: false, mode: 'missing' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<DisplayResult | null>(null);
  const [live, setLive] = useState<DisplayResult | null>(null);
  const latestLive = useRef<DisplayResult | null>(null);

  const runRef = useRef<(kind: ApiKind, retry?: DisplayResult) => Promise<void>>(async () => {});
  const lastAutomatic = useRef('');
  const [models, setModels] = useState<string[]>([]);
  const [sessionOnly, setSessionOnly] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const gate = useRef(new RequestGate(api.cancel));
  const context = useRef({ documentId: '', text: '', selectionKey: '' });
  const runLock = useRef(false);
  const statusRevision = useRef(0);
  const settingsRef = useRef('');
  const currentConfig = config ? JSON.stringify(config) : '';
  settingsRef.current = currentConfig;
  const dirty = currentConfig !== saved;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]);
  const profile = config?.profiles.find(item => item.id === config.activeId);
  const documentId = reader?.documentId || '';
  const remembered = useRef<{ documentId: string; text: string; raw: string; rects: ReaderState['selectionRects']; anchor?: string; page: number } | null>(null);
  if (remembered.current?.documentId !== documentId) remembered.current = null;
  if (reader?.selection) remembered.current = { documentId, text: reader.selection, raw: reader.selectionRaw, rects: reader.selectionRects, anchor: reader.selectionAnchor, page: reader.selectionRects[0]?.page || reader.page };
  // Clicking a model/style control can collapse the browser selection. Keep the
  // last selected source within this document so it can still be translated.
  const text = remembered.current?.text || '';
  const selectedRaw = remembered.current?.raw || text;
  const selectedPage = remembered.current?.page || reader?.page || 0;
  const selectionKey = selectionIdentity(text, remembered.current?.rects || [], remembered.current?.anchor);
  // Update immediately during render so a late promise cannot use a stale ref.
  context.current = { documentId, text, selectionKey };
  const previousContext = useRef(context.current);

  async function load() {
    try {
      setLoadError('');
      const loaded = await api.load(); setConfig(loaded); setSaved(JSON.stringify(loaded));
    } catch { setLoadError('无法读取 API 设置。请检查配置文件，原设置不会被覆盖。'); }
  }
  useEffect(() => {
    if (api.desktop()) void load();
    const refresh = () => { gate.current.invalidate(); runLock.current = false; setBusy(''); if (latestLive.current?.outcome === 'streaming') updateLive({ ...latestLive.current, outcome: 'cancelled' }); void load(); };
    window.addEventListener(API_SETTINGS_CHANGED, refresh);
    return () => { window.removeEventListener(API_SETTINGS_CHANGED, refresh); gate.current.invalidate(); ++statusRevision.current; };
  }, []);
  useLayoutEffect(() => {
    const previous = previousContext.current;
    if (documentId !== previous.documentId || (!keepSnapshot && selectionKey && selectionKey !== previous.selectionKey)) {
      gate.current.invalidate(); runLock.current = false; setBusy(''); setResult(null); updateLive(null); setError('');
    }
    previousContext.current = { documentId, text, selectionKey };
  }, [documentId, text, selectionKey]);
  useEffect(() => {
    if (keyInput.current) keyInput.current.value = '';
    setModels([]); setStatus({ mode: 'missing', available: false });
    const revision = ++statusRevision.current;
    if (!profile || dirty || !api.desktop()) return;
    void api.status(profile.id).then(value => { if (statusRevision.current === revision) setStatus(value); })
      .catch(() => { if (statusRevision.current === revision) setStatus({ mode: 'unavailable', available: false }); });
  }, [saved, currentConfig]);
  function edit(next: ApiConfig) {
    gate.current.invalidate(); runLock.current = false; setBusy(''); setResult(null); updateLive(null); setError(''); setNotice('');
    setConfig(next);
  }
  function editProfile(patch: Partial<Profile>) {
    if (config && profile) edit({ ...config, profiles: config.profiles.map(item => item.id === profile.id ? { ...item, ...patch } : item) });
  }
  async function save() {
    if (!config) return;
    setSaving(true); setError(''); setNotice('');
    try { await api.save(config); setSaved(JSON.stringify(config)); setNotice('设置已保存。'); window.dispatchEvent(new Event(API_SETTINGS_CHANGED)); }
    catch (error) { setError(String(error)); }
    finally { setSaving(false); }
  }
  async function saveKey() {
    if (!profile || dirty || !keyInput.current) return;
    const input = keyInput.current;
    gate.current.invalidate(); runLock.current = false; setBusy('');
    setSaving(true); setError(''); setNotice('');
    try { setStatus(await api.saveKey(profile.id, input.value, sessionOnly)); setNotice(sessionOnly ? '本次输入的密钥只在当前会话内使用；此前安全保存的密钥不变。' : '密钥已保存在 Windows 凭据管理器。'); }
    catch (error) { setError(String(error)); }
    finally { input.value = ''; setSaving(false); window.dispatchEvent(new Event(API_SETTINGS_CHANGED)); }
  }
  async function deleteKey() {
    if (!profile || dirty) return;
    gate.current.invalidate(); runLock.current = false; setBusy('');
    setSaving(true); setError('');
    try { setStatus(await api.deleteKey(profile.id)); setNotice('此配置与地址对应的密钥已删除。'); }
    catch (error) { setError(String(error)); setStatus(await api.status(profile.id).catch(() => ({ available: false, mode: 'unavailable' as const }))); }
    finally { setSaving(false); window.dispatchEvent(new Event(API_SETTINGS_CHANGED)); }
  }
  function updateLive(value: DisplayResult | null) { latestLive.current = value; setLive(value); }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('已复制。'); } catch { setError('复制失败，请选择源码后手动复制。'); }
  }
  function preferences(patch: Partial<ApiConfig>) { if (config) edit({ ...config, ...patch }); }
  async function run(kind: ApiKind, retry?: DisplayResult) {
    if (!config || !profile || dirty || runLock.current) return;
    const source = { ...context.current };
    if (retry && retry.response.documentId === source.documentId) source.text = retry.original;
    if (kind === 'translate' && !source.text.trim()) return;
    const configSnapshot = settingsRef.current;
    const id = crypto.randomUUID();
    const generation = gate.current.begin(id);
    runLock.current = true; setBusy(kind); setError(''); setNotice('');
    if (kind !== 'models') { setResult(null); updateLive(null); }
    const testKind = kind === 'test' || kind === 'math-test' ? kind : undefined;
    const testText = kind === 'math-test' ? MATH_TEST_TEXT : 'The sky is blue.';
    const metadata = { original: testKind ? testText : source.text,
      originalRaw: testKind ? testText : retry?.originalRaw || selectedRaw || source.text,
      page: retry?.page || selectedPage, test: !!testKind, testKind, service: profile.name, domain: config.prompt, language: config.targetLanguage };
    const request = { requestId: id, documentId: source.documentId, profileId: profile.id, kind, text: kind === 'translate' ? source.text : '' };
    try {
      let response: ApiResult;
      const key = kind === 'translate' && documentKey ? await cacheKey(documentKey, source.text, remembered.current?.rects || [], config, profile, remembered.current?.anchor) : '';
      if (!gate.current.accepts(generation, id)) return;
      if (key && !retry) {
        const cached = await repository.cached(documentKey, key).catch(() => null);
        if (!gate.current.accepts(generation, id)) return;
        if (cached) { setResult({ ...metadata, cached: true, outcome: 'complete', response: { ...cached, requestId: id, documentId: source.documentId } }); updateLive(null); return; }
      }
      if (kind !== 'models' && config.streaming !== false) {
        const accumulator = new StreamAccumulator();
        updateLive({ ...metadata, outcome: 'streaming', response: { requestId: id, documentId: source.documentId, text: '', reasoning: '', model: profile.model, elapsedMs: 0, usage: null, models: [] } });
        response = await api.stream(request, chunk => {
          if (!gate.current.accepts(generation, id) || chunk.requestId !== id || chunk.documentId !== source.documentId || context.current.documentId !== source.documentId || settingsRef.current !== configSnapshot || (!keepSnapshot && kind === 'translate' && context.current.selectionKey && context.current.selectionKey !== source.selectionKey)) return;
          try {
            if (accumulator.push(chunk)) updateLive({ ...metadata, outcome: 'streaming', response: { requestId: id, documentId: source.documentId, text: accumulator.text, reasoning: accumulator.reasoning, model: profile.model, elapsedMs: 0, usage: null, models: [] } });
          } catch (error) {
            gate.current.invalidate(); runLock.current = false; setBusy(''); setError(String(error));
            if (latestLive.current) updateLive({ ...latestLive.current, outcome: 'error' });
          }
        });
      } else response = await api.request(request);
      if (!gate.current.accepts(generation, id) || settingsRef.current !== configSnapshot || context.current.documentId !== source.documentId || response.requestId !== id || response.documentId !== source.documentId) return;
      if (!keepSnapshot && kind === 'translate' && context.current.selectionKey && context.current.selectionKey !== source.selectionKey) return;
      if (kind === 'models') { setModels(response.models); setNotice(response.models.length ? `已读取 ${response.models.length} 个模型，也可手填。` : '模型列表为空，请手填。'); }
      else { setResult({ response, ...metadata, outcome: 'complete' }); updateLive(null); if (key) void repository.cache(documentKey, key, response).catch(() => setNotice('译文已完成，但本地缓存未保存；请查看本地数据提示。')); }
    } catch (error) {
      if (gate.current.accepts(generation, id)) { setError(String(error)); if (latestLive.current) updateLive({ ...latestLive.current, outcome: 'error' }); }
    } finally {
      if (gate.current.accepts(generation, id)) { gate.current.finish(generation, id); runLock.current = false; setBusy(''); }
    }
  }
  function cancel() { gate.current.invalidate(); runLock.current = false; setBusy(''); setNotice('已取消请求，保留的内容尚未完成。'); if (latestLive.current) updateLive({ ...latestLive.current, outcome: 'cancelled' }); }
  useEffect(() => {
    if (sourceClosed && runLock.current) cancel();
  }, [sourceClosed]);
  runRef.current = run;
  const appliedSignal = useRef(0);
  useEffect(() => {
    if (!translateSignal || appliedSignal.current === translateSignal || disabled || !config || !profile) return;
    appliedSignal.current = translateSignal;
    if (keepSnapshot && runLock.current) cancel();
    void runRef.current('translate');
  }, [translateSignal, disabled, config, profile, keepSnapshot]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key !== 'Enter' || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true]')) return;
      if (active && context.current.text && !disabled) { event.preventDefault(); void runRef.current('translate'); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [disabled, active]);
  useEffect(() => {
    if (!active || mode !== 'panel' || !automatic || !api.desktop() || !config || !profile || dirty || saving || disabled || !selectionKey || !profile.model.trim() || (profile.auth !== 'none' && !status.available)) return;
    const signature = JSON.stringify([documentId, selectionKey, currentConfig]);
    if (signature === lastAutomatic.current) return;
    const timer = setTimeout(() => { if (!runLock.current) { lastAutomatic.current = signature; void runRef.current('translate'); } }, 700);
    return () => clearTimeout(timer);
  }, [active, automatic, documentId, selectionKey, currentConfig, dirty, saving, disabled, status.available, busy]);
  const displayed = result || live;
  async function saveAsNote() {
    if (!displayed || displayed.outcome !== 'complete' || displayed.test || !documentKey || !config) return;
    try {
      await repository.saveNote({ id: crypto.randomUUID(), fingerprint: documentKey, name: documentName, page: displayed.page || 1,
        original: displayed.original, originalRaw: displayed.originalRaw, markdown: displayed.response.text, model: displayed.response.model, service: displayed.service, domain: displayed.domain || config.prompt, language: displayed.language || config.targetLanguage, time: new Date().toISOString() });
      setNotice('笔记已保存');
    } catch (error) { setError(String(error)); }
  }
  if (!visible) return null;
  if (mode === 'settings') return <section className="translation-settings">
    {!api.desktop() ? <p className="hint">桌面版支持服务配置。</p> : loadError ? <><p role="alert">{loadError}</p><button onClick={() => void load()}>重新读取设置</button></> : !config || !profile ? <p role="status">正在读取设置…</p> : <>
      {settingsSection === 'api' ? <><h2>API 服务</h2><p className="muted">配置模型与密钥，密钥保存在本机。</p>
      <label className="field">服务配置<select aria-label="服务配置" value={config.activeId} disabled={saving} onChange={event => {
        edit({ ...config, activeId: event.target.value });
      }}>{config.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {<fieldset className="api-settings" disabled={saving}>
        <label className="field">配置名称<input value={profile.name} maxLength={80} onChange={event => editProfile({ name: event.target.value })} /></label>
        <label className="field">Base URL<input type="url" value={profile.baseUrl} onChange={event => editProfile({ baseUrl: event.target.value })} spellCheck={false} /></label>
        <label className="field">鉴权<select aria-label="鉴权" value={profile.auth} onChange={event => editProfile({ auth: event.target.value as Profile['auth'] })}><option value="bearer">Authorization: Bearer</option><option value="api-key">api-key</option><option value="none">不使用密钥</option></select></label>
        <label className="field">模型<input aria-label="模型" list="api-models" value={profile.model} maxLength={256} onChange={event => editProfile({ model: event.target.value })} placeholder="填写服务提供的模型名称" spellCheck={false} /><datalist id="api-models">{models.map(id => <option key={id} value={id} />)}</datalist></label>
        <button disabled={dirty || !!busy || saving || (profile.auth !== 'none' && !status.available)} onClick={() => void run('models')}>读取模型列表</button>
        <p className="muted">模型列表可选；不支持时直接填写模型。修改地址或鉴权后须重新配置对应密钥。</p>
        <div className="compact-fields"><label className="field">超时（秒）<input type="number" min={5} max={180} value={config.timeoutSeconds} onChange={event => edit({ ...config, timeoutSeconds: Number(event.target.value) })} /></label><label className="field">输出 token 上限<input type="number" min={128} max={32768} value={config.maxTokens} onChange={event => edit({ ...config, maxTokens: Number(event.target.value) })} /></label></div>
        {profile.auth !== 'none' && <fieldset className="key-settings"><legend>API 密钥</legend>
          <p className="muted">{status.available ? status.mode === 'session' ? '已配置 · 仅本次会话' : '已配置 · Windows 凭据管理器' : status.mode === 'unavailable' ? '凭据管理器不可用，可选择仅本次会话。' : '此配置与地址尚未配置密钥。'}</p>
          <label className="field">输入新密钥<input ref={keyInput} type="password" autoComplete="off" spellCheck={false} disabled={dirty || saving} placeholder="留空不会更改已有密钥" /></label>
          <label className="checkbox"><input type="checkbox" checked={sessionOnly} onChange={event => setSessionOnly(event.target.checked)} />仅本次会话（不保存本次密钥）</label>
          <div className="panel-actions"><button disabled={dirty || saving} onClick={() => void saveKey()}>保存 / 替换密钥</button><button disabled={dirty || saving} onClick={() => void deleteKey()}>删除密钥</button></div>
        </fieldset>}
        <button disabled={dirty || !!busy || saving || !profile.model.trim() || (profile.auth !== 'none' && !status.available)} onClick={() => void run('test')}>测试连接（发送固定短句）</button>
        <button disabled={dirty || !!busy || saving || !profile.model.trim() || (profile.auth !== 'none' && !status.available)} onClick={() => void run('math-test')}>测试公式（固定样例）</button>
        <p className="muted">连接测试发送固定短句，公式测试发送固定公式，不使用 PDF 内容；测试和翻译可能产生服务商费用，不自动重试或切换服务。</p>
      </fieldset>}
</> : <><h2>翻译偏好</h2>
        <label className="field">目标语言<input value={config.targetLanguage} maxLength={50} onChange={event => edit({ ...config, targetLanguage: event.target.value })} /></label>
      <div className="translation-preferences">
        <label className="checkbox"><input type="checkbox" checked={config.streaming !== false} disabled={saving} onChange={event => preferences({ streaming: event.target.checked })} />流式输出</label>
        <label>回答样式 <select aria-label="回答样式" value={config.answerStyle || 'concise'} disabled={saving} onChange={event => preferences({ answerStyle: event.target.value as 'concise' | 'detailed' })}><option value="concise">普通译文</option><option value="detailed">长回答与术语说明</option></select></label>
      </div>
      <label className="checkbox"><input type="checkbox" checked={automatic} onChange={event => { onAutomatic?.(event.target.checked); lastAutomatic.current = ''; }} />选中文字后自动翻译（仅本次运行，可能产生费用）</label>
      <p className="muted">Ctrl+Shift+Enter 翻译选区；自动翻译默认关闭。</p>
        <details><summary>提示词与术语</summary><div className="prompt-presets">{([['general', '通用'], ['academic', '学术'], ['ai', '计算机 / AI']] as const).map(([id, label]) => <button key={id} onClick={() => edit({ ...config, prompt: prompts[id] })}>{label}</button>)}</div>
          <label className="field">翻译要求<textarea rows={5} value={config.prompt} maxLength={6000} onChange={event => edit({ ...config, prompt: event.target.value })} /></label>
          <label className="field">术语表（每行 原词=译法）<textarea rows={4} value={config.glossary} maxLength={6000} placeholder="segmentation=分割" onChange={event => edit({ ...config, glossary: event.target.value })} /></label></details>
</>}
        <div className="panel-actions"><button className="primary" disabled={!dirty || saving} onClick={() => void save()}>保存设置</button><button disabled={saving || config.profiles.length >= 12} onClick={() => {
          const id = `custom-${crypto.randomUUID()}`; edit({ ...config, activeId: id, profiles: [...config.profiles, { id, name: '自定义服务', provider: 'custom', baseUrl: 'https://example.com/v1', model: '', auth: 'bearer' }] });
        }}>新增自定义配置</button></div>
        {dirty && <p className="muted">设置尚未保存；保存后可配置密钥、测试或翻译。</p>}

      {!!busy && <div role="status" className="panel-actions"><span>正在测试…</span><button onClick={cancel}>取消</button></div>}
      {displayed && <TranslationOutput result={displayed} copy={value => { void copy(value); }} showMetadata={showMetadata} showOriginal={showOriginal} saveNote={documentKey ? () => { void saveAsNote(); } : undefined} retry={() => { void run(displayed.testKind || (displayed.test ? 'test' : 'translate'), displayed); }} disabled={disabled || dirty || !!busy || saving || (profile?.auth !== 'none' && !status.available)} />}
    </>}
    {error && <p className="panel-error" role="alert">{error}</p>}{notice && <p className="muted" role="status">{notice}</p>}
  </section>;
  return <aside className="translation" aria-label="翻译面板">
    {loadError ? <p className="panel-error" role="alert">{loadError}</p> : !api.desktop() ? <p className="hint">在桌面版设置中配置翻译服务。</p> : !config || !profile ? <p className="hint">正在读取设置…</p> : <>
      {!displayed && <>{text ? <><details className="selection-preview"><summary>已选 {text.length} 字 · 第 {selectedPage} 页</summary><p className="selection">{text}</p></details><button className="primary translate-primary" disabled={disabled || dirty || !!busy || saving || !profile.model.trim() || (profile.auth !== 'none' && !status.available)} onMouseDown={event => event.preventDefault()} onClick={() => void run('translate')}>翻译选区</button>{profile.auth !== 'none' && !status.available && <button className="muted" onClick={() => onSettings(true)}>配置翻译服务</button>}</> : <div className="translation-empty"><p>{reader?.pageHasText === false ? '此页暂无可提取文字' : '选择文字，开始翻译'}</p><span>Ctrl + Shift + Enter</span></div>}</>}
      {keepSnapshot && displayed && !!text && displayed.originalRaw !== selectedRaw && <button className="translate-primary"
      disabled={disabled || dirty || !!busy || saving || !profile.model.trim() || (profile.auth !== 'none' && !status.available)}
      onMouseDown={event => event.preventDefault()} onClick={() => { void run('translate'); }}>翻译当前选区</button>}
    {!!busy && <div className="request-actions"><span role="status">翻译中</span><button onClick={cancel}>取消</button></div>}
      {displayed && <TranslationOutput result={displayed} copy={value => { void copy(value); }} showMetadata={showMetadata} showOriginal={showOriginal} saveNote={documentKey ? () => { void saveAsNote(); } : undefined} retry={() => { void run(displayed.testKind || (displayed.test ? 'test' : 'translate'), displayed); }} disabled={disabled || dirty || !!busy || saving || (profile?.auth !== 'none' && !status.available)} />}
    </>}
    {error && <p className="panel-error" role="alert">{error}</p>}{notice && <p className="translation-notice" role="status">{notice}</p>}
  </aside>;
}
