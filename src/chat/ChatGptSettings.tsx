import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  activeAccount, openChatGptUsage, readChatGptModels, readChatGptStatus, selectChatGptModel,
  type ChatGptCatalog, type ChatGptSignIn, type ChatGptSignOut, type ChatGptStatus,
} from './chatgpt';
import { APP_EVENTS, emitAppEvent, onAppEvent } from '../local/events';

export function ChatGptSettings({ model, onModel }: { model: string; onModel: (model: string) => void }) {
  const [status, setStatus] = useState<ChatGptStatus | null>(null);
  const [catalog, setCatalog] = useState<ChatGptCatalog | null>(null);
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [reload, setReload] = useState(0);
  const welcome = useRef<HTMLDialogElement>(null);
  const account = activeAccount(status);
  const signingIn = status?.signingIn ?? false;
  const available = !!account?.planEnabled;
  const accountId = account?.id;
  const selected = catalog?.accountId === accountId ? selectChatGptModel(catalog, model) : undefined;
  const waiting = working || signingIn;

  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    let request = 0;
    const read = () => {
      const attempt = ++request;
      void readChatGptStatus().then(value => {
        if (current && request === attempt) setStatus(value);
      }).catch(error => { if (current && request === attempt) setNotice(String(error)); });
    };
    read();
    const stopListening = onAppEvent(APP_EVENTS.chatgptSessionChanged, read);
    return () => { current = false; stopListening(); };
  }, []);

  useEffect(() => {
    setCatalog(null);
    if (!available || !accountId) { setLoadingModels(false); return; }
    let current = true;
    setLoadingModels(true);
    void readChatGptModels(accountId).then(result => {
      if (current && result.accountId === accountId) setCatalog(result);
    }).catch(error => { if (current) setNotice(String(error)); })
      .finally(() => { if (current) setLoadingModels(false); });
    return () => { current = false; };
  }, [accountId, available, reload]);
  useEffect(() => {
    if (selected && selected.slug !== model) onModel(selected.slug);
  }, [selected?.slug, model, onModel]);

  async function signIn(id: string | null, consent = false) {
    setWorking(true); setNotice('请在系统浏览器完成 OpenAI 授权。');
    setStatus(previous => previous && { ...previous, signingIn: true });
    try {
      const result = await invoke<ChatGptSignIn>('chatgpt_sign_in', { accountId: id, consent });
      setStatus(result.status);
      setReload(value => value + 1);
      const allowed = activeAccount(result.status)?.planEnabled;
      setNotice(allowed ? '已连接 ChatGPT 订阅。' : '已登录，请授权使用 ChatGPT 订阅。');
      if (result.firstPlanUse) welcome.current?.showModal();
    } catch (error) { setNotice(String(error)); }
    finally {
      setWorking(false);
      setStatus(previous => previous && { ...previous, signingIn: false });
      emitAppEvent(APP_EVENTS.chatgptSessionChanged);
    }
  }

  async function changeAccount(id: string) {
    setWorking(true); setNotice('');
    try {
      const value = await invoke<ChatGptStatus>('chatgpt_select_account', { accountId: id });
      setStatus(value);
      emitAppEvent(APP_EVENTS.chatgptSessionChanged);
    } catch (error) { setNotice(String(error)); }
    finally { setWorking(false); }
  }

  async function signOut() {
    if (!accountId) return;
    setWorking(true); setNotice('');
    try {
      const result = await invoke<ChatGptSignOut>('chatgpt_sign_out', { accountId });
      setStatus(result.status);
      setNotice(result.revoked ? '已退出此 ChatGPT 账户。' : '已在本机退出。OpenAI 尚未确认撤销，请在 ChatGPT 设置的登录连接中检查。');
      emitAppEvent(APP_EVENTS.chatgptSessionChanged);
    } catch (error) { setNotice(String(error)); }
    finally { setWorking(false); }
  }

  const usage = () => { void openChatGptUsage().catch(error => setNotice(String(error))); };

  if (!isTauri()) return <p className="muted">请在 Windows 桌面应用中登录 ChatGPT。</p>;
  return <div className="chatgpt-settings">
    <p className="muted">使用你的 ChatGPT 订阅运行合资格的对话请求，无需 API 密钥。</p>
    {status && status.accounts.length > 0 && <label className="field">ChatGPT 账户
      <select aria-label="ChatGPT 账户" disabled={waiting} value={status.activeId ?? ''} onChange={event => { void changeAccount(event.target.value); }}>
        {status.accounts.map((item, index) => <option key={item.id} value={item.id}>
          {item.email || `账户 ${index + 1}`}{status.accounts.filter(other => other.email && other.email === item.email).length > 1 ? ` · ${item.id.slice(-6)}` : ''}
        </option>)}
      </select>
    </label>}
    {account?.connected && <p className="muted">{available ? '已授权使用 ChatGPT 订阅' : '已登录，等待订阅授权'}</p>}
    <div className="chat-settings-actions">
      {signingIn ? <button type="button" className="btn-secondary" onClick={() => { void invoke('chatgpt_cancel_sign_in').catch(error => setNotice(String(error))); }}>取消 ChatGPT 登录</button>
        : !account?.connected ? <button type="button" className="chatgpt-login" disabled={!status || waiting} onClick={() => { void signIn(accountId ?? null); }}>使用 ChatGPT 登录</button>
        : <button type="button" className="btn-secondary" disabled={waiting} onClick={() => { void signIn(accountId ?? null, !available); }}>{available ? '重新授权' : '授权使用 ChatGPT 订阅'}</button>}
      {status?.accounts.length && !signingIn ? <button type="button" className="btn-secondary" disabled={waiting} onClick={() => { void signIn(null); }}>添加 ChatGPT 账户</button> : null}
      {account?.connected && <button type="button" className="btn-danger" disabled={waiting} onClick={() => { void signOut(); }}>退出账户</button>}
    </div>
    {available && <>
      <label className="field">ChatGPT 模型
        <select aria-label="ChatGPT 模型" disabled={waiting || !selected} value={selected?.slug ?? ''} onChange={event => onModel(event.target.value)}>
          {!selected && <option value="">{loadingModels ? '正在读取模型…' : '暂无可用模型'}</option>}
          {catalog?.models.map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}
        </select>
      </label>
      <div className="chat-settings-actions">
        <button type="button" className="btn-secondary" disabled={loadingModels || waiting} onClick={() => { setNotice(''); setReload(value => value + 1); }}>刷新模型列表</button>
        <button type="button" className="btn-secondary" onClick={usage}>管理 ChatGPT 用量</button>
      </div>
    </>}
    {notice && <p role="status">{notice}</p>}
    <dialog className="chatgpt-welcome" ref={welcome} aria-label="ChatGPT 订阅已连接" onCancel={event => event.stopPropagation()}>
      <h3>ChatGPT 订阅已连接</h3>
      <p>选用「ChatGPT 订阅」时，合资格的对话会使用你的 ChatGPT 订阅额度。</p>
      <div className="chat-settings-actions">
        <button type="button" className="btn-secondary" onClick={usage}>管理 ChatGPT 用量</button>
        <button type="button" className="btn-primary" onClick={() => welcome.current?.close()}>知道了</button>
      </div>
    </dialog>
  </div>;
}
