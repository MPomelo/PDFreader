import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  api, MATH_TEST_TEXT, RequestGate, StreamAccumulator,
  type ApiConfig, type ApiResult, type DisplayResult, type Profile, type SecretStatus,
} from './client';
import { TranslationOutput } from './TranslationOutput';
import { APP_EVENTS, emitAppEvent, onAppEvent } from '../local/events';
import { ApiKeyField } from '../ui/ApiKeyField';

type TestKind = 'test' | 'math-test' | 'models';

export type TranslationDirtyState = {
  translation: boolean;
  api: boolean;
};

type Props = {
  section: 'translation' | 'api';
  automatic: boolean;
  onAutomatic: (enabled: boolean) => void;
  onDirtyChange?: (state: TranslationDirtyState) => void;
  showMetadata?: boolean;
  showOriginal?: boolean;
};

const prompts = {
  general: '准确翻译为目标语言，保持原文语气与段落，只输出译文。',
  academic: '忠实翻译学术文本，保留公式、引用编号、变量及 Markdown 结构；只输出译文，不补写原文缺失内容。',
  ai: '准确翻译计算机与人工智能论文，注意模型、训练流程、数据集和指标术语；保留数学公式、变量、引用编号，只输出译文。',
};

function translationPrefSlice(value: ApiConfig) {
  return {
    targetLanguage: value.targetLanguage,
    prompt: value.prompt,
    glossary: value.glossary,
    streaming: value.streaming !== false,
    answerStyle: value.answerStyle || 'concise',
  };
}

function apiConfigSlice(value: ApiConfig) {
  return {
    activeId: value.activeId,
    profiles: value.profiles,
    timeoutSeconds: value.timeoutSeconds,
    maxTokens: value.maxTokens,
  };
}

