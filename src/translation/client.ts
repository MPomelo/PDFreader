import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
export type Profile = { id: string; name: string; provider: 'deepseek' | 'mimo' | 'custom'; baseUrl: string; model: string; auth: 'bearer' | 'api-key' | 'none' };
export type ApiConfig = { version: number; activeId: string; profiles: Profile[]; targetLanguage: string; prompt: string; glossary: string; timeoutSeconds: number; maxTokens: number; streaming?: boolean; answerStyle?: 'concise' | 'detailed' };
export type SecretStatus = { available: boolean; mode: 'missing' | 'credential' | 'session' | 'unavailable' };
export type ApiKind = 'translate' | 'test' | 'math-test' | 'models';
export const TRANSLATION_CAPABILITIES = Object.freeze({ selection: true, fullDocument: false, ocr: false });
export const MATH_TEST_TEXT = String.raw`The loss is $L=\frac{1}{N}\sum_{i=1}^{N}(y_i-\hat{y}_i)^2$, where $N$ is the sample count.`;
export type ApiRequest = { requestId: string; documentId: string; profileId: string; kind: ApiKind; text: string };
export type ApiResult = { requestId: string; documentId: string; text: string; model: string; elapsedMs: number; usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null; models: string[]; reasoning?: string };
export type StreamUpdate = { requestId: string; documentId: string; seq: number; content: string; reasoning: string };
export const api = {
  desktop: isTauri,
  load: () => invoke<ApiConfig>('api_load'),
  save: (config: ApiConfig) => invoke<void>('api_save', { config }),
  status: (profileId: string) => invoke<SecretStatus>('api_secret_status', { profileId }),
  saveKey: (profileId: string, key: string, sessionOnly: boolean) => invoke<SecretStatus>('api_secret_save', { profileId, key, sessionOnly }),
  deleteKey: (profileId: string) => invoke<SecretStatus>('api_secret_delete', { profileId }),
  request: (request: ApiRequest) => invoke<ApiResult>('api_request', { request }),
  stream: async (request: ApiRequest, onChunk: (update: StreamUpdate) => void) => {
    const onChunkChannel = new Channel<StreamUpdate>(onChunk);
    try { return await invoke<ApiResult>('api_stream_request', { request, onChunk: onChunkChannel }); }
    finally { onChunkChannel.onmessage = () => {}; }
  },
  cancel: (requestId: string) => invoke<void>('api_cancel', { requestId }),
};
export class StreamAccumulator {
  text = ''; reasoning = ''; private seq = 0;
  push(update: StreamUpdate) {
    if (!Number.isSafeInteger(update.seq) || update.seq < 1 || typeof update.content !== 'string' || typeof update.reasoning !== 'string') throw Error('流式事件格式无效，当前内容未完成。');
    if (update.seq <= this.seq) return false;
    if (update.seq !== this.seq + 1) throw Error('流式事件顺序缺失，当前内容未完成，请重试。');
    this.seq = update.seq; this.text += update.content; this.reasoning += update.reasoning;
    return true;
  }
}
export function selectionIdentity(text: string, rectangles: readonly unknown[], anchor?: string) {
  return text ? JSON.stringify([text, anchor || rectangles]) : '';
}
// Invalidation also rejects already-completed replies that race with cancel.
// Used for selection, settings, new documents, repeated requests and unmounts.
export class RequestGate {
  private generation = 0;
  private current = '';
  private cancelRequest: (id: string) => Promise<void>;
  constructor(cancelRequest: (id: string) => Promise<void>) { this.cancelRequest = cancelRequest; }
  invalidate() {
    ++this.generation;
    if (this.current) void this.cancelRequest(this.current).catch(() => {});
    this.current = '';
  }
  begin(id: string) { this.invalidate(); this.current = id; return this.generation; }
  accepts(generation: number, id: string) { return this.generation === generation && this.current === id; }
  finish(generation: number, id: string) { if (this.accepts(generation, id)) this.current = ''; }
}
