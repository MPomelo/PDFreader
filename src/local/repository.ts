import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ApiConfig, ApiResult, Profile } from '../translation/client';
export type Layout = { left: boolean; right: boolean; reading: boolean; floating: boolean; leftWidth: number; rightWidth: number; theme: 'light' | 'dark' };
export type Recent = { fingerprint: string; name: string; path: string; page: number; zoom: string; time: string };
export type ReaderPreferences = { restoreProgress: boolean; defaultZoom: string; selectionPopup: boolean; showMetadata: boolean; showOriginal: boolean };
export const DEFAULT_READER_PREFERENCES: ReaderPreferences = { restoreProgress: true, defaultZoom: 'auto', selectionPopup: true, showMetadata: false, showOriginal: false };
export type Book = { version: 1; layout: Layout; recents: Recent[]; preferences?: ReaderPreferences };
export type Note = { id: string; fingerprint: string; name: string; page: number; original: string; originalRaw: string; markdown: string; model: string; service: string; domain: string; language: string; time: string };
type Notebook = { version: 1; notes: Note[] };
type Cache = { version: 1; entries: { key: string; response: ApiResult; time: string }[] };
type RecordData = Book | Notebook | Cache;
type Kind = 'state' | 'notes' | 'cache';
export type Envelope = { version: number; revision: number; data: unknown };
export type Backend = { read(kind: Kind, document: string): Promise<Envelope>; write(kind: Kind, document: string, revision: number, data: unknown): Promise<Envelope>; recover(kind: Kind, document: string): Promise<string> };
export const defaultLayout = (): Layout => {
  let widths; try { widths = JSON.parse(localStorage.getItem('pdfreader.panel-widths.v1') || 'null'); } catch { /* optional old preference */ }
  return { left: false, right: false, reading: false, floating: false, leftWidth: Math.max(160, Math.min(400, widths?.left || 220)), rightWidth: Math.max(280, Math.min(720, widths?.right || 340)), theme: 'light' };
};
function empty(kind: Kind): RecordData { return kind === 'state' ? { version: 1, layout: defaultLayout(), recents: [] } : kind === 'notes' ? { version: 1, notes: [] } : { version: 1, entries: [] }; }
const hashPattern = /^[a-f0-9]{64}$/;
const text = (value: unknown, max = 200000) => typeof value === 'string' && value.length <= max;
export function validate(kind: Kind, value: unknown): RecordData {
  const data = value as any;
  if (!data || data.version !== 1) throw Error('本地数据版本或结构无效，未覆盖原文件');
  if (kind === 'state') {
    const layout = data.layout;
    if (data.preferences != null && (!['restoreProgress','selectionPopup','showMetadata','showOriginal'].every(k => typeof data.preferences[k] === 'boolean') || !['auto','page-width','page-fit','1','1.25','1.5','2'].includes(data.preferences.defaultZoom))) throw Error('阅读设置数据无效，未覆盖原文件');
    if (!layout || !['light','dark'].includes(layout.theme) || !['left','right','reading','floating'].every(k => typeof layout[k] === 'boolean') || !Number.isFinite(layout.leftWidth) || layout.leftWidth < 160 || layout.leftWidth > 400 || !Number.isFinite(layout.rightWidth) || layout.rightWidth < 280 || layout.rightWidth > 720 || !Array.isArray(data.recents) || data.recents.length > 20 || !data.recents.every((r: Recent) => r && hashPattern.test(r.fingerprint) && text(r.name, 1000) && text(r.path, 32768) && Number.isSafeInteger(r.page) && r.page > 0 && text(r.zoom, 40) && text(r.time, 50))) throw Error('阅读进度数据损坏，未覆盖原文件');
  } else if (kind === 'notes') {
    if (!Array.isArray(data.notes) || data.notes.length > 500 || !data.notes.every((n: Note) => n && hashPattern.test(n.fingerprint) && ['id','name','original','originalRaw','markdown','model','service','domain','language','time'].every(k => text((n as any)[k])) && Number.isSafeInteger(n.page) && n.page > 0)) throw Error('笔记数据损坏，未覆盖原文件');
  } else if (!Array.isArray(data.entries) || data.entries.length > 40 || !data.entries.every((e: Cache['entries'][0]) => e && hashPattern.test(e.key) && text(e.time,50) && e.response && text(e.response.text) && e.response.text.trim() && text(e.response.model,256) && text(e.response.requestId,512) && text(e.response.documentId,512) && Number.isFinite(e.response.elapsedMs) && e.response.elapsedMs >= 0 && Array.isArray(e.response.models) && (e.response.reasoning == null || text(e.response.reasoning)))) throw Error('译文缓存损坏，未覆盖原文件');
  return data;
}
const browserKey = (kind: Kind, document: string) => `pdfreader.local-v1.${kind}.${document}`;
const backend: Backend = {
  read: async (kind, document) => {
    if (isTauri()) return invoke('local_read', { kind, document });
    const raw = localStorage.getItem(browserKey(kind, document)); return raw ? JSON.parse(raw) : { version: 1, revision: 0, data: null };
  },
  write: async (kind, document, revision, data) => {
    if (isTauri()) return invoke('local_write', { kind, document, revision, data });
    const current = await backend.read(kind, document); if (current.revision !== revision) throw Error('另一窗口更新了本地数据，请重新载入');
    const record = { version: 1, revision: revision + 1, data }; localStorage.setItem(browserKey(kind, document), JSON.stringify(record)); return record;
  },
  recover: async (kind, document) => {
    if (isTauri()) return invoke('local_recover', { kind, document });
    const key = browserKey(kind, document), raw = localStorage.getItem(key);
    if (raw) { localStorage.setItem(key + '.' + Date.now() + '.backup', raw); localStorage.removeItem(key); }
    return '原数据已备份，可重新载入';
  },
};
export type Problem = { kind: Kind; document: string; message: string };
export type Snapshot = { ready: boolean; book: Book; notes: Note[]; problems: Problem[] };
export class LocalRepository {
  private records = new Map<string, Envelope>();
  private queues = new Map<string, Promise<unknown>>();
  private listeners = new Set<() => void>();
  snapshot: Snapshot = { ready: false, book: empty('state') as Book, notes: [], problems: [] };
  constructor(private storage: Backend = backend) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.snapshot = { ...this.snapshot }; for (const listener of this.listeners) listener(); }
  private remember(id: string, record: Envelope) {
    this.records.delete(id); this.records.set(id, record);
    const caches = [...this.records.keys()].filter(key => key.startsWith('cache'));
    for (const old of caches.slice(0, Math.max(0, caches.length - 8))) this.records.delete(old);
  }
  private problem(kind: Kind, document: string, error: unknown) {
    this.snapshot.problems = [...this.snapshot.problems.filter(p => p.kind !== kind || p.document !== document), { kind, document, message: String(error) }]; this.publish();
  }
  private async read(kind: Kind, document = '') {
    const id = kind + document;
    if (this.snapshot.problems.some(p => p.kind === kind && p.document === document)) throw Error('本地文件尚未恢复；不会覆盖原数据');
    if (!this.records.has(id)) {
      try {
        const record = await this.storage.read(kind, document);
        if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 0 || record.data == null && record.revision !== 0) throw Error('本地文件格式不支持，未覆盖原文件');
        this.remember(id, { ...record, data: record.data == null ? empty(kind) : validate(kind, record.data) });
      } catch (error) { this.problem(kind, document, error); throw error; }
    }
    return this.records.get(id)!;
  }
  private update(kind: Kind, document: string, mutate: (data: any) => RecordData) {
    const id = kind + document;
    const task = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const current = await this.read(kind, document); const next = validate(kind, mutate(structuredClone(current.data)));
      if (new TextEncoder().encode(JSON.stringify(next)).length > 1900000) throw Error('本地数据达到容量上限，请先导出并整理；已有数据未删除');
      try { const saved = await this.storage.write(kind, document, current.revision, next); this.remember(id, saved);
        if (kind === 'state') this.snapshot.book = next as Book;
        if (kind === 'notes') this.snapshot.notes = (next as Notebook).notes;
        this.publish();
      } catch (error) { this.problem(kind, document, error); throw error; }
    });
    this.queues.set(id, task); return task;
  }
  async init() {
    await Promise.all(['state','notes'].map(async kind => { try { const record = await this.read(kind as Kind); if (kind === 'state') this.snapshot.book = record.data as Book; else this.snapshot.notes = (record.data as Notebook).notes; } catch { /* displayed, never auto-overwritten */ } }));
    this.snapshot.ready = true; this.publish(); return this.snapshot;
  }
  saveLayout(layout: Layout) { return this.update('state', '', (book: Book) => ({ ...book, layout })); }
  savePreferences(preferences: ReaderPreferences) { return this.update('state', '', (book: Book) => ({ ...book, preferences })); }
  progress(recent: Recent) { return this.update('state', '', (book: Book) => ({ ...book, recents: [recent, ...book.recents.filter(r => r.fingerprint !== recent.fingerprint && (!recent.path || r.path !== recent.path))].slice(0,20) })); }
  removeRecent(fingerprint: string) { return this.update('state', '', (book: Book) => ({ ...book, recents: book.recents.filter(r => r.fingerprint !== fingerprint) })); }
  async cached(document: string, key: string): Promise<ApiResult | null> { const cache = (await this.read('cache', document)).data as Cache; return cache.entries.find(e => e.key === key)?.response || null; }
  cache(document: string, key: string, response: ApiResult) {
    return this.update('cache', document, (cache: Cache) => {
      const entry = { key, response: { ...response, reasoning: '' }, time: new Date().toISOString() };
      const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (size([entry]) > 750 * 1024) return cache; // Oversized answers must not evict all existing entries.
      const entries = [entry, ...cache.entries.filter(e => e.key !== key)].slice(0,40);
      while (size(entries) > 750 * 1024 && entries.length) entries.pop();
      return { version: 1, entries };
    });
  }
  clearCache(document: string) { return this.update('cache', document, () => ({ version: 1, entries: [] })); }
  saveNote(note: Note) { return this.update('notes', '', (book: Notebook) => {
    if (book.notes.some(n => n.fingerprint === note.fingerprint && n.original === note.original && n.markdown === note.markdown && n.model === note.model && n.service === note.service && n.domain === note.domain && n.language === note.language)) return book;
    if (book.notes.length >= 500) throw Error('已达 500 条笔记上限，请先导出并整理');
    return { version: 1, notes: [note, ...book.notes] };
  }); }
  deleteNote(id: string) { return this.update('notes', '', (book: Notebook) => ({ version: 1, notes: book.notes.filter(n => n.id !== id) })); }
  async recover(problem: Problem) {
    await this.flush();
    const message = await this.storage.recover(problem.kind, problem.document); this.records.delete(problem.kind + problem.document);
    this.snapshot.problems = this.snapshot.problems.filter(p => p !== problem); await this.init(); return message;
  }
  async reload() { await Promise.allSettled(this.queues.values()); this.records.clear(); this.snapshot.problems = []; return this.init(); }
  async flush() { await Promise.allSettled(this.queues.values()); }
}
export async function digest(text: string | Uint8Array) {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))).map(b => b.toString(16).padStart(2,'0')).join('');
}
export async function cacheKey(document: string, source: string, rectangles: unknown[], config: ApiConfig, profile: Profile, anchor = '') {
  const location = anchor || rectangles.map(rect => rect && typeof rect === 'object' ? Object.fromEntries(Object.entries(rect).map(([key,value]) => [key, typeof value === 'number' ? Math.round(value * 100000) / 100000 : value])) : rect);
  return digest(JSON.stringify(['translation-format-v1', document, source, location, profile.id, profile.provider, profile.baseUrl.trim().replace(/\/+$/, ''), profile.auth, profile.model, config.targetLanguage, config.prompt, config.glossary, config.answerStyle || 'concise', config.maxTokens, config.streaming !== false]));
}
export function notesMarkdown(notes: Note[]) {
  return '# PDFreader 翻译笔记\n\n' + notes.map(note => {
    const fence = '`'.repeat(Math.max(3, ...Array.from(note.originalRaw.matchAll(/`+/g), m => m[0].length + 1)));
    return `## ${note.name.replace(/[\r\n]/g,' ')} · 第 ${note.page} 页\n\n- 时间：${note.time}\n- 服务 / 模型：${note.service} / ${note.model}\n- 语言：${note.language}\n- 领域：${note.domain.replace(/[\r\n]/g,' ')}\n- 文档：${note.fingerprint}\n\n### 原文\n\n${fence}text\n${note.originalRaw}\n${fence}\n\n### 译文\n\n${note.markdown}\n`;
  }).join('\n---\n\n');
}
export const repository = new LocalRepository();
export async function exportNotes(notes: Note[]) {
  const markdown = notesMarkdown(notes);
  if (isTauri()) return invoke<string | null>('export_notes', { markdown });
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'PDFreader-翻译笔记.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return 'PDFreader-翻译笔记.md';
}
