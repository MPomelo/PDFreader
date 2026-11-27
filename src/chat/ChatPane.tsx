import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import {
  Add16Regular, ArrowClockwise16Regular, ArrowDownload16Regular, ChevronDown16Regular,
  ChevronLeft16Regular, Copy16Regular, Delete16Regular, Dismiss16Regular, History16Regular,
} from '@fluentui/react-icons';
import { repository } from '../local/repository';
import { APP_EVENTS, onAppEvent } from '../local/events';
import { MarkdownRenderer } from '../translation/MarkdownRenderer';
import { chatApi, type SavedApiProfile } from './chat-api';
import {
  activeAccount, openChatGptUsage, readChatGptModels, readChatGptStatus, selectChatGptModel, type ChatGptCatalog,
} from './chatgpt';
import { chatMessages, conversationName, defaultChat, materialMarker, providerName, providers, turnProviderName, type ChatCommand, type Conversation, type Material, type MaterialMode, type Provider, type Turn } from './model';
import './chat.css';

export type { Material } from './model';
type Chunk = { requestId: string; sessionId: string; sequence: number; text: string };
type Result = { text: string; model: string; usage: Record<string, number> | null };
type DocumentChoice = { id: string; name: string; kind: string };
const contextLimit = 192000;
const materialLimit = 32000;

function markdownExport(turns: Turn[]) {
  return '# PDFreader 对话\n\n' + turns.map(turn => {
    const sources = turn.materials.map(item =>
      `- ${materialMarker(item)} · ${item.name.replace(/[\r\n]/g, ' ')}${item.page ? ' · 第 ' + item.page + ' 页' : item.line ? ' · 第 ' + item.line + ' 行' : ''}\n\n${item.text.split('\n').map(line => '> ' + line).join('\n')}`).join('\n\n');
    return `## 问题\n\n${turn.prompt}\n\n${sources}\n\n## ${turnProviderName(turn)} · ${turn.model}\n\n${turn.text}`;
  }).join('\n\n---\n\n');
}

