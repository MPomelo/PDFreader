import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const original = 'test-results/stage02/reading.pdf';
const exported = 'test-results/workspace/markup-update.pdf';
execFileSync('python', ['scripts/stage02-fixtures.py']);
await import('./workspace-fixtures.mjs');
const originalBytes = await readFile(original);
const server = await createServer({ server: { port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    ...(process.env.PDFREADER_CHROMIUM ? { executablePath: process.env.PDFREADER_CHROMIUM } : { channel: 'msedge' }),
  });
  const context = await browser.newContext({ viewport: { width: 1150, height: 850 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url + 'test-results/workspace/app.html');
  const frame = page.frameLocator('.document-pane[data-active=true] iframe');
  const text = (number, index = 0) => frame.locator('.page[data-page-number="' + number + '"] .textLayer span[dir]').nth(index);
  const menu = frame.getByRole('menu', { name: '选区操作' });
  const action = name => menu.getByRole('menuitem', { name, exact: true });
  const hostButton = name => page.getByRole('button', { name, exact: true });
  const viewer = frame.locator('#viewerContainer');
  const markings = () => frame.locator('body').evaluate(() => [...PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values()]
    .map(mark => ({ markup: mark.markup ?? 'highlight', quads: mark.quadPoints?.length, page: mark.pageIndex })));
  const select = async (first, last = first) => first.evaluate((element, end) => {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(end.firstChild, end.firstChild.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  }, await last.elementHandle());
  const openPDF = path => page.locator('input[type=file]').setInputFiles(path);
  await openPDF(original);
  await expect(text(1)).toBeVisible();
  assert.ok(await page.locator('.workspace-brand img').evaluate(img => img.complete && img.naturalWidth > 0));

  await page.setViewportSize({ width: 720, height: 650 });
  await hostButton('阅读工具').click();
  await hostButton('更多 PDF 工具').click();
  await expect(hostButton('末页')).toBeVisible();
  await expect(frame.locator('#secondaryToolbar')).toBeHidden();
  const bounds = await page.locator('.utilities-group .command-menu').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 720);
  await hostButton('末页').click();
  await expect(page.getByRole('textbox', { name: '页码' })).toHaveValue('2');
  await hostButton('阅读工具').click();
  await hostButton('更多 PDF 工具').click();
  await viewer.press('Escape');
  await expect(hostButton('末页')).toBeHidden();
  await hostButton('上一页').click();
  await page.setViewportSize({ width: 1150, height: 850 });

  await hostButton('批注工具').click();
  await hostButton('添加文本').click();
  const size = frame.locator('#editorFreeTextFontSize');
  await expect(size).toBeVisible();
  await size.fill('23');
  await expect(frame.locator('#pdfreader-text-size')).toHaveText('23');
  await hostButton('批注工具').click();
  await hostButton('选择文字').click();
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode)).toBe(0);

  await text(1).click({ button: 'right' });
  await expect(menu).toBeHidden();
  const copied = await select(text(1));
  await text(1).click({ button: 'right' });
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['复制', '高亮', '下划线', '删除线', '写注释', '翻译']);
  await action('复制').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(copied);
  await expect(menu).toBeHidden();

  await hostButton('设置').click();
  await page.getByLabel('译文字号').selectOption('18');
  await hostButton('关闭设置').click();
  await select(text(1));
  await viewer.press('Shift+F10');
  await expect(action('复制')).toBeFocused();
  await action('翻译').click();
  const translated = page.locator('.tab-translation:not([hidden]) .translation-result .markdown-body');
  await expect(translated).toHaveCSS('font-size', '18px');
  await expect.poll(() => page.evaluate(() => window.calls.length)).toBe(1);
  await hostButton('关闭翻译').click();

  await select(text(1), text(1, 1));
  await text(1).click({ button: 'right' });
  await action('下划线').click();
  await expect.poll(markings).toEqual([{ markup: 'underline', quads: 16, page: 0 }]);
  await viewer.press('Control+z');
  await expect.poll(markings).toEqual([]);
  await viewer.press('Control+y');
  await expect.poll(markings).toEqual([{ markup: 'underline', quads: 16, page: 0 }]);

  await hostButton('阅读工具').click();
  await hostButton('更多 PDF 工具').click();
  await hostButton('水平滚动').click();
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.scrollMode)).toBe(1);
  await frame.locator('body').evaluate(() => { PDFViewerApplication.pdfViewer.currentScaleValue = '0.55'; });
  await expect(text(2)).toBeVisible();
  await select(text(1, 1), text(2));
  await expect(page.locator('.selection-actions')).toBeVisible();
  await hostButton('批注工具').click();
  await hostButton('删除线').click();
  await expect.poll(markings).toEqual([
    { markup: 'underline', quads: 16, page: 0 },
    { markup: 'strikeout', quads: 8, page: 0 },
    { markup: 'strikeout', quads: 8, page: 1 },
  ]);
  await viewer.press('Control+z');
  await expect.poll(markings).toEqual([{ markup: 'underline', quads: 16, page: 0 }]);
  await viewer.press('Control+y');
  await expect.poll(markings).toHaveLength(3);

  await page.evaluate(() => {
    window.showSaveFilePicker = async () => ({ name: 'markup-update.pdf', createWritable: async () => ({
      write: async blob => { window.exportBytes = Array.from(new Uint8Array(await blob.arrayBuffer())); },
      close: async () => {}, abort: async () => {},
    }) });
  });
  await hostButton('导出').click();
  await expect(page.getByRole('status').filter({ hasText: '已导出' })).toBeVisible();
  await writeFile(exported, Buffer.from(await page.evaluate(() => window.exportBytes)));
  assert.deepEqual(await readFile(original), originalBytes);
  execFileSync('python', ['-c', `
from pypdf import PdfReader
import sys
pages = PdfReader(sys.argv[1]).pages
for page, subtypes in zip(pages, [('/Underline', '/StrikeOut'), ('/StrikeOut',)], strict=True):
    marks = [obj.get_object() for obj in page['/Annots'] if obj.get_object()['/Subtype'] in subtypes]
    assert tuple(str(mark['/Subtype']) for mark in marks) == subtypes
    for mark in marks:
        assert len(mark['/QuadPoints']) >= 8 and mark['/AP']['/N'].get_data()
`, exported]);
  await openPDF(exported);
  await expect(page.getByRole('tab', { name: 'markup-update.pdf' })).toHaveAttribute('aria-selected', 'true');
  await expect(frame.locator('.underlineAnnotation').first()).toBeVisible();
  await expect(frame.locator('.strikeoutAnnotation').first()).toBeVisible();
  await frame.locator('.underlineAnnotation').first().dblclick();
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode)).toBe(9);
  await frame.locator('.highlightEditor.selectedEditor').press('Delete');
  await expect(page.locator('.document-tab.selected .dirty-dot')).toBeVisible();

  const reopened = await context.newPage();
  await reopened.goto(url + 'test-results/workspace/app.html');
  await reopened.getByRole('button', { name: '设置', exact: true }).click();
  await expect(reopened.getByLabel('译文字号')).toHaveValue('18');
  assert.deepEqual(errors, []);
  console.log('Verified the brand, Tools menu, font settings, selection menu, cross-page PDF markup, undo/redo, export and reopen.');
} finally {
  await browser?.close();
  await server.close();
}
