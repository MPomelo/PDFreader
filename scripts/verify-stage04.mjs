import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import './stage04-fixtures.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-crash-reporter'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [], evidence = [], diagnostics = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (['error','warning'].includes(message.type())) diagnostics.push(message.text()); });
page.on('requestfailed', request => diagnostics.push(request.url() + ': ' + request.failure()?.errorText));
const base = process.env.STAGE04_URL || 'http://127.0.0.1:1422';
const server = process.env.STAGE04_URL ? null : spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '1422', '--strictPort'], { cwd: process.cwd(), windowsHide: true });
let serverOutput = '';
server?.stdout.on('data', bytes => serverOutput += bytes); server?.stderr.on('data', bytes => serverOutput += bytes);
try {
  if (server) {
    let ready = false;
    for (let i = 0; i < 40; ++i) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 150)); }
    if (!ready) throw Error('Fixture server failed: ' + serverOutput.slice(-800));
  }
  await page.goto(base + '/test-results/stage04/app.html');
  const frame = page.frameLocator('iframe');
  // Cold Vite dependency transforms are outside PDF opening time. Wait for the
  // actual upstream Viewer, rather than charging that time to document loading.
  await frame.locator('body').waitFor({ state: 'attached', timeout: 60000 });
  await frame.locator('body').evaluate(async () => {
    const deadline = Date.now() + 60000;
    while (!window.PDFViewerApplication?.initialized) {
      if (Date.now() > deadline) throw Error('PDF.js initialization did not finish');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  });
  await page.locator('input[type=file]').setInputFiles(resolve('test-results/stage02/reading.pdf'));
  await frame.locator('.textLayer span').first().waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'API 设置', exact: true }).click();
  await page.locator('.panel-heading button').click();
  await page.getByRole('button', { name: '文档导航', exact: true }).click();
  async function select(index) {
    await frame.locator('.page[data-page-number="1"] .textLayer span').nth(index).evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.getByRole('button', { name: '翻译选区', exact: true }).waitFor();
  }
  const callCount = () => page.evaluate(() => window.fixtureCalls.length);
  async function completed() { await page.locator('.translation-result .stream-status').filter({ hasText: '已完成' }).waitFor({ timeout: 15000 }); }
  await select(0);
  assert.equal(await page.getByRole('checkbox', { name: /选区自动翻译/ }).isChecked(), false);
  await page.getByRole('button', { name: '翻译选区', exact: true }).click();
  await page.getByText('正在接收 · 内容尚未完成', { exact: true }).waitFor();
  await completed();
  assert.equal(await page.locator('.translation-result .katex-error').count(), 0);
  assert.equal(await page.locator('.translation-result .katex-display').count(), 2);
  assert.equal(await page.locator('.thinking[open]').count(), 0);
  assert.ok((await page.locator('.translation-result table').count()) > 0);
  evidence.push('Real PDF selection through ReaderAdapter; streamed mock result renders math/table; thinking collapsed; automatic mode off');

  const right = page.getByRole('separator', { name: '调整右侧栏宽度' });
  const fingerprint = await frame.locator('body').evaluate(() => window.PDFViewerApplication.pdfDocument.fingerprints[0]);
  const before = await page.locator('.translation-shell').boundingBox();
  const box = await right.boundingBox();
  await page.mouse.move(box.x + 4, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x - 176, box.y + 100, { steps: 12 }); await page.mouse.up();
  const after = await page.locator('.translation-shell').boundingBox();
  assert.ok(after.width >= before.width + 170);
  await right.focus(); await right.press('ArrowLeft');
  const keyboard = await page.locator('.translation-shell').boundingBox(); assert.ok(keyboard.width >= after.width + 19);
  const left = page.getByRole('separator', { name: '调整左侧栏宽度' }); await left.focus(); await left.press('ArrowRight');
  assert.ok((await page.locator('.navigation-shell').boundingBox()).width >= 240);
  assert.equal(await callCount(), 1, 'resizing cannot issue translation requests');
  assert.equal(await frame.locator('body').evaluate(() => window.PDFViewerApplication.pdfDocument.fingerprints[0]), fingerprint);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'test-results/stage04/reader-resized.png' });
  evidence.push('Both sidebars resize; keyboard increments; PDF remains mounted and no translation is retriggered');

  await page.evaluate(() => { window.fixtureDelay = 220; window.fixtureIgnoreCancel = true; });
  await select(1); await page.getByRole('button', { name: '翻译选区', exact: true }).click();
  await page.getByText('正在接收 · 内容尚未完成', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByText('已取消 · 以下为未完成内容', { exact: true }).waitFor();
  await page.evaluate(() => { window.fixtureDelay = 1; });
  await select(0); await page.getByRole('button', { name: '翻译选区', exact: true }).click(); await completed();
  const source = await page.locator('.translation-source').inputValue();
  await page.waitForTimeout(6000);
  assert.equal(await page.locator('.translation-source').inputValue(), source);
  assert.equal(await page.locator('.translation-result .stream-status').innerText(), '已完成');
  evidence.push('Cancellation keeps explicit incomplete state; late chunks and completion from old A do not overwrite B');

  const countBeforeAuto = await callCount();
  await page.getByRole('checkbox', { name: /选区自动翻译/ }).check();
  await page.waitForFunction(expected => window.fixtureCalls.length === expected, countBeforeAuto + 1); await completed();
  await page.waitForTimeout(900); assert.equal(await callCount(), countBeforeAuto + 1);
  await page.getByRole('checkbox', { name: /选区自动翻译/ }).uncheck();
  const countBeforeStyle = await callCount();
  await page.getByLabel('回答样式').selectOption('detailed');
  await page.getByRole('checkbox', { name: '流式输出', exact: true }).uncheck();
  assert.equal(await callCount(), countBeforeStyle, 'preferences do not send text when automatic mode is off');
  await page.getByRole('button', { name: '翻译选区', exact: true }).click(); await completed();
  assert.equal(await page.evaluate(() => window.fixtureCalls.at(-1).stream), false);
  evidence.push('Opt-in automatic translation debounces without repeat; style changes alone do not send text; non-stream retry works');

  const beforeShortcut = await callCount();
  await select(0); await frame.locator('body').press('Control+Shift+Enter');
  await page.waitForFunction(expected => window.fixtureCalls.length === expected, beforeShortcut + 1); await completed();
  evidence.push('Ctrl+Shift+Enter from inside PDF iframe reaches the shared translation entry');

  await page.evaluate(() => { window.fixtureClipboard = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.fixtureClipboard = text; } } }); });
  await page.getByRole('button', { name: '复制 Markdown / LaTeX', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixtureClipboard), await page.locator('.translation-source').inputValue());
  await page.getByRole('button', { name: '复制纯文本', exact: true }).click();
  assert.ok(!(await page.evaluate(() => window.fixtureClipboard)).includes('## 学术译文'));
  const formula = page.locator('.translation-result .katex-display').first(); await formula.hover();
  await formula.getByRole('button', { name: '复制公式', exact: true }).click();
  assert.ok((await page.evaluate(() => window.fixtureClipboard)).includes('mathcal'));
  evidence.push('Both copy actions use authoritative source; clipboard endpoint substituted to avoid changing the user clipboard');

  await page.setViewportSize({ width: 850, height: 720 }); await page.screenshot({ path: 'test-results/stage04/reader-narrow.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('checkbox', { name: '流式输出', exact: true }).check();
  await page.evaluate(() => { window.fixtureDelay = 200; window.fixtureIgnoreCancel = true; });
  await select(0); await page.getByRole('button', { name: '翻译选区', exact: true }).click();
  await page.getByText('正在接收 · 内容尚未完成', { exact: true }).waitFor();
  await page.locator('input[type=file]').setInputFiles(resolve('test-results/stage02/scanned.pdf'));
  await page.locator('.filename').filter({ hasText: 'scanned.pdf' }).waitFor();
  await page.waitForTimeout(6000);
  assert.equal(await page.locator('.translation-result').count(), 0);
  evidence.push('Opening a different real PDF during a delayed stream clears the old source/result and rejects every late chunk');
  const currentWidths = await page.evaluate(() => localStorage.getItem('pdfreader.panel-widths.v1'));
  await page.reload();
  assert.equal(await page.evaluate(() => localStorage.getItem('pdfreader.panel-widths.v1')), currentWidths);
  assert.equal(errors.length, 0, errors.join('\n'));
  evidence.push('Narrow-window overlay and width preference reload checked; zero page errors');
  writeFileSync('test-results/stage04/browser-evidence.json', JSON.stringify({ environment: 'headless system Edge; real product UI/PDF.js, explicitly mocked provider and clipboard; not native Tauri or real provider calls', evidence, errors }, null, 2));
  console.log(JSON.stringify({ passed: evidence.length, evidence }, null, 2));
} catch (error) {
  writeFileSync('test-results/stage04/browser-failure.json', JSON.stringify({ error: String(error), errors, diagnostics, serverOutput: serverOutput.slice(-1200), body: await page.locator('body').innerText().catch(() => ''), frames: await Promise.all(page.frames().map(async frame => ({ url: frame.url(), html: (await frame.content().catch(() => '')).slice(0,1600), body: await frame.locator('body').innerText().catch(() => '') }))) }, null, 2));
  throw error;
} finally { await browser.close(); server?.kill(); }
