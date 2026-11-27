import { useEffect, useId, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { SecretStatus } from '../translation/client';
import { APP_EVENTS, emitAppEvent } from '../local/events';
import { ApiKeyField } from '../ui/ApiKeyField';
import { apiPresets, chatApi, newApiProfile, type ApiProfile, type SavedApiProfile } from './chat-api';

function editable({ id, name, baseUrl, model, auth, streaming }: ApiProfile): ApiProfile {
  return { id, name, baseUrl, model, auth, streaming };
}

export function ChatApiSettings({ defaultId, onDefault, onDirtyChange }: {
  defaultId: string;
  onDefault: (id: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [profiles, setProfiles] = useState<SavedApiProfile[]>([]);
  const [draft, setDraft] = useState<ApiProfile | null>(null);
  const [preset, setPreset] = useState(0);
  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [modelList, setModelList] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const modelListId = useId();
  const saved = profiles.find(profile => profile.id === draft?.id);
  const routeSaved = saved && saved.baseUrl === draft?.baseUrl.trim().replace(/\/+$/, '') && saved.auth === draft.auth;
  const dirty = !!draft && (!saved || JSON.stringify(editable(saved)) !== JSON.stringify(draft));
  const needsWorkspace = draft?.baseUrl.includes('{WorkspaceId}');

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => {
    onDirtyChange?.(false);
  }, [onDirtyChange]);

  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    void chatApi.list().then(items => {
      if (!current) return;
      setProfiles(items);
      const initial = items.find(item => item.id === defaultId) ?? items[0];
      setDraft(initial ? editable(initial) : null);
      setReady(true);
    }).catch(error => { if (current) setMessage(String(error)); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    setStatus(null);
    setModelList([]);
    if (saved && routeSaved && saved.auth !== 'none') void chatApi.status(saved)
      .then(value => { if (current) setStatus(value); })
      .catch(error => { if (current) setMessage(String(error)); });
    return () => { current = false; };
  }, [saved?.id, saved?.route, routeSaved]);

  function changeDraft(profile: ApiProfile | null) {
    setDraft(profile); setMessage(''); setConfirmDelete(false);
  }

  async function takeAction(action: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await action(); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  function save() {
    if (!draft) return;
    void takeAction(async () => {
      const result = await chatApi.save(draft, saved?.route);
      setProfiles(items => saved ? items.map(item => item.id === draft.id ? result.profile : item) : [...items, result.profile]);
      setDraft(editable(result.profile));
      if (!defaultId) onDefault(result.profile.id);
      emitAppEvent(APP_EVENTS.chatApiProfilesChanged);
      setMessage(result.warning ? `已保存 API 配置。 ${result.warning}` : '已保存 API 配置。');
    });
  }

  function remove() {
    if (!saved) return;
    void takeAction(async () => {
      const warning = await chatApi.remove(saved);
      const remaining = profiles.filter(item => item.id !== saved.id);
      setProfiles(remaining);
      changeDraft(remaining[0] ? editable(remaining[0]) : null);
      if (defaultId === saved.id) onDefault('');
      emitAppEvent(APP_EVENTS.chatApiProfilesChanged);
      setMessage(warning ? `已删除 API 配置。 ${warning}` : '已删除 API 配置。');
    });
  }

  async function saveKey(keyValue: string, sessionOnly: boolean) {
    if (!saved || !routeSaved) return;
    if (!keyValue.trim()) { setMessage('请输入 API 密钥。'); return; }
    await takeAction(async () => {
      setStatus(await chatApi.saveKey(saved, keyValue.trim(), sessionOnly));
      setMessage(sessionOnly ? 'API 密钥已保存至本次会话。' : 'API 密钥已保存至 Windows 凭据管理器。');
    });
  }

  async function deleteKey() {
    if (!saved || !routeSaved) return;
    await takeAction(async () => {
      setStatus(await chatApi.removeKey(saved));
      setMessage('已删除 API 密钥。');
    });
  }

  function readModels() {
    if (!saved || !routeSaved) return;
    void takeAction(async () => {
      const models = await chatApi.models(saved);
      setModelList(models);
      setMessage(models.length ? `已读取 ${models.length} 个模型，可在模型名称中选择。` : '服务返回了空列表，请手动填写模型名称。');
    });
  }

  if (!isTauri()) return <p className="muted">请在 Windows 桌面应用中配置 AI API。</p>;
  return <fieldset className="chat-api-settings" disabled={!ready || busy}>
    <p className="muted">用于 AI 对话的 OpenAI 兼容接口。请求及用量由所选 API 服务处理。</p>
    {profiles.length > 0 && <label className="field">已保存的 API 配置
      <select aria-label="已保存的 API 配置" value={saved?.id ?? ''} onChange={event => {
        const profile = profiles.find(item => item.id === event.target.value);
        if (profile) changeDraft(editable(profile));
      }}>
        {!saved && <option value="">新配置</option>}
        {profiles.map(item => <option key={item.id} value={item.id}>{item.name}{defaultId === item.id ? '（默认）' : ''}</option>)}
      </select>
    </label>}
    <div className="chat-settings-actions">
      <label>服务模板 <select aria-label="服务模板" value={preset} onChange={event => setPreset(Number(event.target.value))}>
        {apiPresets.map((item, index) => <option key={item.name} value={index}>{item.name}</option>)}
      </select></label>
      <button type="button" className="btn-secondary" disabled={profiles.length >= 20} onClick={() => changeDraft(newApiProfile(preset))}>添加 API 配置</button>
    </div>
    {draft && <>
      <div className="compact-fields">
        <label className="field">配置名称<input value={draft.name} maxLength={50} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="field">鉴权方式<select aria-label="鉴权方式" value={draft.auth} onChange={event => setDraft({ ...draft, auth: event.target.value as ApiProfile['auth'] })}>
          <option value="bearer">Bearer API 密钥</option><option value="api-key">api-key 请求头</option><option value="none">无鉴权</option>
        </select></label>
      </div>
      <label className="field">API 地址（Base URL）
        <input aria-label="API 地址" type="url" spellCheck={false} value={draft.baseUrl} maxLength={2048} placeholder="https://api.example.com/v1"
          onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} />
      </label>
      {needsWorkspace && <p className="muted">将 {'{WorkspaceId}'} 换成阿里云百炼的工作空间 ID，或填入控制台提供的兼容 API 地址。</p>}
      <label className="field">模型名称<input value={draft.model} maxLength={256} list={modelListId} spellCheck={false}
        onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
      <datalist id={modelListId}>{modelList.map(model => <option key={model} value={model} />)}</datalist>
      <label className="checkbox"><input type="checkbox" checked={draft.streaming} onChange={event => setDraft({ ...draft, streaming: event.target.checked })} />流式输出</label>
      <div className="chat-settings-actions">
        <button type="button" className="btn-primary" disabled={!dirty || !draft.name.trim() || !draft.baseUrl.trim() || needsWorkspace} onClick={save}>保存 API 配置</button>
        {saved && <button type="button" className="btn-secondary" disabled={defaultId === saved.id || !saved.model} onClick={() => onDefault(saved.id)}>设为默认 API 配置</button>}
        {saved && !confirmDelete && <button type="button" className="btn-danger" onClick={() => setConfirmDelete(true)}>删除 API 配置</button>}
      </div>
      {confirmDelete && <div className="chat-settings-actions">
        <button type="button" className="btn-danger" onClick={remove}>确认删除配置及密钥</button>
        <button type="button" className="btn-secondary" onClick={() => setConfirmDelete(false)}>取消删除</button>
      </div>}
      {saved && routeSaved ? (
        saved.auth !== 'none' ? (
          <ApiKeyField
            resetKey={`${saved.id}|${saved.route}`}
            status={status}
            missingText="请为此配置保存 API 密钥。"
            sessionOnlyLabel="仅本次会话"
            disabled={!ready || busy}
            deleteDisabled={!status?.available}
            extraActions={<button type="button" className="btn-secondary" disabled={!status?.available} onClick={readModels}>读取模型列表</button>}
            onSave={saveKey}
            onDelete={deleteKey}
          />
        ) : (
          <div className="chat-settings-actions">
            <button type="button" className="btn-secondary" onClick={readModels}>读取模型列表</button>
          </div>
        )
      ) : <p className="muted">{saved && saved.auth !== 'none'
        ? '保存新的地址或鉴权方式会移除这个配置的旧密钥。'
        : '保存 API 地址与鉴权方式后，可配置密钥并读取模型列表。'}</p>}
    </>}
    {message && <p role="status">{message}</p>}
  </fieldset>;
}
