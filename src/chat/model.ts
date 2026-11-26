export type Provider = 'openai' | 'anthropic' | 'ollama' | 'chatgpt';
export type MaterialMode = 'selection' | 'page' | 'document';
export type Material = { id: string; documentId: string; name: string; text: string; page?: number; line?: number; fingerprint?: string; position?: { x: number; y: number } };
export type Turn = {
  id: string; prompt: string; materials: Material[]; provider: Provider; model: string;
  text: string; state: 'streaming' | 'complete' | 'stopped' | 'failed';
  usage?: Record<string, number>; error?: string; instruction?: string; ollamaPort?: number; chatgptAccount?: string;
};
export type Conversation = { id: string; turns: Turn[]; updated: string };
export type ChatCommand = { name: string; instruction: string };
export type ChatPreferences = {
  provider: Provider; models: Record<Provider, string>; prompt: string;
  ollamaPort: number; sendShortcut: 'enter' | 'ctrl-enter'; commands: ChatCommand[];
};
export type ChatData = { version: 1; conversations: Conversation[]; preferences: ChatPreferences };
export const providerName: Record<Provider, string> = { chatgpt: 'ChatGPT 订阅', openai: 'OpenAI API', anthropic: 'Anthropic Claude', ollama: 'Ollama 本地' };
export const providers = Object.keys(providerName) as Provider[];
export const defaultChat = (): ChatData => ({ version: 1, conversations: [], preferences: {
  provider: 'openai', models: { openai: 'gpt-5-mini', anthropic: 'claude-sonnet-4-6', ollama: '', chatgpt: '' }, prompt: '',
  ollamaPort: 11434, sendShortcut: 'enter',
  commands: [
    { name: '总结', instruction: '总结问题提到的内容。若附有资料，概括其要点和结论。' },
    { name: '解释', instruction: '用中文逐步解释问题或资料中的概念，必要时给出例子。' },
    { name: '比较', instruction: '比较问题提到的对象或资料，列出共同点、区别和依据。' },
  ],
} });
export const materialMarker = (material: Material) => 'M' + material.id.replaceAll('-', '');
export const conversationName = (conversation: Conversation) => conversation.turns[0]?.prompt.trim().replace(/\s+/g, ' ').slice(0, 55) || 'AI 对话';
const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit;
export const validOllamaPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;
export function validCommands(commands: ChatCommand[]) {
  return Array.isArray(commands) && commands.length <= 20 && new Set(commands.map(command => command?.name)).size === commands.length
    && commands.every(command => command && text(command.name, 24) && /^[^\s/@]+$/u.test(command.name) &&
      text(command.instruction, 4000) && !!command.instruction.trim());
}

export function validateChat(value: unknown): ChatData {
  const data = value as ChatData;
  const stored = data?.preferences;
  const defaults = defaultChat().preferences;
  const preferences = {
    ...defaults, ...stored, models: { ...stored?.models,
      ollama: stored?.models?.ollama ?? defaults.models.ollama, chatgpt: stored?.models?.chatgpt ?? defaults.models.chatgpt,
    },
  };
  const validPreferences = stored && providers.includes(preferences.provider) &&
    providers.every(provider => text(preferences.models[provider], 256)) && text(preferences.prompt, 4000) &&
    validOllamaPort(preferences.ollamaPort) && ['enter', 'ctrl-enter'].includes(preferences.sendShortcut) && validCommands(preferences.commands);
  const validConversations = Array.isArray(data?.conversations) && data.conversations.length <= 100 &&
    data.conversations.every(item => item && text(item.id, 128) && text(item.updated, 50) && Array.isArray(item.turns) &&
      item.turns.length <= 100 && item.turns.every(turn => turn && text(turn.id, 128) && text(turn.prompt, 192000) &&
      text(turn.text, 2 * 1024 * 1024) && text(turn.model, 256) && providers.includes(turn.provider) &&
      (turn.instruction === undefined || text(turn.instruction, 4000)) &&
      (turn.ollamaPort === undefined || validOllamaPort(turn.ollamaPort)) &&
      (turn.chatgptAccount === undefined || text(turn.chatgptAccount, 256)) &&
      ['complete', 'streaming', 'stopped', 'failed'].includes(turn.state) && Array.isArray(turn.materials) &&
      turn.materials.length <= 32 && turn.materials.every(material => material && typeof material.id === 'string' && /^[a-f0-9-]{36}$/.test(material.id) &&
        text(material.documentId, 128) && (material.position === undefined || material.position &&
          [material.position.x, material.position.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) && text(material.text, 192000) && text(material.name, 1000) &&
        [material.page, material.line].every(position => position === undefined || Number.isSafeInteger(position) && position > 0))));
  if (data?.version !== 1 || !validPreferences || !validConversations) throw Error('对话历史数据损坏，原文件保留。');
  return { ...data, preferences };
}

export function chatMessages(turns: Turn[], turn: Turn) {
  function question(item: Turn) {
    const materials = item.materials.map(material => ({
      marker: '[[' + materialMarker(material) + ']]', excerpt: material.text,
    }));
    const prompt = item.instruction ? item.instruction + '\n\n' + item.prompt : item.prompt;
    return { role: 'user', text: prompt + (materials.length ? '\n\n参考材料：\n' + JSON.stringify(materials) : '') };
  }
  return [...turns.filter(item => item.state === 'complete').flatMap(item => [question(item), { role: 'assistant', text: item.text }]), question(turn)];
}
