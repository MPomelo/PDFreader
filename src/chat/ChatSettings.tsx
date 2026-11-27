import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { repository } from '../local/repository';
import { APP_EVENTS, emitAppEvent } from '../local/events';
import type { SecretStatus } from '../translation/client';
import { ApiKeyField } from '../ui/ApiKeyField';
import { ChatGptSettings } from './ChatGptSettings';
import { ChatApiSettings } from './ChatApiSettings';
import { chatApi } from './chat-api';
import { defaultChat, providerName, providers, validCommands, validOllamaPort, type ChatCommand, type ChatPreferences, type Provider } from './model';

const sections = ['常规', '模型服务', '快捷命令'] as const;

function chatSnapshot(preferences: ChatPreferences, port: string) {
  return JSON.stringify({ preferences, port });
}

export function ChatSettings({ onClear, initialProvider, onDirtyChange, onApiDirtyChange }: {
  onClear: () => void;
  initialProvider?: Provider;
  onDirtyChange?: (dirty: boolean) => void;
  onApiDirtyChange?: (dirty: boolean) => void;
}) {
  const [section, setSection] = useState<(typeof sections)[number]>(initialProvider ? '模型服务' : '常规');
  const [preferences, setPreferences] = useState(defaultChat().preferences);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [provider, setProvider] = useState<Provider>('openai');
  const [port, setPort] = useState('11434');
  const [modelList, setModelList] = useState<string[]>([]);
  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [visitedCompatible, setVisitedCompatible] = useState(initialProvider === 'compatible');
  const local = provider === 'ollama';
  const chatgpt = provider === 'chatgpt';
  const compatible = provider === 'compatible';
  const dirty = ready && savedSnapshot !== '' && chatSnapshot(preferences, port) !== savedSnapshot;

  useEffect(() => {
    if (section === '模型服务' && compatible) setVisitedCompatible(true);
  }, [section, compatible]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => {
    onDirtyChange?.(false);
    onApiDirtyChange?.(false);
  }, [onDirtyChange, onApiDirtyChange]);

  useEffect(() => {
    void repository.chat().then(({ preferences }) => {
      const nextPort = String(preferences.ollamaPort);
      setPreferences(preferences);
      setProvider(initialProvider ?? preferences.provider);
      setPort(nextPort);
      setSavedSnapshot(chatSnapshot(preferences, nextPort));
      setReady(true);
    }).catch(error => setNotice(String(error)));
  }, []);

  useEffect(() => {
    let current = true;
    setStatus(null);
    if (!local && !chatgpt && !compatible && isTauri()) void invoke<SecretStatus>('chat_secret_status', { provider })
      .then(value => { if (current) setStatus(value); })
      .catch(error => { if (current) setNotice(String(error)); });
    return () => { current = false; };
  }, [provider]);

  async function save() {
    const next = {
      ...preferences,
      ollamaPort: Number(port),
      models: Object.fromEntries(providers.map(id => [id, preferences.models[id].trim()])) as ChatPreferences['models'],
      commands: preferences.commands.map(command => ({ name: command.name.trim(), instruction: command.instruction.trim() })),
    };
    if (!validOllamaPort(next.ollamaPort)) {
      setProvider('ollama'); setSection('模型服务'); setNotice('请输入 1 到 65535 之间的端口。'); return;
    }
    if (next.provider !== 'compatible' && !next.models[next.provider]) {
      setProvider(next.provider); setSection('模型服务');
      setNotice(next.provider === 'chatgpt' ? '请先登录 ChatGPT 并选择模型。' : '请为默认服务填写模型名称。'); return;
    }
    if (!validCommands(next.commands)) {
      setSection('快捷命令'); setNotice('命令名称须唯一，且不能包含空格、/ 或 @。每条命令都需要填写提示词。'); return;
    }
    setBusy(true);
    try {
      if (next.provider === 'compatible' && (!isTauri() || !(await chatApi.list()).some(profile => profile.id === next.apiProfileId && profile.model))) {
        setProvider('compatible'); setSection('模型服务');
        setNotice('请保存带有模型名称的 API 配置，并设为默认 API 配置。'); return;
      }
      await repository.saveChatPreferences(next);
      const nextPort = String(next.ollamaPort);
      setPreferences(next);
      setPort(nextPort);
      setSavedSnapshot(chatSnapshot(next, nextPort));
      emitAppEvent(APP_EVENTS.chatPreferencesChanged);
      setNotice('已保存对话设置。');
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  async function saveKey(keyValue: string, sessionOnly: boolean) {
    if (local || chatgpt || compatible) return;
    setBusy(true);
    try {
      const value = await invoke<SecretStatus>('chat_secret_save', { provider, key: keyValue, sessionOnly });
      setStatus(value);
      setNotice(sessionOnly ? '密钥已保存至本次应用会话。' : '密钥已保存至 Windows 凭据管理器。');
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  async function deleteKey() {
    if (local || chatgpt || compatible) return;
    setBusy(true);
    try {
      const value = await invoke<SecretStatus>('chat_secret_delete', { provider });
      setStatus(value);
      setNotice('已删除密钥。');
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  async function detectOllama() {
    if (!validOllamaPort(Number(port))) { setNotice('请输入 1 到 65535 之间的端口。'); return; }
    setBusy(true);
    setModelList([]);
    try {
      const models = await invoke<string[]>('chat_ollama_models', { port: Number(port) });
      setModelList(models);
      setNotice(models.length ? `找到 ${models.length} 个本地模型。` : 'Ollama 尚未安装本地模型。');
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }

  function setModel(model: string) {
    setPreferences(previous => ({ ...previous, models: { ...previous.models, [provider]: model } }));
  }

  function changeCommand(index: number, patch: Partial<ChatCommand>) {
    setPreferences(previous => ({
      ...previous,
      commands: previous.commands.map((command, position) => position === index ? { ...command, ...patch } : command),
    }));
  }

  return <section className="chat-settings">
    <h2>AI设置</h2>
    <nav className="chat-settings-nav" aria-label="对话设置分类">
      {sections.map(item => <button type="button" key={item} aria-current={section === item ? 'page' : undefined} disabled={busy}
        onClick={() => { setSection(item); setNotice(''); }}>{item}</button>)}
    </nav>
    <fieldset className="chat-settings-fields" disabled={!ready || busy}>
      {section === '常规' && <>
        <label className="field">默认模型服务<select aria-label="默认模型服务" value={preferences.provider} onChange={event => setPreferences({ ...preferences, provider: event.target.value as Provider })}>
          {providers.map(id => <option key={id} value={id}>{providerName[id]}</option>)}
        </select></label>
        <label className="field">发送快捷键<select aria-label="发送快捷键" value={preferences.sendShortcut}
          onChange={event => setPreferences({ ...preferences, sendShortcut: event.target.value as ChatPreferences['sendShortcut'] })}>
          <option value="enter">Enter 发送，Shift + Enter 换行</option>
          <option value="ctrl-enter">Ctrl + Enter 发送，Enter 换行</option>
        </select></label>
        <label className="field">系统提示词<textarea maxLength={4000} rows={3} value={preferences.prompt} onChange={event => setPreferences({ ...preferences, prompt: event.target.value })} /></label>
        <h3>本地对话历史</h3>
        {confirm ? <div className="chat-settings-actions"><button type="button" className="btn-danger" onClick={() => { setConfirm(false); onClear(); }}>确认清空历史</button><button type="button" className="btn-secondary" onClick={() => setConfirm(false)}>取消</button></div>
          : <button type="button" className="btn-danger" onClick={() => setConfirm(true)}>清空 AI 历史</button>}
      </>}
      {section === '模型服务' && <>
        <label className="field">配置服务<select aria-label="配置服务" value={provider} onChange={event => {
          setProvider(event.target.value as Provider); setNotice('');
        }}>{providers.map(id => <option key={id} value={id}>{providerName[id]}</option>)}</select></label>
        {!chatgpt && !compatible && <label className="field">模型名称<input value={preferences.models[provider]} maxLength={80} onChange={event => setModel(event.target.value)} /></label>}
        <label className="checkbox"><input type="checkbox" checked={preferences.provider === provider}
          disabled={preferences.provider === provider} onChange={() => setPreferences({ ...preferences, provider })} />设为默认模型服务</label>
        {!compatible && (chatgpt ? <ChatGptSettings model={preferences.models.chatgpt} onModel={setModel} /> : local ? <>
          <p className="muted">连接本机 Ollama，可直接使用已下载的模型，无需 API 密钥。</p>
          <label className="field">本机端口<input value={port} inputMode="numeric" maxLength={5}
            onChange={event => { setPort(event.target.value); setModelList([]); }} /></label>
          <button type="button" className="btn-secondary" disabled={!isTauri()} onClick={() => { void detectOllama(); }}>检测本地模型</button>
          {!!modelList.length && <label className="field">已下载的模型<select aria-label="已下载的模型" value={modelList.includes(preferences.models.ollama) ? preferences.models.ollama : ''}
            onChange={event => setModel(event.target.value)}>
            <option disabled value="">选择模型</option>
            {modelList.map(model => <option key={model} value={model}>{model}</option>)}
          </select></label>}
        </> : isTauri() ? <ApiKeyField
          resetKey={provider}
          status={status}
          statusPrefix={`${provider === 'openai' ? 'api.openai.com' : 'api.anthropic.com'} · `}
          statusSuffix="。请求由相应服务账户计费。"
          missingText="未配置可用密钥"
          sessionOnlyLabel="仅本次会话"
          disabled={!ready || busy}
          deleteDisabled={!status?.available}
          onSave={saveKey}
          onDelete={deleteKey}
        /> : <p>请通过 Windows 桌面应用配置 API 密钥。</p>)}
      </>}
      {visitedCompatible && <div hidden={!(section === '模型服务' && compatible)}>
        <ChatApiSettings
          defaultId={preferences.apiProfileId}
          onDefault={id => setPreferences(previous => ({ ...previous, apiProfileId: id }))}
          onDirtyChange={onApiDirtyChange}
        />
      </div>}
      {section === '快捷命令' && <>
        <p className="muted">在对话输入框开头输入 /，可选择已保存的命令。</p>
        {preferences.commands.map((command, index) => <div className="chat-command-settings" key={index}>
          <label className="field">命令名称<input maxLength={24} value={command.name} onChange={event => changeCommand(index, { name: event.target.value })} /></label>
          <label className="field">命令提示词<textarea maxLength={4000} rows={2} value={command.instruction}
            onChange={event => changeCommand(index, { instruction: event.target.value })} /></label>
          <button type="button" className="btn-danger" onClick={() => setPreferences({ ...preferences, commands: preferences.commands.filter((_, position) => position !== index) })}>删除命令</button>
        </div>)}
        <button type="button" className="btn-secondary" disabled={preferences.commands.length >= 20}
          onClick={() => setPreferences({ ...preferences, commands: [...preferences.commands, { name: '', instruction: '' }] })}>添加命令</button>
      </>}
    </fieldset>
    <div className="chat-settings-save"><button type="button" className="btn-primary" disabled={!ready || busy} onClick={() => { void save(); }}>保存对话设置</button>
      {notice && <p role="status">{notice}</p>}</div>
  </section>;
}
