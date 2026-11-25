import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { lineMarkupBoxes } from '../public/pdfjs/web/markup-appearance.mjs';

const boxes = [
  { x: 0.10, y: 0.2, width: 0.04, height: 0.02 },
  { x: 0.145, y: 0.201, width: 0.08, height: 0.019 },
  { x: 0.50, y: 0.2, width: 0.15, height: 0.02 },
  { x: 0.10, y: 0.23, width: 0.17, height: 0.02 },
];
const before = JSON.stringify(boxes);
for (const kind of ['underline', 'strikeout']) {
  const marks = lineMarkupBoxes(boxes, kind, [612, 792]);
  assert.equal(marks.length, 3, 'ordinary word gap joins, column and row gaps remain');
  assert.ok(Math.abs(marks[0].width - 0.125) < 1e-7);
  assert.ok(marks.every(mark => Math.abs(mark.height * 792 - 0.6) < 1e-7));
}
assert.equal(JSON.stringify(boxes), before);

execFileSync('python', ['scripts/stage02-fixtures.py']);
await import('./workspace-fixtures.mjs');
const original = 'test-results/stage02/reading.pdf';
const firstExport = 'test-results/workspace/annotation-workspace.pdf';
const secondExport = 'test-results/workspace/annotation-workspace-reopened.pdf';
const originalBytes = await readFile(original);
const server = await createServer({ cacheDir: 'node_modules/.vite/annotation-workspace', server: { port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.PDFREADER_CHROMIUM ? { executablePath: process.env.PDFREADER_CHROMIUM } : { channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const frame = page.frameLocator('.document-pane[data-active=true] iframe');
  const toolbar = page.getByRole('banner', { name: '文档工具栏' });
  const panel = page.getByRole('complementary', { name: '批注管理' });
  const button = (name, root = page) => root.getByRole('button', { name, exact: true });
  const hiddenInput = page.locator('input[type=file]');
  const text = (index = 0) => frame.locator('.page[data-page-number="1"] .textLayer span[dir]').nth(index);
  const markMenu = frame.getByRole('toolbar', { name: '选区操作' });
  const annotationStorage = () => frame.locator('body').evaluate(() => [...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() || [])]);
  const content = frame.locator('.pdfreader-text-box .internal');
  const menu = async name => {
    await button('批注工具', toolbar).click();
    await button(name, toolbar).click();
  };
  const useSelection = async (name, index) => {
    const span = text(index);
    await span.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await span.click({ button: 'right' });
    await button(name, markMenu).click();
  };
  async function exportCopy(path) {
    await page.evaluate(() => {
      window.exportBytes = null;
      window.showSaveFilePicker = async () => ({ name: '批注.pdf', createWritable: async () => ({
        write: async blob => { window.exportBytes = Array.from(new Uint8Array(await blob.arrayBuffer())); },
        close: async () => {}, abort: async () => {},
      }) });
    });
    await button('导出', toolbar).click();
    await expect.poll(() => page.evaluate(() => window.exportBytes?.length || 0)).toBeGreaterThan(0);
    await expect(page.locator('.document-tab.selected .dirty-dot')).toBeHidden();
    await writeFile(path, Buffer.from(await page.evaluate(() => window.exportBytes)));
  }

  await page.goto(server.resolvedUrls.local[0] + 'test-results/workspace/app.html');
  await hiddenInput.setInputFiles(original);
  await expect(text()).toBeVisible({ timeout: 60000 });
  await page.getByRole('combobox', { name: '缩放' }).selectOption('page-fit');
  await useSelection('下划线', 0);
  await useSelection('删除线', 1);
  await menu('管理批注');
  await expect(button('删除下划线', panel)).toBeVisible();
  await button('删除下划线', panel).click();
  await expect(button('删除下划线', panel)).toHaveCount(0);
  await expect(button('删除删除线', panel)).toBeVisible();
  await button('撤销批注', panel).click();
  await expect(button('删除下划线', panel)).toBeVisible();
  await button('重做批注', panel).click();
  await expect(button('删除下划线', panel)).toHaveCount(0);
  await button('撤销批注', panel).click();
  await expect(button('删除下划线', panel)).toBeVisible();

  await useSelection('写注释', 0);
  await expect(panel.getByRole('heading', { name: '添加注释' })).toBeVisible();
  await expect(frame.locator('#commentManagerDialog')).toBeHidden();
  await expect(frame.locator('#editorCommentsSidebar')).toBeHidden();
  await expect(button('删除下划线', panel)).toHaveCount(0);
  const note = panel.getByRole('textbox', { name: '注释内容' });
  await expect(note).toBeFocused();
  await note.fill('先取消这一条');
  await button('取消', panel).click();
  await expect(panel.getByRole('heading', { name: '管理批注' })).toBeVisible();
  assert.ok((await annotationStorage()).every(item => item.annotationType !== 102));

  await useSelection('写注释', 1);
  await note.fill('导出后仍可编辑的中文注释');
  await button('保存批注', panel).click();
  await expect(button('编辑注释', panel)).toBeVisible();
  const marker = frame.locator('.pdfreaderNoteEditor .annotationCommentButton');
  await expect(marker).toBeVisible();
  await button('删除注释', panel).click();
  await expect(marker).toHaveCount(0);
  await button('撤销批注', panel).click();
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(note).toHaveValue('导出后仍可编辑的中文注释');
  await button('取消', panel).click();

  await menu('添加文本框');
  const editorLayer = frame.locator('.page[data-page-number="1"] .annotationEditorLayer');
  await expect(editorLayer).toBeVisible();
  const bounds = await editorLayer.boundingBox();
  const start = { x: bounds.x + 50, y: bounds.y + 250 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 130, start.y + 30, { steps: 10 });
  await page.mouse.up();
  await expect(content).toBeFocused();
  await content.fill('科研笔记：这是一个可换行的中文文本框。\n第二行 mixed text，包含标点。');
  await content.press('Control+Enter');
  await expect(button('编辑文本框', panel)).toBeVisible();
  await button('删除文本框', panel).click();
  await expect(content).toHaveCount(0);
  await button('撤销批注', panel).click();
  await expect(button('编辑文本框', panel)).toBeVisible();
  await button('调整宽度', panel).click();
  await panel.getByRole('spinbutton').fill('90');
  await button('应用', panel).click();
  await expect.poll(async () => ({
    width: (await annotationStorage()).find(mark => mark.pdfreaderBoxWidth)?.pdfreaderBoxWidth,
    error: await page.locator('.error').allTextContents(),
  })).toEqual({ width: 90, error: [] });
  await button('编辑文本框', panel).click();
  await expect(content).toBeFocused();
  await content.press('End');
  await content.press('Escape');
  await menu('选择文字');
  await exportCopy(firstExport);
  await expect(panel.getByText('暂无未导出的批注。')).toBeVisible();
  assert.deepEqual(await readFile(original), originalBytes);

  await hiddenInput.setInputFiles(firstExport);
  await expect(page.getByRole('tab', { name: 'annotation-workspace.pdf' })).toHaveAttribute('aria-selected', 'true');
  await expect(frame.locator('.freeTextAnnotation').first()).toBeVisible({ timeout: 30000 });
  await menu('管理批注');
  await button('全部批注', panel).click();
  await expect(button('编辑文本框', panel)).toBeVisible();
  await expect(button('编辑注释', panel)).toBeVisible();
  await button('编辑注释', panel).click();
  await expect(note).toHaveValue('导出后仍可编辑的中文注释');
  await note.fill('重新打开后修改注释');
  await button('保存批注', panel).click();

  await button('编辑文本框', panel).click();
  await expect(content).toBeFocused();
  await expect(content).toContainText('科研笔记');
  await content.fill('重新打开后修改文本框\nUpdated text');
  await content.press('Control+Enter');
  await menu('选择文字');
  await exportCopy(secondExport);
  execFileSync('python', ['scripts/inspect-annotation-workspace.py', original, firstExport, secondExport], { stdio: 'inherit' });
  assert.deepEqual(errors, []);
  console.log('Verified annotation management, notes, resize, Unicode FreeText, PDF export and reopen.');
} finally {
  await browser?.close();
  await server.close();
}
