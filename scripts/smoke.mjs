import { chromium } from '@playwright/test';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('test-results/中文 路径', { recursive: true });
const pdf = resolve('test-results/中文 路径/样例 论文.pdf');
await copyFile('public/pdfjs/web/compressed.tracemonkey-pldi-09.pdf', pdf);
await mkdir('.local/browser-temp', { recursive: true });
process.env.TEMP = process.env.TMP = resolve('.local/browser-temp');
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-crash-reporter'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const evidence = [];
try {
  await page.goto(process.env.SMOKE_URL || 'http://127.0.0.1:1421');
  await page.getByRole('heading', { name: '专注阅读，从一份 PDF 开始' }).waitFor();
  await page.screenshot({ path: 'test-results/welcome.png' });
  await page.locator('input[type=file]').setInputFiles(pdf);
  await page.getByText('第 1 / 14 页', { exact: true }).waitFor({ timeout: 30000 });
  const viewer = page.frameLocator('iframe');
  await viewer.locator('.page[data-page-number="1"] canvas').waitFor();
  const firstId = await viewer.locator('body').evaluate(() => window.PDFViewerApplication.pdfDocument.fingerprints[0]);
  evidence.push({ check: '真实PDF与中文空格路径（浏览器文件选择）', result: 'passed', fingerprint: firstId });
  await page.getByRole('button', { name: '文档导航', exact: true }).click();
  await page.getByRole('button', { name: '翻译侧栏', exact: true }).click();
  await page.getByRole('complementary', { name: '文档导航面板' }).waitFor();
  await viewer.locator('.textLayer span').first().waitFor();
  await viewer.locator('.textLayer span').first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.locator('.selection').waitFor();
  evidence.push({ check: '文档ID桥接与选区回传', result: 'passed', selection: await page.locator('.selection').textContent() });
  await page.screenshot({ path: 'test-results/reader-panels.png' });
  await page.getByRole('button', { name: '专注阅读', exact: true }).click();
  if (await page.locator('aside').count() !== 0) throw Error('侧栏未完全移除');
  const box = await page.locator('.reader').boundingBox();
  if (box.width !== 1280 || box.x !== 0) throw Error('隐藏后仍有侧栏占位');
  await page.screenshot({ path: 'test-results/reader-focused.png' });
  await page.getByRole('button', { name: '专注阅读', exact: true }).click();
  if (await page.locator('aside').count() !== 2) throw Error('阅读模式未恢复双栏');
  evidence.push({ check: '双侧栏完全隐藏与恢复', result: 'passed', readerWidth: box.width });
  await viewer.locator('#pageNumber').fill('2');
  await viewer.locator('#pageNumber').press('Enter');
  await page.getByText('第 2 / 14 页', { exact: true }).waitFor();
  evidence.push({ check: '真实页码事件', result: 'passed' });
  // Exercise the browser drop flow using an actual PDF-backed File.
  const bytes = await (await import('node:fs/promises')).readFile(pdf);
  await page.evaluate(data => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], '拖入 测试.pdf', { type: 'application/pdf' }));
    document.querySelector('.app').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  }, [...bytes]);
  await page.getByText('第 1 / 14 页', { exact: true }).waitFor();
  evidence.push({ check: '浏览器文件拖入', result: 'passed' });
  await page.setViewportSize({ width: 850, height: 720 });
  await page.screenshot({ path: 'test-results/narrow.png' });
  await page.locator('input[type=file]').setInputFiles({ name: 'invalid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
  await page.getByRole('alert').waitFor();
  evidence.push({ check: '无效文件可见错误且不崩溃', result: 'passed' });
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile('test-results/smoke.json', JSON.stringify({ environment: 'production frontend served locally in headless Edge; NOT Tauri native', evidence, errors }, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await browser.close(); }
