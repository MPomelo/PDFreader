import { invoke } from '@tauri-apps/api/core';
import type { SecretStatus } from '../translation/client';

export type ApiProfile = { id: string; name: string; baseUrl: string; model: string; auth: 'bearer' | 'api-key' | 'none'; streaming: boolean };
export type SavedApiProfile = ApiProfile & { route: string };
export const CHAT_API_PROFILES_CHANGED = 'pdfreader-chat-api-profiles-changed';

export const chatApi = {
  list: () => invoke<SavedApiProfile[]>('chat_api_profiles'),
  save: (profile: ApiProfile, expectedRoute?: string) =>
    invoke<{ profile: SavedApiProfile; warning: string | null }>('chat_api_save_profile', { profile, expectedRoute }),
  remove: ({ id, route }: SavedApiProfile) => invoke<string | null>('chat_api_delete_profile', { id, route }),
  status: ({ id, route }: SavedApiProfile) => invoke<SecretStatus>('chat_api_secret_status', { id, route }),
  saveKey: ({ id, route }: SavedApiProfile, key: string, sessionOnly: boolean) =>
    invoke<SecretStatus>('chat_api_secret_save', { id, route, key, sessionOnly }),
  removeKey: ({ id, route }: SavedApiProfile) => invoke<SecretStatus>('chat_api_secret_delete', { id, route }),
  models: ({ id, route }: SavedApiProfile) => invoke<string[]>('chat_api_models', { id, route }),
};

export const apiPresets: (Pick<ApiProfile, 'name' | 'baseUrl'> & { auth?: ApiProfile['auth'] })[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { name: '通义千问（北京）', baseUrl: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
  { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', auth: 'api-key' },
  { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: '自定义', baseUrl: '' },
];
export function newApiProfile(index: number): ApiProfile {
  const { name, baseUrl, auth = 'bearer' } = apiPresets[index];
  return { id: crypto.randomUUID(), name, baseUrl, model: '', auth, streaming: true };
}
