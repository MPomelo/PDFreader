import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

execFileSync('python', [resolve('scripts/stage02-fixtures.py')], { stdio: 'pipe' });
const base = 'http://127.0.0.1:1433';
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'preview', '--port', '1433', '--strictPort']);
server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);
let browser;

try {
  await expect.poll(async () => fetch(base).then(response => response.ok, () => false), { timeout: 15_000 }).toBe(true);
  browser = await chromium.launch(process.env.PDFREADER_CHROMIUM
    ? { executablePath: process.env.PDFREADER_CHROMIUM }
    : process.platform === 'win32' ? { channel: 'msedge' } : {});
  const context = await browser.newContext({ viewport: { width: 930, height: 660 }, deviceScaleFactor: 1.5 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const menu = page.locator('.new-document > .command-menu');
  await page.getByRole('button', { name: '新建或打开文档' }).click();
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  assert.ok(box.x >= 0 && box.width < 145 && box.height < 96, JSON.stringify(box));
  await expect(menu.getByRole('button', { name: '新建 Markdown' })).toHaveCSS('font-size', '12px');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  const fileInput = page.locator('input[type=file]');
  await fileInput.setInputFiles(resolve('test-results/stage02/link-preview.pdf'));
  const frame = page.frameLocator('iframe[title="PDF · link-preview.pdf"]');
  const body = frame.locator('body');
  const links = frame.locator('.page[data-page-number="1"] .linkAnnotation > a');
  const popover = frame.locator('.pdfreader-link-preview');
  await expect(links).toHaveCount(7);
  const annotations = await body.evaluate(async () => {
    const page = await window.PDFViewerApplication.pdfDocument.getPage(1);
    return (await page.getAnnotations({ intent: 'display' })).map(({ id, rect }) => ({ id, rect }));
  });
  const at = (x, y) => {
    const { id } = annotations.find(({ rect }) => rect[0] === x && rect[1] === y);
    return frame.locator(`.page[data-page-number="1"] .linkAnnotation > a[data-element-id="${id}"]`);
  };
  const figureLink = at(72, 699), referenceLink = at(195, 699), tableLink = at(252, 699);
  const exactLink = at(72, 659), pageLink = at(195, 659), externalLink = at(300, 659), brokenLink = at(428, 659);
  await expect(page.locator('footer')).toContainText('第 1 / 6 页');
  const readState = () => body.evaluate(() => {
    const { pdfViewer, pdfDocument } = window.PDFViewerApplication;
    const { scrollTop, scrollLeft } = pdfViewer.container;
    return { page: pdfViewer.currentPageNumber, zoom: pdfViewer.currentScaleValue,
      scrollTop, scrollLeft, annotations: pdfDocument.annotationStorage.serializable.hash };
  });
  const initial = await readState();
  const containsColor = (r, g, b) => popover.locator('canvas').evaluate((canvas, expected) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < pixels.length; i += 4) {
      if (expected.every((color, channel) => Math.abs(color - pixels[i + channel]) <= 3)) return true;
    }
    return false;
  }, [r, g, b]);

  // Preview at a real PDF.js annotation, using the target's offscreen page.
  await figureLink.hover();
  await expect(popover).toBeHidden();
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute('data-region', 'figure');
  await expect(popover).toContainText('第 2 页');
  await expect(popover).toHaveCSS('pointer-events', 'none');
  assert.equal(await containsColor(31, 138, 204), true, 'the plot is in the cropped preview');
  assert.deepEqual(await readState(), initial);
  await body.evaluate(() => { window.PDFViewerApplication.pdfViewer.container.scrollTop += 35; });
  await expect(popover).toBeHidden();
  await body.evaluate(async () => {
    window.PDFViewerApplication.pdfViewer.container.scrollTop = 0;
    await new Promise(resolve => requestAnimationFrame(resolve));
  });

  await referenceLink.hover();
  await expect(popover).toHaveAttribute('data-region', 'reference');
  await expect(popover).toContainText('第 3 页');
  const reference = await popover.locator('canvas').boundingBox();
  assert.ok(reference.height < 100, 'a compact crop includes the wrapped entry');
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  await tableLink.hover();
  await expect(popover).toHaveAttribute('data-region', 'table');
  await expect(popover).toContainText('第 4 页');
  assert.equal(await containsColor(217, 217, 217), true, 'the table is below its caption');

  await exactLink.hover();
  await expect(popover).toHaveAttribute('data-region', 'region');
  await expect(popover).toContainText('第 5 页');
  const exact = await popover.locator('canvas').boundingBox();
  assert.ok(exact.height > exact.width, 'the rectangular region follows the PDF page rotation');
  assert.equal(await containsColor(179, 51, 26), true, 'the rotated CropBox still shows the requested red area');

  await pageLink.hover();
  await expect(popover).toHaveAttribute('data-region', 'page');
  await expect(popover).toContainText('第 6 页');
  await brokenLink.hover();
  await expect(popover).toBeHidden();
  await externalLink.hover();
  await page.waitForTimeout(480);
  await expect(popover).toBeHidden();

  await exactLink.hover();
  await figureLink.hover();
  await expect(popover).toHaveAttribute('data-region', 'figure');
  await expect(popover).toContainText('第 2 页');
  await figureLink.click();
  await expect(popover).toBeHidden();
  await expect(page.locator('footer')).toContainText('第 2 / 6 页');
  await expect.poll(() => body.evaluate(() => window.PDFViewerApplication.pdfViewer.container.scrollTop)).toBeGreaterThan(initial.scrollTop);

  // A fresh open of a different tab or a tool switch never inherits the popup.
  const pageNumber = page.getByRole('textbox', { name: '页码' });
  await pageNumber.fill('1');
  await pageNumber.press('Enter');
  await expect(page.locator('footer')).toContainText('第 1 / 6 页');
  await page.mouse.move(10, 12);
  await figureLink.hover();
  await expect(popover).toBeVisible();
  await fileInput.setInputFiles(resolve('test-results/stage02/reading.pdf'));
  await expect(page.getByRole('tab', { name: 'reading.pdf' })).toHaveAttribute('aria-selected', 'true');
  await expect(popover).toBeHidden();

  await page.getByRole('tab', { name: 'link-preview.pdf' }).click();
  const selectable = frame.locator('.page[data-page-number="1"] .textLayer span').filter({ hasText: 'Selectable words for copy and markup' });
  await selectable.waitFor();
  const line = await selectable.boundingBox();
  await page.mouse.move(line.x + 2, line.y + line.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + line.width - 1, line.y + line.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(frame.locator('.pdfreader-precise-selection > div').first()).toBeVisible();
  await expect(popover).toBeHidden();
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await page.getByRole('searchbox').fill('Next words for the search regression');
  await expect(page.getByRole('search', { name: '文档内查找' }).getByRole('status')).toHaveText('1 / 1');
  assert.deepEqual(errors, []);
  console.log('Link preview, original jump, precision selection, search and compact menu verified using PDF.js.');
} finally {
  await browser?.close();
  server.kill();
}