export function ChatPane({ id, visible, incoming, onReceive, onTemporary, documents, getMaterial, onLocate, onOpenHistory, onDeleteHistory, onNew, onSettings, clearRevision, stopRegistration }: {
  id: string; visible: boolean; incoming?: Material[]; onReceive: () => void; onTemporary: (temporary: boolean) => void;
  documents: DocumentChoice[]; getMaterial: (id: string, mode: MaterialMode) => Promise<Material>;
  onLocate: (material: Material) => Promise<void>; onOpenHistory: (conversation: Conversation) => void;
  onDeleteHistory: (id: string) => Promise<void>; clearRevision: number; stopRegistration: (id: string, stop: (() => Promise<void>) | null) => void;
  onNew: () => void; onSettings: (provider: Provider) => void;
}) {
  const [preferences, setPreferences] = useState(defaultChat().preferences);
  const [provider, setProvider] = useState<Provider>('openai');
  const [model, setModel] = useState(preferences.models.openai);
  const [catalog, setCatalog] = useState<ChatGptCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [apiProfiles, setApiProfiles] = useState<SavedApiProfile[]>([]);
  const [apiProfileId, setApiProfileId] = useState('');
  const [apiError, setApiError] = useState('');
  const [draft, setDraft] = useState('');
  const [materials, setMaterials] = useState<Material[]>([]);
  const [picker, setPicker] = useState<'materials' | 'commands' | 'model' | null>(null);
  const [source, setSource] = useState<DocumentChoice | null>(null);
  const [query, setQuery] = useState('');
  const [command, setCommand] = useState<ChatCommand | null>(null);
  const [adding, setAdding] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const choices = useRef<HTMLDivElement>(null);
  const chosenModel = useRef(false);
  const log = useRef<HTMLDivElement>(null);
  const followReply = useRef(true);
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  const pending = useRef('');
  const clearedAt = useRef(clearRevision);
  const alive = useRef(true);
  const [temporary, setTemporary] = useState(false), temp = useRef(false);
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<Conversation[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [ready, setReady] = useState(false);
  const [clearing, setClearing] = useState(false);
  const busy = turns.at(-1)?.state === 'streaming';
  const canSend = !!(draft.trim() || command);
  const selectedGpt = provider === 'chatgpt' ? selectChatGptModel(catalog, model) : undefined;
  const apiProfile = apiProfiles.find(profile => profile.id === apiProfileId);
  const apiModel = apiProfile ? model.trim() || apiProfile.model : '';
  const displayedModel = provider === 'chatgpt' ? selectedGpt?.name : provider === 'compatible' ? apiModel : model;
  const matchingDocuments = documents.filter(document => document.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const matchingCommands = preferences.commands.filter(item => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const references = new Map(turns.flatMap(turn => turn.materials).map(material => [materialMarker(material), material]));
  function citedMaterials(text: string) {
    const markers = new Set([...text.matchAll(/\[\[(M[a-f0-9]{32})\]\]/g)].map(match => match[1]));
    return [...markers].flatMap(marker => references.get(marker) ?? []);
  }

  function update(next: Turn[]) { turnsRef.current = next; if (alive.current) setTurns(next); }
  async function persist(next = turnsRef.current) {
    if (temp.current || !next.length) return;
    try { await repository.saveConversation({ id, turns: next, updated: new Date().toISOString() }); }
    catch (error) { if (alive.current) setMessage(String(error)); }
  }
  async function cancel() {
    const requestId = pending.current;
    if (!requestId) return;
    pending.current = '';
    const next = turnsRef.current.map(turn => turn.state === 'streaming' ? { ...turn, state: 'stopped' as const } : turn);
    update(next);
    await Promise.all([invoke('api_cancel', { requestId }).catch(() => {}), persist(next)]);
  }
  const stop = useRef(cancel); stop.current = cancel;
  useLayoutEffect(() => {
    if (followReply.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [turns]);
  useEffect(() => {
    alive.current = true;
    stopRegistration(id, () => stop.current());
    void repository.chat().then(data => {
      if (!alive.current) return;
      const initial = data.conversations.find(item => item.id === id);
      const restored = (initial?.turns ?? []).map(turn => turn.state === 'streaming' ? { ...turn, state: 'stopped' as const } : turn);
      update(restored);
      const last = restored.at(-1);
      const defaultProvider = last?.provider ?? data.preferences.provider;
      setPreferences(data.preferences); setProvider(defaultProvider);
      setModel(last?.model || data.preferences.models[defaultProvider]);
      setApiProfileId(last?.apiProfileId ?? data.preferences.apiProfileId);
    }).catch(error => setMessage(String(error))).finally(() => { if (alive.current) setReady(true); });
    const refresh = () => { void repository.chat().then(({ preferences }) => {
      if (!alive.current) return;
      setPreferences(preferences);
      if (!turnsRef.current.length && !chosenModel.current) {
        setProvider(preferences.provider);
        setModel(preferences.models[preferences.provider]);
        setApiProfileId(preferences.apiProfileId);
      }
    }).catch(() => {}); };
    const stopPreferences = onAppEvent(APP_EVENTS.chatPreferencesChanged, refresh);
    return () => {
      alive.current = false;
      stopRegistration(id, null);
      stopPreferences();
      void stop.current();
    };
  }, [id]);
  useEffect(() => {
    if (provider !== 'chatgpt' || !visible || !isTauri()) return;
    let current = true;
    let generation = 0;
    const read = async () => {
      const request = ++generation;
      setCatalog(null);
      setCatalogError('');
      try {
        const account = activeAccount(await readChatGptStatus());
        if (!current || generation !== request) return;
        if (!account?.connected) throw Error('请在「AI设置」中登录 ChatGPT。');
        if (!account.planEnabled) throw Error('请授权使用 ChatGPT 订阅。');
        const result = await readChatGptModels(account.id);
        if (current && generation === request && result.accountId === account.id) {
          setCatalog(result);
          if (!result.models.length) setCatalogError('当前账户没有可用的 ChatGPT 模型。');
        }
      } catch (error) {
        if (current && generation === request) setCatalogError(error instanceof Error ? error.message : String(error));
      }
    };
    void read();
    const refresh = () => { void read(); };
    const stopSession = onAppEvent(APP_EVENTS.chatgptSessionChanged, refresh);
    return () => { current = false; stopSession(); };
  }, [provider, visible]);
  useEffect(() => {
    if (provider !== 'compatible' || !visible || !isTauri()) return;
    let current = true;
    let generation = 0;
    const read = () => {
      const request = ++generation;
      setApiProfiles([]);
      setApiError('');
      void chatApi.list().then(profiles => { if (current && request === generation) setApiProfiles(profiles); })
        .catch(error => { if (current && request === generation) setApiError(String(error)); });
    };
    read();
    const stopProfiles = onAppEvent(APP_EVENTS.chatApiProfilesChanged, read);
    return () => { current = false; stopProfiles(); };
  }, [provider, visible]);
  useEffect(() => {
    if (clearedAt.current === clearRevision) return;
    clearedAt.current = clearRevision;
    update([]); setHistory([]); setMaterials([]); setDraft(''); setCommand(null); setPicker(null);
  }, [clearRevision]);
  useEffect(() => {
    if (!incoming?.length) return;
    setMaterials(previous => [...previous, ...incoming.filter(item => !previous.some(existing => item.id === existing.id))]);
    onReceive();
  }, [incoming]);

  async function run(turn: Turn, previous: Turn[]) {
    if (pending.current || !ready) return;
    setMessage('');
    if (!isTauri()) { setMessage('请在 Windows 桌面应用发送 AI 请求。'); return; }
    const messages = chatMessages(previous, turn);
    const size = new TextEncoder().encode(messages.map(item => item.text).join('')).length;
    if (turn.materials.length > 32 || turn.materials.some(item => new TextEncoder().encode(item.text).length > materialLimit) ||
      size > contextLimit || messages.length > 161 || previous.length >= 100) {
      setMessage('材料或对话超出容量上限。请删除材料、缩小选区或打开新对话。');
      return;
    }
    if (!turn.model.trim()) { setMessage('请填写模型名称。'); return; }
    const requestId = crypto.randomUUID();
    const next = [...previous, turn];
    followReply.current = true;
    pending.current = requestId;
    update(next);
    await persist(next);
    if (pending.current !== requestId) return;
    let sequence = 0;
    const onChunk = new Channel<Chunk>(chunk => {
      if (pending.current !== requestId || chunk.requestId !== requestId || chunk.sessionId !== id || chunk.sequence <= sequence) return;
      sequence = chunk.sequence;
      update(turnsRef.current.map(item => item.id === turn.id ? { ...item, text: item.text + chunk.text } : item));
    });
    try {
      const result = await invoke<Result>('chat_request', { request: {
        requestId, sessionId: id, provider: turn.provider, model: turn.model, prompt: preferences.prompt, messages,
        ollamaPort: turn.provider === 'ollama' ? turn.ollamaPort ?? preferences.ollamaPort : undefined,
        chatgptAccount: turn.provider === 'chatgpt' ? turn.chatgptAccount : undefined,
        apiProfileId: turn.apiProfileId,
        apiProfileRoute: turn.apiProfileRoute,
      }, onChunk });
      if (pending.current !== requestId) return;
      update(turnsRef.current.map(item => item.id === turn.id ? { ...item, ...result, usage: result.usage ?? undefined, state: 'complete' } : item));
    } catch (error) {
      if (pending.current !== requestId) return;
      update(turnsRef.current.map(item => item.id === turn.id ? { ...item, state: 'failed', error: String(error) } : item));
    } finally {
      if (pending.current === requestId) {
        pending.current = '';
        await persist();
      }
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend || pending.current || adding) return;
    if (provider === 'chatgpt' && (!selectedGpt || !catalog)) {
      setMessage(catalogError || '正在读取 ChatGPT 模型，请稍候。'); return;
    }
    if (provider === 'chatgpt' && turnsRef.current.some(turn => turn.chatgptAccount && turn.chatgptAccount !== catalog?.accountId)) {
      setMessage('此对话包含另一 ChatGPT 账户的历史。请新建对话，或切回原账户。'); return;
    }
    if (provider === 'compatible' && (!apiProfile || !apiModel)) {
      setMessage(apiError || '请选择 API 配置并填写模型名称。'); return;
    }
    void run({ id: crypto.randomUUID(), prompt: draft.trim() || command!.name, instruction: command?.instruction,
      materials: [...materials], provider, model: selectedGpt?.slug ?? (provider === 'compatible' ? apiModel : model.trim()), text: '', state: 'streaming',
      apiProfileId: provider === 'compatible' ? apiProfile?.id : undefined,
      apiProfileRoute: provider === 'compatible' ? apiProfile?.route : undefined,
      apiProfileName: provider === 'compatible' ? apiProfile?.name : undefined,
      chatgptAccount: provider === 'chatgpt' ? catalog?.accountId : undefined,
      ollamaPort: provider === 'ollama' ? preferences.ollamaPort : undefined }, turnsRef.current);
    if (pending.current) { setDraft(''); setMaterials([]); setCommand(null); setPicker(null); }
  }
  function editDraft(value: string) {
    setDraft(value);
    const mention = value.match(/(?:^|\s)@([^\s@]*)$/u);
    const slash = !command && value.match(/^\/([^\s/]*)$/u);
    setSource(null);
    setQuery(mention?.[1] ?? (slash ? slash[1] : ''));
    setPicker(mention ? 'materials' : slash ? 'commands' : null);
  }
  function togglePicker(next: typeof picker) {
    setSource(null); setQuery(''); setPicker(picker === next ? null : next);
  }
  function chooseCommand(next: ChatCommand) {
    setCommand(next); setPicker(null); setDraft(value => value.replace(/^\/[^\s/]*$/u, ''));
    textarea.current?.focus();
  }
  async function add(document: DocumentChoice, mode: MaterialMode) {
    const revision = clearedAt.current;
    setAdding(true);
    try {
      const material = await getMaterial(document.id, mode);
      if (!alive.current || clearedAt.current !== revision) return;
      if (new TextEncoder().encode(material.text).length > materialLimit) throw Error('资料太长，请缩小选区后再添加。');
      setMaterials(previous => previous.some(item => item.documentId === material.documentId && item.page === material.page &&
        item.line === material.line && item.text === material.text) ? previous : [...previous, material]);
      setDraft(value => value.replace(/(^|\s)@[^\s@]*$/u, '$1'));
      setPicker(null); setSource(null);
      setMessage('');
      textarea.current?.focus();
    } catch (error) { if (alive.current && clearedAt.current === revision) setMessage(String(error)); }
    finally { if (alive.current) setAdding(false); }
  }
  async function toggleTemporary(value: boolean) {
    setClearing(true);
    try {
      if (value) await repository.deleteConversations([id]);
      temp.current = value; setTemporary(value); onTemporary(value);
      if (!value) await persist();
    } catch (error) { setMessage(String(error)); }
    finally { setClearing(false); }
  }
  async function list() {
    try {
      setHistory((await repository.chat()).conversations);
      setConfirmDeleteId('');
      setShowHistory(!showHistory);
    } catch (error) { setMessage(String(error)); }
  }
  async function exportMarkdown() {
    try {
      const markdown = markdownExport(turnsRef.current);
      if (isTauri()) await invoke('export_chat', { markdown });
      else {
        const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
        const link = document.createElement('a');
        link.href = url; link.download = 'PDFreader-对话.md'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) { setMessage(String(error)); }
  }
  return <div className="chat-pane">
    <div className="chat-header">
      <button type="button" aria-expanded={showHistory} onClick={() => { void list(); }}><History16Regular />对话历史</button>
      <label><input type="checkbox" checked={temporary} disabled={busy || clearing || !ready} onChange={event => { void toggleTemporary(event.target.checked); }} />临时会话</label>
      <div className="chat-header-actions">
        {turns.length > 0 && <button type="button" className="chat-export" title="导出 Markdown" onClick={() => { void exportMarkdown(); }}><ArrowDownload16Regular />导出 MD</button>}
        <button type="button" className="chat-new" onClick={onNew}><Add16Regular />新对话</button>
      </div>
    </div>
    {showHistory && <ul className="chat-history">
      {history.length ? history.map(conversation => {
        const title = conversationName(conversation);
        const confirming = confirmDeleteId === conversation.id;
        return <li className="chat-history-item" key={conversation.id}>
          <button type="button" className="chat-history-open" title={title} onClick={() => { onOpenHistory(conversation); setConfirmDeleteId(''); setShowHistory(false); }}>
            <span>{title}</span>
          </button>
          {confirming ? <div className="chat-history-confirm">
            <button type="button" className="btn-danger" disabled={conversation.id === id && busy} onClick={() => {
              void onDeleteHistory(conversation.id).then(() => {
                setConfirmDeleteId('');
                setHistory(items => items.filter(item => item.id !== conversation.id));
                if (conversation.id === id) update([]);
              }).catch(error => setMessage(String(error)));
            }}>确认删除</button>
            <button type="button" className="btn-secondary" onClick={() => setConfirmDeleteId('')}>取消</button>
          </div> : <button type="button" className="chat-history-delete" aria-label={`删除 ${title}`} title="删除对话" disabled={conversation.id === id && busy}
            onClick={() => setConfirmDeleteId(conversation.id)}><Delete16Regular /></button>}
        </li>;
      }) : <li className="chat-history-empty">暂无对话历史</li>}
    </ul>}
    <div className="chat-messages" ref={log} role="log" aria-label="对话消息" aria-live={busy ? 'off' : 'polite'}
      onScroll={event => {
        const element = event.currentTarget;
        followReply.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28;
      }}>
      {ready && !turns.length && <p className="chat-empty">输入 @ 添加打开的文档，输入 / 使用快捷命令。</p>}
      {turns.map((turn, index) => {
        const cited = citedMaterials(turn.text);
        const canRetry = index === turns.length - 1 && ['failed', 'stopped'].includes(turn.state);
        return <article className="chat-turn" key={turn.id}>
          <p className="chat-question">{turn.prompt}</p>
          {turn.materials.map(item => <details key={item.id}><summary>{item.name}</summary><p className="selection">{item.text}</p></details>)}
          <div className="chat-model">{turnProviderName(turn)} · {turn.model} {turn.state === 'stopped' && '· 已停止'}</div>
          {turn.text && <MarkdownRenderer source={turn.text} pending={turn.state === 'streaming'} referenceMarkers={cited.map(materialMarker).join(' ')} />}
          {cited.map((item, position) => <button type="button" className="chat-citation" key={item.id} onClick={() => { void onLocate(item).catch(error => setMessage(String(error))); }}>
            <span aria-hidden="true">[{position + 1}]</span> 定位原文 · {item.name}{item.page ? ' · 第 ' + item.page + ' 页' : item.line ? ' · 第 ' + item.line + ' 行' : ''}</button>)}
          {turn.usage && <p className="chat-model">输入 {turn.usage.input_tokens ?? '—'} · 输出 {turn.usage.output_tokens ?? '—'} tokens</p>}
          {turn.error && <p className="panel-error" role="alert">{turn.error}</p>}
          {(turn.text || canRetry) && <div className="chat-turn-actions">
            {turn.text && <button type="button" onClick={() => { void navigator.clipboard.writeText(turn.text).catch(error => setMessage(String(error))); }}><Copy16Regular />复制回复</button>}
            {canRetry && <button type="button" onClick={() => {
              void run({ ...turn, id: crypto.randomUUID(), text: '', error: undefined, usage: undefined, state: 'streaming' }, turnsRef.current.slice(0, -1));
            }}><ArrowClockwise16Regular />重试</button>}
          </div>}
        </article>;
      })}
    </div>
    <form className="chat-form" onSubmit={submit} onKeyDown={event => {
      if (event.key === 'Escape' && picker && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); setPicker(null); textarea.current?.focus();
      }
    }}>
      {picker && <div className="chat-picker" ref={choices} role="group" aria-label={{ materials: '资料选择', commands: '可用快捷命令', model: '模型选择' }[picker]}>
        {picker === 'materials' && (source ? <>
          <button type="button" className="chat-picker-back" onClick={() => setSource(null)} title={source.name}><ChevronLeft16Regular />{source.name}</button>
          <button type="button" disabled={adding} onClick={() => { void add(source, 'selection'); }}>加入选区</button>
          {source.kind === 'pdf'
            ? <button type="button" disabled={adding} onClick={() => { void add(source, 'page'); }}>加入当前页</button>
            : <button type="button" disabled={adding} onClick={() => { void add(source, 'document'); }}>加入全文</button>}
        </> : matchingDocuments.length ? matchingDocuments.map(item => <button type="button" key={item.id} onClick={() => {
          setSource(item); textarea.current?.focus();
        }} title={item.name}>{item.name}</button>) : <p>{documents.length ? '没有匹配的文档' : '请先打开文档'}</p>)}
        {picker === 'commands' && (matchingCommands.length ? matchingCommands.map(item =>
          <button type="button" key={item.name} onClick={() => chooseCommand(item)} title={item.instruction}>/{item.name}</button>)
          : <p>没有匹配的快捷命令</p>)}
        {picker === 'model' && <>
          <label className="field">模型服务<select aria-label="模型服务" value={provider} onChange={event => {
            const next = event.target.value as Provider;
            chosenModel.current = true; setProvider(next); setModel(preferences.models[next]);
            if (next === 'compatible') setApiProfileId(preferences.apiProfileId);
          }}>{providers.map(id => <option key={id} value={id}>{providerName[id]}</option>)}</select></label>
          {provider === 'compatible' && <label className="field">API 配置<select aria-label="API 配置" value={apiProfile?.id ?? ''} onChange={event => {
            chosenModel.current = true; setApiProfileId(event.target.value); setModel(''); setMessage('');
          }}>
            {!apiProfile && <option value="">选择已保存的配置</option>}
            {apiProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select></label>}
          {provider === 'chatgpt' ? <label className="field">对话模型<select aria-label="对话模型" disabled={!selectedGpt}
            value={selectedGpt?.slug ?? ''} onChange={event => { chosenModel.current = true; setModel(event.target.value); }}>
            {!selectedGpt && <option value="">{catalogError ? '暂无可用模型' : '正在读取模型…'}</option>}
            {catalog?.models.map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}
          </select></label> : <label className="field">对话模型<input value={model} disabled={provider === 'compatible' && !apiProfile}
            placeholder={provider === 'compatible' ? apiProfile?.model : undefined} maxLength={provider === 'compatible' ? 256 : 80} onChange={event => {
            chosenModel.current = true; setModel(event.target.value);
          }} /></label>}
          <button type="button" onClick={() => { setPicker(null); onSettings(provider); }}>配置模型服务</button>
        </>}
      </div>}
      {message && <p className="chat-notice" role="status">{message}</p>}
      {provider === 'chatgpt' && catalogError && !message && <p className="chat-notice" role="status">{catalogError}</p>}
      {provider === 'compatible' && apiError && !message && <p className="chat-notice" role="status">{apiError}</p>}
      {!!materials.length && <ul className="chat-materials">{materials.map(item => <li key={item.id}><details><summary>
        {item.name}{item.page ? ' · 第 ' + item.page + ' 页' : item.line ? ' · 第 ' + item.line + ' 行' : ''}
      </summary><p className="selection">{item.text}</p></details><button type="button" aria-label={`移除资料 ${item.name}`} title="移除资料"
        onClick={() => setMaterials(previous => previous.filter(material => material.id !== item.id))}><Dismiss16Regular /></button></li>)}</ul>}
      {command && <button type="button" className="chat-command-chip" title="移除快捷命令" onClick={() => setCommand(null)}>/{command.name}<Dismiss16Regular /></button>}
      <textarea ref={textarea} aria-label="对话输入" placeholder="输入消息…" value={draft} rows={3} maxLength={12000} onChange={event => editDraft(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if ((picker === 'materials' || picker === 'commands') && (event.key === 'ArrowDown' || (event.key === 'Enter' && !event.shiftKey))) {
            const first = choices.current?.querySelector<HTMLButtonElement>(source ? 'button:enabled:not(.chat-picker-back)' : 'button:enabled');
            if (first) {
              event.preventDefault();
              if (event.key === 'Enter') first.click(); else first.focus();
              return;
            }
          }
          if (event.key === 'Enter' && !event.shiftKey && (preferences.sendShortcut === 'enter' || event.ctrlKey || event.metaKey)) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className="chat-composer-actions">
        <button type="button" aria-label="添加资料" title="添加资料（@）" aria-expanded={picker === 'materials'} onClick={() => togglePicker('materials')}><Add16Regular /></button>
        <button type="button" aria-label="快捷命令" title="快捷命令（/）" aria-expanded={picker === 'commands'} onClick={() => togglePicker('commands')}>/</button>
        <button type="button" className="chat-model-select" aria-label="选择模型" aria-expanded={picker === 'model'} title={`${provider === 'compatible' ? apiProfile?.name ?? providerName[provider] : providerName[provider]} · ${displayedModel ?? ''}`}
          onClick={() => togglePicker('model')}><span>{displayedModel || '选择模型'}</span><ChevronDown16Regular /></button>
        {busy ? <button className="chat-send btn-secondary" type="button" onClick={() => { void cancel(); }}>停止生成</button>
          : <button type="submit" className="chat-send primary" title={preferences.sendShortcut === 'enter' ? 'Enter 发送' : 'Ctrl + Enter 发送'}
            disabled={!ready || clearing || adding || !canSend || (provider === 'chatgpt' && !selectedGpt) || (provider === 'compatible' && !apiModel)}>发送</button>}
      </div>
      {provider === 'compatible' && <div className="chatgpt-plan">
        <span>{apiProfile ? `API · ${apiProfile.name}` : 'OpenAI 兼容 API'}</span>
        {!apiProfile && <button type="button" onClick={() => onSettings(provider)}>打开 AI设置</button>}
      </div>}
      {provider === 'chatgpt' && <div className="chatgpt-plan">
        <span>{selectedGpt ? '正在使用 ChatGPT 订阅' : 'ChatGPT 订阅'}</span>
        {selectedGpt ? <button type="button" onClick={() => { void openChatGptUsage().catch(error => setMessage(String(error))); }}>管理 ChatGPT 用量</button>
          : <button type="button" onClick={() => onSettings(provider)}>打开 AI设置</button>}
      </div>}
    </form>
  </div>;
}