export function TranslationSettings({
  section, automatic, onAutomatic, onDirtyChange, showMetadata = false, showOriginal = false,
}: Props) {
  const [config, setConfig] = useState<ApiConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<ApiConfig | null>(null);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<SecretStatus>({ available: false, mode: 'missing' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<DisplayResult | null>(null);
  const [live, setLive] = useState<DisplayResult | null>(null);
  const latestLive = useRef<DisplayResult | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const gate = useRef(new RequestGate(api.cancel));
  const runLock = useRef(false);
  const statusRevision = useRef(0);
  const settingsRef = useRef('');

  const currentConfig = config ? JSON.stringify(config) : '';
  const saved = savedConfig ? JSON.stringify(savedConfig) : '';
  const translationDirty = !!config && !!savedConfig
    && JSON.stringify(translationPrefSlice(config)) !== JSON.stringify(translationPrefSlice(savedConfig));
  const apiDirty = !!config && !!savedConfig
    && JSON.stringify(apiConfigSlice(config)) !== JSON.stringify(apiConfigSlice(savedConfig));
  const dirty = translationDirty || apiDirty;
  const profile = config?.profiles.find(item => item.id === config.activeId);

  useLayoutEffect(() => { settingsRef.current = currentConfig; });

  useEffect(() => {
    onDirtyChange?.({ translation: translationDirty, api: apiDirty });
  }, [translationDirty, apiDirty, onDirtyChange]);

  useEffect(() => () => {
    onDirtyChange?.({ translation: false, api: false });
  }, [onDirtyChange]);

  function updateLive(value: DisplayResult | null) {
    latestLive.current = value;
    setLive(value);
  }

  async function load() {
    try {
      setLoadError('');
      const loaded = await api.load();
      setConfig(loaded);
      setSavedConfig(loaded);
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
        updateLive({ ...latestLive.current, outcome: 'cancelled' });
      }
      void load();
    };
    const stopListening = onAppEvent(APP_EVENTS.apiSettingsChanged, refresh);
    return () => {
      stopListening();
      gate.current.invalidate();
      ++statusRevision.current;
    };
  }, []);

  useEffect(() => {
    setModels([]);
    setStatus({ mode: 'missing', available: false });
    const revision = ++statusRevision.current;
    if (!profile || dirty || !api.desktop()) return;
    void api.status(profile.id)
      .then(value => { if (statusRevision.current === revision) setStatus(value); })
      .catch(() => { if (statusRevision.current === revision) setStatus({ mode: 'unavailable', available: false }); });
  }, [saved, currentConfig]);

  function edit(next: ApiConfig) {
    gate.current.invalidate();
    runLock.current = false;
    setBusy('');
    setResult(null);
    updateLive(null);
    setError('');
    setNotice('');
    setConfig(next);
  }

  function editProfile(patch: Partial<Profile>) {
    if (config && profile) {
      edit({ ...config, profiles: config.profiles.map(item => item.id === profile.id ? { ...item, ...patch } : item) });
    }
  }

  function preferences(patch: Partial<ApiConfig>) {
    if (config) edit({ ...config, ...patch });
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.save(config);
      setSavedConfig(config);
      setNotice('设置已保存。');
      emitAppEvent(APP_EVENTS.apiSettingsChanged);
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveKey(keyValue: string, sessionOnly: boolean) {
    if (!profile || dirty) return;
    gate.current.invalidate();
    runLock.current = false;
    setBusy('');
    setSaving(true);
    setError('');
    setNotice('');
    try {
      setStatus(await api.saveKey(profile.id, keyValue, sessionOnly));
      setNotice(sessionOnly ? '本次输入的密钥只在当前会话内使用；此前安全保存的密钥不变。' : '密钥已保存在 Windows 凭据管理器。');
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
      emitAppEvent(APP_EVENTS.apiSettingsChanged);
    }
  }

  async function deleteKey() {
    if (!profile || dirty) return;
    gate.current.invalidate();
    runLock.current = false;
    setBusy('');
    setSaving(true);
    setError('');
    try {
      setStatus(await api.deleteKey(profile.id));
      setNotice('此配置与地址对应的密钥已删除。');
    } catch (error) {
      setError(String(error));
      setStatus(await api.status(profile.id).catch(() => ({ available: false, mode: 'unavailable' as const })));
    } finally {
      setSaving(false);
      emitAppEvent(APP_EVENTS.apiSettingsChanged);
    }
  }

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
    if (latestLive.current) updateLive({ ...latestLive.current, outcome: 'cancelled' });
  }

  async function run(kind: TestKind) {
    if (!config || !profile || dirty || runLock.current) return;
    const configSnapshot = settingsRef.current;
    const id = crypto.randomUUID();
    const generation = gate.current.begin(id);
    runLock.current = true;
    setBusy(kind);
    setError('');
    setNotice('');
    if (kind !== 'models') {
      setResult(null);
      updateLive(null);
    }
    const testKind = kind === 'test' || kind === 'math-test' ? kind : undefined;
    const testText = kind === 'math-test' ? MATH_TEST_TEXT : 'The sky is blue.';
    const metadata = {
      original: testText,
      originalRaw: testText,
      page: 0,
      test: !!testKind,
      testKind,
      service: profile.name,
      domain: config.prompt,
      language: config.targetLanguage,
    };
    const request = { requestId: id, documentId: '', profileId: profile.id, kind, text: '' };
    try {
      let response: ApiResult;
      if (kind !== 'models' && config.streaming !== false) {
        const accumulator = new StreamAccumulator();
        updateLive({
          ...metadata,
          outcome: 'streaming',
          response: { requestId: id, documentId: '', text: '', reasoning: '', model: profile.model, elapsedMs: 0, usage: null, models: [] },
        });
        response = await api.stream(request, chunk => {
          if (!gate.current.accepts(generation, id) || chunk.requestId !== id || chunk.documentId !== '' || settingsRef.current !== configSnapshot) return;
          try {
            if (accumulator.push(chunk)) {
              updateLive({
                ...metadata,
                outcome: 'streaming',
                response: { requestId: id, documentId: '', text: accumulator.text, reasoning: accumulator.reasoning, model: profile.model, elapsedMs: 0, usage: null, models: [] },
              });
            }
          } catch (error) {
            gate.current.invalidate();
            runLock.current = false;
            setBusy('');
            setError(String(error));
            if (latestLive.current) updateLive({ ...latestLive.current, outcome: 'error' });
          }
        });
      } else {
        response = await api.request(request);
      }
      if (!gate.current.accepts(generation, id) || settingsRef.current !== configSnapshot || response.requestId !== id || response.documentId !== '') return;
      if (kind === 'models') {
        setModels(response.models);
        setNotice(response.models.length ? `已读取 ${response.models.length} 个模型，也可手填。` : '模型列表为空，请手填。');
      } else {
        setResult({ response, ...metadata, outcome: 'complete' });
        updateLive(null);
      }
    } catch (error) {
      if (gate.current.accepts(generation, id)) {
        setError(String(error));
        if (latestLive.current) updateLive({ ...latestLive.current, outcome: 'error' });
      }
    } finally {
      if (gate.current.accepts(generation, id)) {
        gate.current.finish(generation, id);
        runLock.current = false;
        setBusy('');
      }
    }
  }

  const displayed = result || live;

  return <section className="translation-settings">
    {!api.desktop() ? <p className="hint">桌面版支持服务配置。</p>
      : loadError ? <><p role="alert">{loadError}</p><button type="button" className="btn-secondary" onClick={() => void load()}>重新读取设置</button></>
      : !config || !profile ? <p role="status">正在读取设置…</p>
      : <>
        {section === 'api' ? <>
          <h2>翻译配置</h2>
          <p className="muted">设置选区翻译使用的服务、模型和密钥。</p>
          <label className="field">服务配置
            <select aria-label="服务配置" value={config.activeId} disabled={saving} onChange={event => edit({ ...config, activeId: event.target.value })}>
              {config.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <fieldset className="api-settings" disabled={saving}>
            <label className="field">配置名称<input value={profile.name} maxLength={80} onChange={event => editProfile({ name: event.target.value })} /></label>
            <label className="field">Base URL<input type="url" value={profile.baseUrl} onChange={event => editProfile({ baseUrl: event.target.value })} spellCheck={false} /></label>
            <label className="field">鉴权
              <select aria-label="鉴权" value={profile.auth} onChange={event => editProfile({ auth: event.target.value as Profile['auth'] })}>
                <option value="bearer">Authorization: Bearer</option>
                <option value="api-key">api-key</option>
                <option value="none">不使用密钥</option>
              </select>
            </label>
            <label className="field">模型
              <input aria-label="模型" list="api-models" value={profile.model} maxLength={256} onChange={event => editProfile({ model: event.target.value })} placeholder="填写服务提供的模型名称" spellCheck={false} />
              <datalist id="api-models">{models.map(id => <option key={id} value={id} />)}</datalist>
            </label>
            <button type="button" className="btn-secondary" disabled={dirty || !!busy || saving || (profile.auth !== 'none' && !status.available)} onClick={() => void run('models')}>读取模型列表</button>
            <p className="muted">模型列表可选；不支持时直接填写模型。修改地址或鉴权后须重新配置对应密钥。</p>
            <div className="compact-fields">
              <label className="field">超时（秒）<input type="number" min={5} max={180} value={config.timeoutSeconds} onChange={event => edit({ ...config, timeoutSeconds: Number(event.target.value) })} /></label>
              <label className="field">输出 token 上限<input type="number" min={128} max={32768} value={config.maxTokens} onChange={event => edit({ ...config, maxTokens: Number(event.target.value) })} /></label>
            </div>
            {profile.auth !== 'none' && <ApiKeyField
              resetKey={`${profile.id}|${saved}|${currentConfig}`}
              status={status}
              missingText="此配置与地址尚未配置密钥。"
              inputLabel="输入新密钥"
              inputPlaceholder="留空不会更改已有密钥"
              saveLabel="保存 / 替换密钥"
              disabled={dirty || saving}
              onSave={saveKey}
              onDelete={deleteKey}
            />}
            <div className="panel-actions">
              <button type="button" className="btn-secondary" disabled={dirty || !!busy || saving || !profile.model.trim() || (profile.auth !== 'none' && !status.available)} onClick={() => void run('test')}>测试连接（发送固定短句）</button>
              <button type="button" className="btn-secondary" disabled={dirty || !!busy || saving || !profile.model.trim() || (profile.auth !== 'none' && !status.available)} onClick={() => void run('math-test')}>测试公式（固定样例）</button>
            </div>
            <p className="muted">连接测试发送固定短句，公式测试发送固定公式，不使用 PDF 内容；测试和翻译可能产生服务商费用，不自动重试或切换服务。</p>
          </fieldset>
        </> : <>
          <h2>翻译偏好</h2>
          <label className="field">目标语言<input value={config.targetLanguage} maxLength={50} onChange={event => edit({ ...config, targetLanguage: event.target.value })} /></label>
          <div className="translation-preferences">
            <label className="checkbox"><input type="checkbox" checked={config.streaming !== false} disabled={saving} onChange={event => preferences({ streaming: event.target.checked })} />流式输出</label>
            <label>回答样式
              <select aria-label="回答样式" value={config.answerStyle || 'concise'} disabled={saving} onChange={event => preferences({ answerStyle: event.target.value as 'concise' | 'detailed' })}>
                <option value="concise">普通译文</option>
                <option value="detailed">长回答与术语说明</option>
              </select>
            </label>
          </div>
          <label className="checkbox"><input type="checkbox" checked={automatic} onChange={event => onAutomatic(event.target.checked)} />选中文字后自动翻译（仅本次运行，可能产生费用）</label>
          <p className="muted">Ctrl+Shift+Enter 翻译选区；自动翻译默认关闭。</p>
          <details>
            <summary>提示词与术语</summary>
            <div className="prompt-presets">
              {([['general', '通用'], ['academic', '学术'], ['ai', '计算机 / AI']] as const).map(([id, label]) => (
                <button type="button" className="btn-secondary" key={id} onClick={() => edit({ ...config, prompt: prompts[id] })}>{label}</button>
              ))}
            </div>
            <label className="field">翻译要求<textarea rows={5} value={config.prompt} maxLength={6000} onChange={event => edit({ ...config, prompt: event.target.value })} /></label>
            <label className="field">术语表（每行 原词=译法）<textarea rows={4} value={config.glossary} maxLength={6000} placeholder="segmentation=分割" onChange={event => edit({ ...config, glossary: event.target.value })} /></label>
          </details>
        </>}
        <div className="panel-actions">
          <button type="button" className="btn-primary" disabled={!dirty || saving} onClick={() => void save()}>保存设置</button>
          {section === 'api' && <button type="button" className="btn-secondary" disabled={saving || config.profiles.length >= 12} onClick={() => {
            const id = `custom-${crypto.randomUUID()}`;
            edit({ ...config, activeId: id, profiles: [...config.profiles, { id, name: '自定义服务', provider: 'custom', baseUrl: 'https://example.com/v1', model: '', auth: 'bearer' }] });
          }}>新增自定义配置</button>}
        </div>
        {dirty && <p className="muted">设置尚未保存；保存后可配置密钥、测试或翻译。</p>}
        {!!busy && <div role="status" className="panel-actions"><span>正在测试…</span><button type="button" className="btn-secondary" onClick={cancel}>取消</button></div>}
        {displayed && <TranslationOutput result={displayed} copy={value => { void copy(value); }} showMetadata={showMetadata} showOriginal={showOriginal}
          retry={() => { void run(displayed.testKind || 'test'); }}
          disabled={dirty || !!busy || saving || (profile?.auth !== 'none' && !status.available)} />}
      </>}
    {error && <p className="panel-error" role="alert">{error}</p>}
    {notice && <p className="muted" role="status">{notice}</p>}
  </section>;
}
