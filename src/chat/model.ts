export type Provider = 'openai' | 'anthropic';
export type Material = { id: string; documentId: string; name: string; text: string; page?: number; line?: number; fingerprint?: string; position?: { x: number; y: number } };
export type Turn = {
  id: string; prompt: string; materials: Material[]; provider: Provider; model: string;
  text: string; state: 'streaming' | 'complete' | 'stopped' | 'failed';
  usage?: Record<string, number>; error?: string;
};
export type Conversation = { id: string; turns: Turn[]; updated: string };
export type ChatPreferences = { provider: Provider; models: Record<Provider, string>; prompt: string };
export type ChatData = { version: 1; conversations: Conversation[]; preferences: ChatPreferences };
export const providerName: Record<Provider, string> = { openai: 'OpenAI GPT', anthropic: 'Anthropic Claude' };
export const defaultChat = (): ChatData => ({ version: 1, conversations: [], preferences: {
  provider: 'openai', models: { openai: 'gpt-5-mini', anthropic: 'claude-sonnet-4-6' }, prompt: '',
} });
export const materialMarker = (material: Material) => 'M' + material.id.replaceAll('-', '');
export const conversationName = (conversation: Conversation) => conversation.turns[0]?.prompt.trim().replace(/\s+/g, ' ').slice(0, 55) || 'AI 对话';
const providers: Provider[] = ['openai', 'anthropic'];
const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit;

export function validateChat(value: unknown): ChatData {
  const data = value as ChatData;
  const validPreferences = data?.preferences && providers.includes(data.preferences.provider) &&
    providers.every(provider => text(data.preferences.models?.[provider], 256)) && text(data.preferences.prompt, 4000);
  const validConversations = Array.isArray(data?.conversations) && data.conversations.length <= 100 &&
    data.conversations.every(item => item && text(item.id, 128) && text(item.updated, 50) && Array.isArray(item.turns) &&
      item.turns.length <= 100 && item.turns.every(turn => turn && text(turn.id, 128) && text(turn.prompt, 192000) &&
      text(turn.text, 2 * 1024 * 1024) && text(turn.model, 256) && providers.includes(turn.provider) &&
      ['complete', 'streaming', 'stopped', 'failed'].includes(turn.state) && Array.isArray(turn.materials) &&
      turn.materials.length <= 32 && turn.materials.every(material => material && typeof material.id === 'string' && /^[a-f0-9-]{36}$/.test(material.id) &&
        text(material.documentId, 128) && (material.position === undefined || material.position &&
          [material.position.x, material.position.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) && text(material.text, 192000) && text(material.name, 1000) &&
        [material.page, material.line].every(position => position === undefined || Number.isSafeInteger(position) && position > 0))));
  if (data?.version !== 1 || !validPreferences || !validConversations) throw Error('对话历史数据损坏，原文件保留。');
  return data;
}

export function chatMessages(turns: Turn[], turn: Turn) {
  function question(item: Turn) {
    const materials = item.materials.map(material => ({
      marker: '[[' + materialMarker(material) + ']]', excerpt: material.text,
    }));
    return { role: 'user', text: item.prompt + (materials.length ? '\n\n参考材料：\n' + JSON.stringify(materials) : '') };
  }
  return [...turns.filter(item => item.state === 'complete').flatMap(item => [question(item), { role: 'assistant', text: item.text }]), question(turn)];
}
