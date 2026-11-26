import { invoke } from '@tauri-apps/api/core';

export const CHATGPT_SESSION_CHANGED = 'pdfreader-chatgpt-session-changed';
export type ChatGptAccount = { id: string; email: string | null; connected: boolean; planEnabled: boolean };
export type ChatGptStatus = { activeId: string | null; accounts: ChatGptAccount[]; signingIn: boolean };
export type ChatGptCatalog = { accountId: string; models: { slug: string; name: string }[] };
export type ChatGptSignIn = { status: ChatGptStatus; firstPlanUse: boolean };
export type ChatGptSignOut = { status: ChatGptStatus; revoked: boolean };

export const readChatGptStatus = () => invoke<ChatGptStatus>('chatgpt_status');
export const readChatGptModels = (accountId: string) => invoke<ChatGptCatalog>('chatgpt_models', { accountId });
export const openChatGptUsage = () => invoke('chatgpt_open_usage');
export const activeAccount = (status: ChatGptStatus | null) => status?.accounts.find(account => account.id === status.activeId);
export const selectChatGptModel = (catalog: ChatGptCatalog | null, slug: string) =>
  catalog?.models.find(item => item.slug === slug) ?? catalog?.models[0];
