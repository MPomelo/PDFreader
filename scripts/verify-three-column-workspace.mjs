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
    window.qa = { open: [pdfPath], requests: [], cancels: [], writes: [] };
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
          case 'api_cancel': window.qa.cancels.push(args.requestId); return;
          case 'chat_request': return new Promise(resolve => {
            const { request, onChunk } = args;
            const send = callbacks.get(onChunk.id);
            window.qa.requests.push({ ...request, finish: () => {
              send({ index: 2, message: { requestId: request.requestId, sessionId: request.sessionId, sequence: 3, text: 'late' } });
              send({ index: 3, end: true });
              resolve({ model: request.model, text: 'Answer ' + (request.messages.at(-1).text.match(/\[\[M[a-f0-9]+\]\]/)?.[0] ?? ''), usage: { input_tokens: 10, output_tokens: 2 } });
            } });
            send({ index: 0, message: { requestId: request.requestId, sessionId: 'different-session', sequence: 1, text: 'wrong session' } });
            send({ index: 1, message: { requestId: request.requestId, sessionId: request.sessionId, sequence: 2, text: 'Partial answer' } });
          });
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
    await button('打开文档', page.locator('.new-document[open]')).click();
  };
  const tab = name => page.getByRole('tab', { name, exact: true });
  const txt = page.getByRole('textbox', { name: 'TXT 编辑器' });
  await openIn('', pdfPath);
  const frame = page.frameLocator('iframe[title="PDF · paper.pdf"]');
  await expect(frame.locator('.textLayer span').first()).toBeVisible({ timeout: 45000 });
  await frame.locator('body').evaluate(() => { window.workspaceIdentity = 22; });
  await button('下栏').click();
  await openIn('下栏', markdownPath);
  await button('右栏').click();
  await openIn('右栏', textPath);
  await expect(txt).toBeVisible();
  await expect(tab('paper.pdf')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('notes.md')).toHaveAttribute('aria-selected', 'true');
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
  await expect(page.getByRole('combobox', { name: '缩放', exact: true })).toBeVisible();
  await page.keyboard.press('Shift+F6');
  await expect(page.locator('footer')).toContainText('UTF-8');

  await button('新建或打开文档').click();
  await button('新建 AI 对话').click();
  const chat = page.getByRole('textbox', { name: '对话输入' });
  await button('加入当前页').click();
  await expect(page.locator('.chat-materials')).toContainText('paper.pdf');
  await chat.fill('What is this article about?');
  assert.equal(await page.evaluate(() => window.qa.requests.length), 0);
  await button('发送').click();
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
  const requests = await page.evaluate(() => window.qa.requests.map(({ sessionId, requestId, messages }) => ({ sessionId, requestId, messages })));
  assert.equal(requests[0].sessionId, requests[1].sessionId);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.deepEqual(requests[0].messages, requests[1].messages);
  assert.match(requests[0].messages[0].text, /\[\[M[a-f0-9]{32}\]\]/);
  assert.ok(!requests[0].messages[0].text.includes(pdfPath));
  await page.evaluate(() => window.qa.requests[1].finish());
  await expect(page.getByRole('log')).toContainText('Answer');
  await button('定位原文 · paper.pdf · 第 1 页').click();
  await expect(page.getByRole('combobox', { name: '缩放', exact: true })).toBeVisible();

  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-state'))?.data.workspace?.resources.length)).toBe(4);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('test-chat'))?.data.conversations[0]?.turns[0]?.state)).toBe('complete');
  await page.reload();
  await expect(page.getByRole('tablist', { name: '右栏标签' }).getByRole('tab', { name: 'paper.pdf' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: '下栏标签' }).getByRole('tab', { name: 'AI 对话' })).toBeVisible();
  await tab('AI 对话').click();
  await expect(page.getByRole('log')).toContainText('Answer');
  assert.deepEqual(errors, []);
  console.log('Three-column workspace and AI browser regressions passed.');
} finally {
  await browser.close();
  await server.close();
}
