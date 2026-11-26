import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { repository } from '../local/repository';
import type { SecretStatus } from '../translation/client';
import { defaultChat, providerName, type ChatPreferences, type Provider } from './model';

export const CHAT_PREFERENCES_CHANGED = 'pdfreader-chat-preferences-changed';

export function ChatSettings({ onClear }: { onClear: () => void }) {
  const [preferences, setPreferences] = useState(defaultChat().preferences);
  const [provider, setProvider] = useState<Provider>('openai');
  const [sessionOnly, setSessionOnly] = useState(false);
  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const key = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void repository.chat().then(data => setPreferences(data.preferences)).catch(error => setNotice(String(error)));
  }, []);
  useEffect(() => {
    let current = true;
    setStatus(null);
    if (isTauri()) void invoke<SecretStatus>('chat_secret_status', { provider })
      .then(value => { if (current) setStatus(value); })
      .catch(error => { if (current) setNotice(String(error)); });
    return () => { current = false; };
  }, [provider]);
  async function save(next: ChatPreferences) {
    setBusy(true);
    try {
      await repository.saveChatPreferences(next);
      window.dispatchEvent(new Event(CHAT_PREFERENCES_CHANGED));
      setNotice('已保存对话设置。');
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }
  async function credential(remove: boolean) {
    setBusy(true);
    try {
      const value = await invoke<SecretStatus>(remove ? 'chat_secret_delete' : 'chat_secret_save',
        remove ? { provider } : { provider, key: key.current?.value, sessionOnly });
      setStatus(value);
      setNotice(remove ? '已删除密钥。' : sessionOnly ? '密钥已保存至本次应用会话。' : '密钥已保存至 Windows 凭据管理器。');
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); if (key.current) key.current.value = ''; }
  }
  return <section className="chat-settings">
    <h2>AI 对话</h2>
    <label className="field">默认服务 <select value={preferences.provider} onChange={event => setPreferences({ ...preferences, provider: event.target.value as Provider })}>
      {Object.entries(providerName).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select></label>
    {(Object.keys(providerName) as Provider[]).map(id => <label key={id} className="field">{providerName[id]} 默认模型
      <input value={preferences.models[id]} maxLength={80} onChange={event => setPreferences({ ...preferences, models: { ...preferences.models, [id]: event.target.value } })} />
    </label>)}
    <label className="field">自定义提示词<textarea maxLength={4000} rows={3} value={preferences.prompt} onChange={event => setPreferences({ ...preferences, prompt: event.target.value })} /></label>
    <button disabled={busy} onClick={() => { void save(preferences); }}>保存对话设置</button>
    <h3>API 账户</h3>
    {isTauri() ? <>
      <label className="field">配置服务 <select disabled={busy} value={provider} onChange={event => {
        if (key.current) key.current.value = '';
        setProvider(event.target.value as Provider);
      }}>
        {Object.entries(providerName).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <p className="muted">{provider === 'openai' ? 'api.openai.com' : 'api.anthropic.com'} · {status?.available ? status.mode === 'session' ? '本次会话密钥' : 'Windows 凭据管理器已配置' : '未配置可用密钥'}。API 请求由所选服务账户计费。</p>
      <label className="field">API 密钥<input ref={key} type="password" autoComplete="off" /></label>
      <label className="checkbox"><input type="checkbox" checked={sessionOnly} onChange={event => setSessionOnly(event.target.checked)} />仅本次会话</label>
      <button disabled={busy} onClick={() => { void credential(false); }}>保存密钥</button>
      <button disabled={busy || !status?.available} onClick={() => { void credential(true); }}>删除密钥</button>
    </> : <p>请通过 Windows 桌面应用配置 API 密钥。</p>}
    <h3>本地对话历史</h3>
    {confirm ? <div><button onClick={() => { setConfirm(false); onClear(); }}>确认清空历史</button><button onClick={() => setConfirm(false)}>取消</button></div>
      : <button onClick={() => setConfirm(true)}>清空 AI 历史</button>}
    <h3>OpenCode</h3>
    <p className="muted">当前环境尚未验证 OpenCode 所需的 Windows 进程隔离，连接入口处于停用状态。</p>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
