import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { repository } from '../local/repository';
import { MarkdownRenderer } from '../translation/MarkdownRenderer';
import { CHAT_PREFERENCES_CHANGED } from './ChatSettings';
import { chatMessages, conversationName, defaultChat, materialMarker, providerName, type Conversation, type Material, type Provider, type Turn } from './model';
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
    return `## 问题\n\n${turn.prompt}\n\n${sources}\n\n## ${providerName[turn.provider]} · ${turn.model}\n\n${turn.text}`;
  }).join('\n\n---\n\n');
}

export function ChatPane({ id, incoming, onReceive, onTemporary, documents, getMaterial, onLocate, onOpenHistory, onDeleteHistory, clearRevision, stopRegistration }: {
  id: string; incoming?: Material[]; onReceive: () => void; onTemporary: (temporary: boolean) => void;
  documents: DocumentChoice[]; getMaterial: (id: string, mode: 'selection' | 'page') => Promise<Material>;
  onLocate: (material: Material) => Promise<void>; onOpenHistory: (conversation: Conversation) => void;
  onDeleteHistory: (id: string) => Promise<void>; clearRevision: number; stopRegistration: (id: string, stop: (() => Promise<void>) | null) => void;
}) {
  const [preferences, setPreferences] = useState(defaultChat().preferences);
  const [provider, setProvider] = useState<Provider>('openai');
  const [model, setModel] = useState(preferences.models.openai);
  const [draft, setDraft] = useState('');
  const [materials, setMaterials] = useState<Material[]>([]);
  const [source, setSource] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef<Turn[]>([]);
  const pending = useRef('');
  const clearedAt = useRef(clearRevision);
  const alive = useRef(true);
  const [temporary, setTemporary] = useState(false), temp = useRef(false);
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<Conversation[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [ready, setReady] = useState(false);
  const [clearing, setClearing] = useState(false);
  const requestedSource = documents.find(tab => tab.id === source) ?? documents[0];
  const busy = turns.at(-1)?.state === 'streaming';
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
  useEffect(() => {
    alive.current = true;
    stopRegistration(id, () => stop.current());
    void repository.chat().then(data => {
      if (!alive.current) return;
      const initial = data.conversations.find(item => item.id === id);
      const restored = (initial?.turns ?? []).map(turn => turn.state === 'streaming' ? { ...turn, state: 'stopped' as const } : turn);
      update(restored);
      const defaultProvider = restored.at(-1)?.provider ?? data.preferences.provider;
      setPreferences(data.preferences); setProvider(defaultProvider);
      setModel(restored.at(-1)?.model || data.preferences.models[defaultProvider]);
    }).catch(error => setMessage(String(error))).finally(() => { if (alive.current) setReady(true); });
    const refresh = () => { void repository.chat().then(data => setPreferences(data.preferences)).catch(() => {}); };
    window.addEventListener(CHAT_PREFERENCES_CHANGED, refresh);
    return () => {
      alive.current = false;
      stopRegistration(id, null);
      window.removeEventListener(CHAT_PREFERENCES_CHANGED, refresh);
      void stop.current();
    };
  }, [id]);
  useEffect(() => {
    if (clearedAt.current === clearRevision) return;
    clearedAt.current = clearRevision;
    update([]); setHistory([]); setMaterials([]); setDraft('');
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
      const result = await invoke<Result>('chat_request', { request: { requestId, sessionId: id, provider: turn.provider, model: turn.model, prompt: preferences.prompt, messages }, onChunk });
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
    if (!draft.trim() || pending.current) return;
    void run({ id: crypto.randomUUID(), prompt: draft.trim(), materials: [...materials], provider, model, text: '', state: 'streaming' }, turnsRef.current);
    if (pending.current) { setDraft(''); setMaterials([]); }
  }
  async function add(mode: 'selection' | 'page') {
    if (!requestedSource) return;
    try {
      const material = await getMaterial(requestedSource.id, mode);
      setMaterials(previous => [...previous, material]);
      setMessage('');
    } catch (error) { setMessage(String(error)); }
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
    try { setHistory((await repository.chat()).conversations); setShowHistory(!showHistory); }
    catch (error) { setMessage(String(error)); }
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
    <div className="workspace-feature-header">
      <label>服务 <select value={provider} onChange={event => {
        const next = event.target.value as Provider;
        setProvider(next); setModel(preferences.models[next]);
      }}>{Object.entries(providerName).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label>模型 <input aria-label="对话模型" value={model} maxLength={80} onChange={event => setModel(event.target.value)} /></label>
      <button onClick={() => { void list(); }}>对话历史</button>
      <button disabled={!turns.length} onClick={() => { void exportMarkdown(); }}>导出 Markdown</button>
      <label><input type="checkbox" checked={temporary} disabled={busy || clearing || !ready} onChange={event => { void toggleTemporary(event.target.checked); }} />临时会话</label>
    </div>
    {showHistory && <ul className="chat-history">
      {history.length ? history.map(conversation => <li key={conversation.id}>
        <button onClick={() => { onOpenHistory(conversation); setShowHistory(false); }}>{conversationName(conversation)}</button>
        <button disabled={conversation.id === id && busy} onClick={() => {
          void onDeleteHistory(conversation.id).then(() => {
            setHistory(items => items.filter(item => item.id !== conversation.id));
            if (conversation.id === id) update([]);
          }).catch(error => setMessage(String(error)));
        }}>删除 {conversationName(conversation)}</button>
      </li>) : <li>暂无对话历史</li>}
    </ul>}
    <div className="chat-messages" role="log" aria-label="对话消息" aria-live={busy ? 'off' : 'polite'}>
      {turns.map((turn, index) => <article className="chat-turn" key={turn.id}>
        <p className="chat-question">{turn.prompt}</p>
        {turn.materials.map(item => <details key={item.id}><summary>{item.name}</summary><p className="selection">{item.text}</p></details>)}
        <div className="chat-model">{providerName[turn.provider]} · {turn.model} {turn.state === 'stopped' && '· 已停止'}</div>
        {turn.text && <MarkdownRenderer source={turn.text} />}
        {citedMaterials(turn.text).map(item => <button key={item.id} onClick={() => { void onLocate(item).catch(error => setMessage(String(error))); }}>定位原文 · {item.name}{item.page ? ' · 第 ' + item.page + ' 页' : item.line ? ' · 第 ' + item.line + ' 行' : ''}</button>)}
        {turn.usage && <p className="chat-model">输入 {turn.usage.input_tokens ?? '—'} · 输出 {turn.usage.output_tokens ?? '—'} tokens</p>}
        {turn.error && <p role="alert">{turn.error}</p>}
        {turn.text && <button onClick={() => { void navigator.clipboard.writeText(turn.text).catch(error => setMessage(String(error))); }}>复制回复</button>}
        {index === turns.length - 1 && ['failed', 'stopped'].includes(turn.state) && <button onClick={() => {
          void run({ ...turn, id: crypto.randomUUID(), text: '', error: undefined, usage: undefined, state: 'streaming' }, turnsRef.current.slice(0, -1));
        }}>重试</button>}
      </article>)}
    </div>
    <form className="chat-form" onSubmit={submit}>
      <div className="workspace-feature-header">
        <label>材料来源 <select value={requestedSource?.id ?? ''} onChange={event => setSource(event.target.value)}>
          {!documents.length && <option value="">暂无打开的文档</option>}
          {documents.map(tab => <option key={tab.id} value={tab.id}>{tab.name}</option>)}
        </select></label>
        <button type="button" disabled={!requestedSource} onClick={() => { void add('selection'); }}>加入选区</button>
        <button type="button" disabled={requestedSource?.kind !== 'pdf'} onClick={() => { void add('page'); }}>加入当前页</button>
      </div>
      {!!materials.length && <ul className="chat-materials">{materials.map(item => <li key={item.id}><details><summary>
        {item.name}{item.page ? ' · 第 ' + item.page + ' 页' : item.line ? ' · 第 ' + item.line + ' 行' : ''}
      </summary><p className="selection">{item.text}</p></details><button type="button" onClick={() => setMaterials(previous => previous.filter(material => material.id !== item.id))}>移除</button></li>)}</ul>}
      {message && <p role="status">{message}</p>}
      <label className="field">发往 {providerName[provider]}<textarea aria-label="对话输入" value={draft} rows={3} maxLength={12000} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }} /></label>
      {busy ? <button type="button" onClick={() => { void cancel(); }}>停止生成</button>
        : <button type="submit" className="primary" disabled={!ready || clearing || !draft.trim()}>发送</button>}
    </form>
  </div>;
}
