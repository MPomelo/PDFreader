import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const pdfPath = 'C:/fixtures/paper.pdf';
const markdownPath = 'C:/fixtures/notes.md';
const textPath = 'C:/fixtures/notes.txt';
const pdf = (await readFile('docs/assets/research-notes.pdf')).toString('base64');
const server = await createServer({ cacheDir: 'node_modules/.vite/three-column', server: { port: 0 } });
await server.listen();
const browser = await chromium.launch(process.env.PDFREADER_CHROMIUM
  ? { executablePath: process.env.PDFREADER_CHROMIUM } : { channel: 'msedge' });

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 875 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ pdf, pdfPath, markdownPath, textPath }) => {
    if (window !== window.top) return;
    const callbacks = new Map();
    let lastCallback = 1;
    const files = {
      [markdownPath]: { name: 'notes.md', path: markdownPath, revision: '1', encoding: 'UTF-8', bom: false, content: '# Notes', assetsDir: 'notes.assets' },
      [textPath]: { name: 'notes.txt', path: textPath, revision: '1', encoding: 'UTF-8', bom: true, content: 'original\r\nsecond', assetsDir: 'notes.assets' },
    };
    window.qa = { open: [pdfPath], requests: [], cancels: [], writes: [], translations: [] };
    window.qa.chatgpt = { activeId: null, accounts: [], signingIn: false };
    window.qa.chatApiProfiles = [];
    const apiKeys = new Set();
    const routeError = '此 API 配置的地址或鉴权方式已变更。请确认后重新发送。';
    const apiProfile = (id, route) => {
      const profile = window.qa.chatApiProfiles.find(item => item.id === id && item.route === route);
      if (!profile) throw Error(routeError);
      return profile;
    };
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(fn) { const id = lastCallback++; callbacks.set(id, fn); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args) {
        switch (command) {
          case 'plugin:event|listen': return args.handler;
          case 'plugin:window|is_maximized': return false;
          case 'startup_pdfs': return { paths: [], errors: [] };
          case 'choose_documents': return window.qa.open;
          case 'reopen_workspace_document': return args.path;
          case 'read_pdf': return { name: 'paper.pdf', path: pdfPath, bytes: Array.from(atob(pdf), char => char.charCodeAt(0)) };
          case 'native_page_layout': return null;
          case 'read_text': return files[args.path];
          case 'local_read': return JSON.parse(localStorage.getItem('test-' + args.kind)) ?? { version: 1, revision: 0, data: null };
          case 'local_write': {
            const record = { version: 1, revision: args.revision + 1, data: args.data };
            localStorage.setItem('test-' + args.kind, JSON.stringify(record));
            return record;
          }
          case 'save_text': {
            const request = args.request;
            window.qa.writes.push(request);
            return { ...files[request.path], revision: '2', urls: [] };
          }
          case 'api_load': return { activeId: 'demo', profiles: [{ id: 'demo', model: 'mock', name: 'Mock', auth: 'none', baseUrl: 'http://127.0.0.1' }], streaming: true, targetLanguage: '中文', prompt: 'test' };
          case 'api_secret_status': return { mode: 'missing', available: false };
          case 'api_stream_request': return new Promise(resolve => {
            const { request, onChunk } = args;
            const send = callbacks.get(onChunk.id);
            const identity = { requestId: request.requestId, documentId: request.documentId };
            window.qa.translations.push({ ...request, finish: () => {
              send({ index: 1, end: true });
              resolve({ ...identity, text: 'Translated source', reasoning: '', model: 'mock', usage: null, elapsedMs: 30, models: [] });
            } });
            send({ index: 0, message: { ...identity, seq: 1, content: 'Translating source', reasoning: '' } });
          });
          case 'api_cancel': window.qa.cancels.push(args.requestId); return;
          case 'chat_secret_status': return { mode: 'missing', available: false };
          case 'chat_ollama_models': return args.port === 11435 ? ['qwen3:4b'] : [];
          case 'chat_api_profiles': return structuredClone(window.qa.chatApiProfiles);
          case 'chat_api_save_profile': {
            const before = args.expectedRoute ? apiProfile(args.profile.id, args.expectedRoute) : null;
            const { id, baseUrl, auth } = args.profile;
            const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([id, baseUrl, auth].join('\0')));
            const route = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
            const profile = { ...args.profile, route };
            if (before) {
              window.qa.chatApiProfiles = window.qa.chatApiProfiles.map(item => item.id === id ? profile : item);
              if (before.route !== route) apiKeys.delete(before.route);
            } else window.qa.chatApiProfiles.push(profile);
            return { profile, warning: null };
          }
          case 'chat_api_secret_status': {
            const { route } = apiProfile(args.id, args.route);
            return { mode: apiKeys.has(route) ? 'session' : 'missing', available: apiKeys.has(route) };
          }
          case 'chat_api_secret_save': {
            const { route } = apiProfile(args.id, args.route);
            if (args.key !== 'dummy-chat-api-key') throw Error('Expected the fixture key');
            apiKeys.add(route);
            return { mode: 'session', available: true };
          }
          case 'chat_api_models': {
            const profile = apiProfile(args.id, args.route);
            if (profile.auth !== 'none' && !apiKeys.has(profile.route)) throw Error('Missing fixture key');
            return ['fixture-chat', 'fixture-reasoning'];
          }
          case 'chatgpt_status': return structuredClone(window.qa.chatgpt);
          case 'chatgpt_sign_in': {
            const id = args.accountId ?? 'oaiapp_browser_test';
            window.qa.chatgpt = { activeId: id, signingIn: false, accounts: [{
              id, email: 'reader@example.test', connected: true, planEnabled: true,
            }] };
            return { status: structuredClone(window.qa.chatgpt), firstPlanUse: !args.accountId };
          }
          case 'chatgpt_models': {
            if (args.accountId !== window.qa.chatgpt.activeId || !window.qa.chatgpt.accounts[0]?.planEnabled) throw Error('Not authorized');
            return { accountId: args.accountId, models: [{ slug: 'gpt-test', name: 'GPT 测试' }, { slug: 'gpt-test-fast', name: 'GPT 快速测试' }] };
          }
          case 'chatgpt_open_usage': window.qa.openedUsage = true; return;
          case 'chatgpt_sign_out': {
            window.qa.chatgpt.accounts[0].connected = false;
            window.qa.chatgpt.accounts[0].planEnabled = false;
            return { status: structuredClone(window.qa.chatgpt), revoked: true };
          }
          case 'chat_request': {
            const { request, onChunk } = args;
            if (request.provider === 'compatible') {
              const profile = apiProfile(request.apiProfileId, request.apiProfileRoute);
              if (profile.auth !== 'none' && !apiKeys.has(profile.route)) throw Error('Missing fixture key');
              if (!profile.streaming) {
                window.qa.requests.push(request);
                return { model: request.model, text: 'Non-streaming answer', usage: { input_tokens: 4, output_tokens: 2 } };
              }
            }
            return new Promise(resolve => {
              const send = callbacks.get(onChunk.id);
              window.qa.requests.push({ ...request, finish: () => {
                send({ index: 2, message: { requestId: request.requestId, sessionId: request.sessionId, sequence: 3, text: 'late' } });
                send({ index: 3, end: true });
                resolve({ model: request.model, text: 'Answer ' + (request.messages.at(-1).text.match(/\[\[M[a-f0-9]+\]\]/)?.[0] ?? ''), usage: { input_tokens: 10, output_tokens: 2 } });
              } });
              send({ index: 0, message: { requestId: request.requestId, sessionId: 'different-session', sequence: 1, text: 'wrong session' } });
              send({ index: 1, message: { requestId: request.requestId, sessionId: request.sessionId, sequence: 2, text: 'Partial answer' } });
            });
          }
          default: throw Error('Unexpected IPC ' + command);
        }
      },
    };
  }, { pdf, pdfPath, markdownPath, textPath });

  await page.goto(server.resolvedUrls.local[0]);
  const button = (name, locator = page) => locator.getByRole('button', { name, exact: true });
  const openIn = async (column, path) => {
    await page.evaluate(path => { window.qa.open = [path]; }, path);
    await button(column ? column + '新建或打开文档' : '新建或打开文档').click();
    await button('打开文档', page.locator('.new-document-menu:popover-open')).click();
  };
  const expectAddMenuWithin = async column => {
    const pane = page.locator(`.workspace-column[data-column="${column}"]`);
    await pane.locator('.new-document > button').click();
    const menu = pane.locator('.new-document-menu');
    await expect(menu).toBeVisible();
    const bounds = await pane.boundingBox();
    const popup = await menu.boundingBox();
    assert.ok(popup.x >= bounds.x && popup.x + popup.width <= bounds.x + bounds.width);
    await expect.poll(() => menu.evaluate(element => [...element.querySelectorAll('button')].every(button => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  };
  const showColumn = async column => {
    await button('布局').click();
    await button(column).click();
  };
  const expectPdfTools = async () => {
    await button('PDF 工具').click();
    await expect(page.getByRole('combobox', { name: '缩放', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
  };
  const sizes = selectors => page.evaluate(selectors => selectors.map(selector => {
    const element = document.querySelector(selector);
    const { width, height } = element.getBoundingClientRect();
    const { fontSize, lineHeight, fontFamily } = getComputedStyle(element);
    return { width, height, fontSize, lineHeight, fontFamily };
  }), selectors);
  const changeTheme = async theme => {
    await button('设置').click();
    await page.getByLabel('界面主题', { exact: true }).selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await button('关闭设置').click();
  };
  const tab = name => page.getByRole('tab', { name, exact: true });
  const txt = page.getByRole('textbox', { name: 'TXT 编辑器' });
  await openIn('', pdfPath);
  const frame = page.frameLocator('iframe[title="PDF · paper.pdf"]');
  await expect(frame.locator('.textLayer span').first()).toBeVisible({ timeout: 45000 });
  await frame.locator('body').evaluate(() => { window.workspaceIdentity = 22; });
  await showColumn('下栏');
  await openIn('下栏', markdownPath);
  await showColumn('右栏');
  await expectAddMenuWithin('right');
  await openIn('右栏', textPath);
  await expect(txt).toBeVisible();
  await expectAddMenuWithin('right');
  await page.setViewportSize({ width: 720, height: 500 });
  const separator = page.getByRole('separator', { name: '调整右栏宽度' });
  await separator.press('Shift+ArrowRight');
  await separator.press('Shift+ArrowRight');
  await expectAddMenuWithin('right');
  await separator.dblclick();
  await page.setViewportSize({ width: 1200, height: 875 });
  await expect(tab('paper.pdf')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('notes.md')).toHaveAttribute('aria-selected', 'true');
  const geometry = ['.workspace-title-bar', '.window-command', '.workspace-column[data-column=upper] .document-toolbar',
    '.zoom-group select', '.page-control input', '.workspace-column[data-column=upper] .document-tab',
    '.workspace-column[data-column=lower] .column-tabs', '.workspace-column[data-column=right] .column-tabs',
    '.workspace-column[data-column=right] .document-tab', '.compact-document-actions button'];
  for (const viewport of [{ width: 1200, height: 875 }, { width: 980, height: 720 }]) {
    await page.setViewportSize(viewport);
    await changeTheme('light');
    const light = await sizes(geometry);
    await changeTheme('dark');
    assert.deepEqual(await sizes(geometry), light);
  }
  await page.setViewportSize({ width: 1200, height: 875 });
  await changeTheme('light');
  await txt.fill('kept unsaved');
  await button('右栏标签操作').click();
  await button('移到下栏').click();
  await expect(page.getByRole('tablist', { name: '下栏标签' }).getByRole('tab', { name: 'notes.txt' })).toBeVisible();
  await expect(txt).toHaveText('kept unsaved');
  await txt.press('Control+z');
  await expect(txt).toContainText('original');
  await txt.press('Control+y');
  await expect(txt).toHaveText('kept unsaved');
  await txt.press('Control+s');
  await expect.poll(() => page.evaluate(() => window.qa.writes.length)).toBe(1);
  assert.deepEqual(await page.evaluate(() => window.qa.writes.map(({ path, encoding, bom }) => ({ path, encoding, bom }))),
    [{ path: textPath, encoding: 'UTF-8', bom: true }]);
  await button('上栏标签操作').click();
  await button('移到右栏').click();
  assert.equal(await frame.locator('body').evaluate(() => window.workspaceIdentity), 22);
  await expect(tab('paper.pdf')).toHaveAttribute('aria-selected', 'true');
  await expectPdfTools();
  await page.keyboard.press('Shift+F6');
  await expect(page.locator('footer')).toContainText('UTF-8');

  await button('新建或打开文档').click();
  await button('新建译文').click();
  await button('译文来源 · 跟随右栏').click();
  await button('固定当前 PDF').click();
  await expect(button('译文来源 · 固定来源')).toBeVisible();
  await expect(page.locator('.workspace-column[data-column=upper] .document-toolbar')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '翻译面板' })).not.toContainText('paper.pdf');
  const selection = async index => {
    return frame.locator('.textLayer span[dir]').nth(index).evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    });
  };
  const selectedText = await selection(0);
  await button('翻译选区').click();
  await expect(page.getByRole('complementary', { name: '翻译面板' })).toContainText('Translating source');
  await selection(1);
  await tab('notes.txt').click();
  await button('下栏新建或打开文档').click();
  await button('新建译文').click();
  const conflict = page.getByRole('dialog', { name: '译文已在上栏打开' });
  await expect(conflict).toBeVisible();
  await expect(conflict.getByRole('heading')).toHaveCSS('font-size', '14px');
  await expect(button('取消', conflict)).toHaveCSS('font-size', '12px');
  await button('取消', conflict).click();
  await expect(tab('译文')).toHaveCount(1);
  await button('下栏新建或打开文档').click();
  await button('新建译文').click();
  await button('移到下栏', conflict).click();
  await expect(page.getByRole('tablist', { name: '下栏标签' }).getByRole('tab', { name: '译文' })).toBeVisible();
  await expect(button('译文来源 · 固定来源')).toBeVisible();
  await expect(page.getByRole('complementary', { name: '翻译面板' })).toContainText('Translating source');
  await page.evaluate(() => window.qa.translations[0].finish());
  await expect(page.getByRole('complementary', { name: '翻译面板' })).toContainText('Translated source');
  assert.equal((await page.evaluate(() => window.qa.translations[0].text)).trim(), selectedText.trim());
  const translationBody = page.getByRole('complementary', { name: '翻译面板' }).locator('.markdown-body');
  await expect(translationBody).toHaveCSS('font-size', '14px');
  await button('设置').click();
  await page.getByLabel('界面字号', { exact: true }).selectOption('16');
  await expect(button('关闭设置')).toHaveCSS('font-size', '16px');
  await expect.poll(() => frame.locator('html').evaluate(element => element.style.getPropertyValue('--ui-font-size'))).toBe('16px');
  await expect(translationBody).toHaveCSS('font-size', '14px');
  await page.getByLabel('译文字号', { exact: true }).selectOption('20');
  await expect(translationBody).toHaveCSS('font-size', '20px');
  await expect(button('关闭设置')).toHaveCSS('font-size', '16px');
  await button('关闭设置').click();
  await expect(tab('译文')).toHaveCSS('font-size', '15px');
  await button('关闭 译文').click();

  await button('新建或打开文档').click();
  await button('新建 AI 对话').click();
  const chat = page.getByRole('textbox', { name: '对话输入' });
  await button('选择模型').click();
  await button('配置模型服务').click();
  const chatSettings = page.getByRole('dialog', { name: '设置' });
  await page.getByLabel('发送快捷键', { exact: true }).selectOption('ctrl-enter');
  await button('模型服务').click();
  await page.getByLabel('配置服务', { exact: true }).selectOption('ollama');
  await expect(chatSettings.getByLabel('API 密钥', { exact: true })).toHaveCount(0);
  await page.getByLabel('本机端口', { exact: true }).fill('11435');
  await button('检测本地模型').click();
  await page.getByLabel('已下载的模型', { exact: true }).selectOption('qwen3:4b');
  await page.getByRole('checkbox', { name: '设为默认模型服务' }).check();
  await button('快捷命令', page.getByRole('navigation', { name: '对话设置分类' })).click();
  await button('添加命令').click();
  await page.getByLabel('命令名称', { exact: true }).last().fill('提炼');
  await page.getByLabel('命令提示词', { exact: true }).last().fill('提炼文章中的三项主张。');
  await button('保存对话设置').click();
  await expect(chatSettings.getByRole('status')).toContainText('已保存对话设置');
  await button('关闭设置').click();
  await expect(button('选择模型')).toContainText('qwen3:4b');
  const sources = page.getByRole('group', { name: '资料选择' });
  await button('添加资料').click();
  await button('notes.md', sources).click();
  await button('加入全文').click();
  await expect(page.locator('.chat-materials')).toContainText('notes.md');
  await button('移除资料 notes.md').click();
  await chat.fill('@pap');
  await button('paper.pdf', sources).click();
  await button('加入当前页').click();
  await expect(page.locator('.chat-materials')).toContainText('paper.pdf');
  await chat.fill('/提');
  await button('/提炼', page.getByRole('group', { name: '可用快捷命令' })).click();
  await chat.fill('What is this article about?');
  await chat.press('Enter');
  assert.equal(await page.evaluate(() => window.qa.requests.length), 0);
  await chat.press('Control+Enter');
  await expect(page.getByRole('log')).toContainText('Partial answer');
  await expect(page.getByRole('log')).not.toContainText('wrong session');
  await button('上栏标签操作').click();
  await button('移到下栏').click();
  await expect(page.getByRole('log')).toContainText('Partial answer');
  await button('停止生成').click();
  await expect(page.getByRole('log')).toContainText('已停止');
  await page.evaluate(() => window.qa.requests[0].finish());
  await expect(page.getByRole('log')).not.toContainText('late');
  await button('重试').click();
  await expect.poll(() => page.evaluate(() => window.qa.requests.length)).toBe(2);
  const requests = await page.evaluate(() => window.qa.requests.map(({ sessionId, requestId, messages, provider, model, ollamaPort }) =>
    ({ sessionId, requestId, messages, provider, model, ollamaPort })));
  assert.equal(requests[0].sessionId, requests[1].sessionId);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.deepEqual(requests[0].messages, requests[1].messages);
  assert.ok(requests.every(request => request.provider === 'ollama' && request.model === 'qwen3:4b' && request.ollamaPort === 11435));
  assert.match(requests[0].messages[0].text, /^提炼文章中的三项主张。/);
  assert.match(requests[0].messages[0].text, /\[\[M[a-f0-9]{32}\]\]/);
  assert.ok(!requests[0].messages[0].text.includes(pdfPath));
  await page.evaluate(() => window.qa.requests[1].finish());
  await expect(page.getByRole('log')).toContainText('Answer');
  await expect(page.getByRole('log').locator('.markdown-body')).toContainText('[1]');
  await expect(page.getByRole('log').locator('.markdown-body')).not.toContainText('[[M');
  await button('定位原文 · paper.pdf · 第 1 页').click();
  await expectPdfTools();

  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-state'))?.data.workspace?.resources.length)).toBe(4);
  await expect.poll(() => page.evaluate(() => {
    const workspace = JSON.parse(localStorage.getItem('test-state'))?.data.workspace;
    const savedChat = workspace?.resources.find(resource => resource.kind === 'chat');
    return !!savedChat && workspace.order.lower.includes(savedChat.id);
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-chat'))?.data.conversations[0]?.turns[0]?.state)).toBe('complete');
  await page.reload();
  await expect(page.getByRole('tablist', { name: '右栏标签' }).getByRole('tab', { name: 'paper.pdf' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: '下栏标签' }).getByRole('tab', { name: 'AI 对话' })).toBeVisible();
  await tab('AI 对话').click();
  await expect(page.getByRole('log')).toContainText('Answer');
  await button('设置').click();
  await expect(page.getByLabel('界面字号', { exact: true })).toHaveValue('16');
  await expect(page.getByLabel('译文字号', { exact: true })).toHaveValue('20');
  await button('关闭设置').click();
  await button('选择模型').click();
  await page.getByLabel('模型服务', { exact: true }).selectOption('chatgpt');
  await button('配置模型服务').click();
  await expect(chatSettings.getByLabel('配置服务', { exact: true })).toHaveValue('chatgpt');
  await expect(chatSettings.getByLabel('API 密钥', { exact: true })).toHaveCount(0);
  await button('使用 ChatGPT 登录', chatSettings).click();
  const welcome = page.getByRole('dialog', { name: 'ChatGPT 订阅已连接' });
  await expect(welcome).toBeVisible();
  await button('知道了', welcome).click();
  await expect(chatSettings.getByLabel('ChatGPT 账户', { exact: true })).toContainText('reader@example.test');
  await chatSettings.getByLabel('ChatGPT 模型', { exact: true }).selectOption('gpt-test-fast');
  await chatSettings.getByRole('checkbox', { name: '设为默认模型服务' }).check();
  await button('保存对话设置', chatSettings).click();
  await expect(chatSettings.getByText('已保存对话设置。', { exact: true })).toBeVisible();
  await button('关闭设置').click();
  await button('新对话').click();
  await expect(button('选择模型')).toContainText('GPT 快速测试');
  await expect(page.getByText('正在使用 ChatGPT 订阅', { exact: true }).filter({ visible: true })).toBeVisible();
  await button('管理 ChatGPT 用量').click();
  assert.equal(await page.evaluate(() => window.qa.openedUsage), true);
  await chat.fill('使用订阅回答');
  await button('发送').click();
  await expect(page.getByRole('log')).toContainText('Partial answer');
  const planRequest = await page.evaluate(() => {
    const { provider, model, chatgptAccount } = window.qa.requests[0];
    return { provider, model, chatgptAccount };
  });
  assert.deepEqual(planRequest, { provider: 'chatgpt', model: 'gpt-test-fast', chatgptAccount: 'oaiapp_browser_test' });
  await page.evaluate(() => window.qa.requests[0].finish());
  await expect(page.getByRole('log')).toContainText('Answer');
  await button('选择模型').click();
  await button('配置模型服务').click();
  await button('退出账户', chatSettings).click();
  await expect(button('使用 ChatGPT 登录', chatSettings)).toBeEnabled();
  await button('关闭设置').click();
  await expect(page.getByText('请在「AI设置」中登录 ChatGPT。', { exact: true }).filter({ visible: true })).toBeVisible();
  await chat.fill('退出后不得发送');
  await expect(button('发送')).toBeDisabled();

  await button('设置').click();
  await button('翻译配置', chatSettings).click();
  await expect(chatSettings.getByRole('heading', { name: '翻译配置' })).toBeVisible();
  await button('AI设置', chatSettings).click();
  await button('模型服务', chatSettings).click();
  await chatSettings.getByLabel('配置服务', { exact: true }).selectOption('compatible');
  const apiSettings = chatSettings.locator('.chat-api-settings');
  await button('添加 API 配置', apiSettings).click();
  await expect(apiSettings.getByLabel('API 地址', { exact: true })).toHaveValue('https://api.deepseek.com');
  await button('保存 API 配置', apiSettings).click();
  await apiSettings.getByLabel('API 密钥', { exact: true }).fill('dummy-chat-api-key');
  await apiSettings.getByRole('checkbox', { name: '仅本次会话' }).check();
  await button('保存密钥', apiSettings).click();
  await expect(apiSettings.getByLabel('API 密钥', { exact: true })).toHaveValue('');
  await button('读取模型列表', apiSettings).click();
  await expect(apiSettings.getByRole('status')).toContainText('已读取 2 个模型');
  await apiSettings.getByLabel('模型名称', { exact: true }).fill('fixture-chat');
  await button('保存 API 配置', apiSettings).click();
  await expect(apiSettings.getByRole('status')).toContainText('已保存 API 配置');
  await apiSettings.getByLabel('服务模板', { exact: true }).selectOption({ label: '自定义' });
  await button('添加 API 配置', apiSettings).click();
  await apiSettings.getByLabel('配置名称', { exact: true }).fill('本机兼容 API');
  await apiSettings.getByLabel('API 地址', { exact: true }).fill('http://127.0.0.1:4001/v1');
  await apiSettings.getByLabel('鉴权方式', { exact: true }).selectOption('none');
  await apiSettings.getByLabel('模型名称', { exact: true }).fill('fixture-local');
  await apiSettings.getByRole('checkbox', { name: '流式输出' }).uncheck();
  await button('保存 API 配置', apiSettings).click();
  await expect(apiSettings.getByRole('status')).toContainText('已保存 API 配置');
  await chatSettings.getByRole('checkbox', { name: '设为默认模型服务' }).check();
  await button('保存对话设置', chatSettings).click();
  await expect(chatSettings.getByText('已保存对话设置。', { exact: true })).toBeVisible();
  await button('关闭设置').click();
  await button('新对话').click();
  await expect(button('选择模型')).toContainText('fixture-chat');
  await chat.fill('兼容 API 问答');
  await button('发送').click();
  await expect(page.getByRole('log')).toContainText('Partial answer');
  const firstApi = await page.evaluate(() => {
    const request = window.qa.requests.at(-1);
    const profile = window.qa.chatApiProfiles.find(item => item.name === 'DeepSeek');
    return { exactProfile: request.apiProfileId === profile.id && request.apiProfileRoute === profile.route,
      provider: request.provider, model: request.model, request: JSON.stringify(request) };
  });
  assert.equal(firstApi.exactProfile, true);
  assert.equal(firstApi.provider, 'compatible');
  assert.equal(firstApi.model, 'fixture-chat');
  assert.ok(!firstApi.request.includes('dummy-chat-api-key') && !firstApi.request.includes('api.deepseek.com'));
  await button('停止生成').click();
  await button('选择模型').click();
  await button('配置模型服务').click();
  await apiSettings.getByLabel('API 地址', { exact: true }).fill('https://changed.example/v1');
  await button('保存 API 配置', apiSettings).click();
  await expect(apiSettings.getByRole('status')).toContainText('已保存 API 配置');
  await button('关闭设置').click();
  await button('重试').click();
  await expect(page.getByRole('log').getByRole('alert')).toContainText('地址或鉴权方式已变更');

  await button('选择模型').click();
  await page.getByLabel('API 配置', { exact: true }).selectOption({ label: '本机兼容 API' });
  await page.keyboard.press('Escape');
  await chat.fill('使用第二个 API 配置');
  await button('发送').click();
  await expect(page.getByRole('log')).toContainText('Non-streaming answer');
  await expect(page.getByRole('log')).toContainText('本机兼容 API · fixture-local');
  assert.deepEqual(errors, []);
  console.log('Three-column workspace and AI browser regressions passed.');
} finally {
  await browser.close();
  await server.close();
}
