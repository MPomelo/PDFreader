import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

execFileSync('python', ['scripts/stage02-fixtures.py']);
await import('./workspace-fixtures.mjs');
const server = await createServer({ cacheDir: 'node_modules/.vite/precise-selection', server: { port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    ...(process.env.PDFREADER_CHROMIUM ? { executablePath: process.env.PDFREADER_CHROMIUM } : { channel: 'msedge' }),
  });
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'test-results/workspace/app.html');
  await page.locator('input[type=file]').setInputFiles('test-results/stage02/precise-selection.pdf');
  const iframe = page.locator('.document-pane[data-active=true] iframe');
  const frame = iframe.contentFrame();
  const line = (text, number = 1) => frame.locator(`.page[data-page-number="${number}"] .textLayer span[dir]`).filter({ hasText: text });
  const button = name => page.getByRole('button', { name, exact: true });
  const menu = frame.getByRole('toolbar', { name: '选区操作' });
  const action = name => menu.getByRole('button', { name, exact: true });
  const viewer = frame.locator('#viewerContainer');
  const selection = frame.locator('.pdfreader-precise-selection');
  const leftFirst = line('Left first line page 1'), leftSecond = line('Left second line page 1');

  async function point(locator, offset) {
    const viewport = await iframe.boundingBox();
    const caret = await locator.evaluate((span, offset) => {
      const range = document.createRange();
      range.setStart(span.firstChild, offset);
      range.collapse(true);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x: x + width / 2, y: y + height / 2 };
    }, offset);
    return { x: viewport.x + caret.x, y: viewport.y + caret.y };
  }
  async function drag(first, start, last, end, after = null) {
    const a = await point(first, start), b = await point(last, end);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await expect(menu).toBeHidden();
    if (after) {
      await expect(selection.locator(':scope > div')).toHaveCount(after.rects ?? 2);
      await page.mouse.move(after.x, after.y);
    }
    await page.mouse.up();
    await expect(selection.first()).toBeVisible();
  }
  async function openAt(locator, offset) {
    const target = await point(locator, offset);
    await page.mouse.click(target.x, target.y, { button: 'right' });
    await expect(menu).toBeVisible();
  }
  async function clipboard(expected) {
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  }

  await page.locator('input[type=file]').setInputFiles('test-results/stage02/narrow-columns.pdf');
  const narrowLeft = index => line(new RegExp(`^Near left row ${String(index).padStart(2, '0')}`));
  await expect(narrowLeft(1)).toBeVisible({ timeout: 60000 });
  await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('page-fit');
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.currentScaleValue)).toBe('page-fit');
  const leftRows = [];
  for (let index = 1; index <= 10; index++) leftRows.push((await narrowLeft(index).textContent()).trimEnd());
  await drag(narrowLeft(1), 5, narrowLeft(7), 20);
  const onlyLeft = [leftRows[0].slice(5), ...leftRows.slice(1, 6), leftRows[6].slice(0, 20)].join('\n');
  const rightEdges = await selection.locator(':scope > div').evaluateAll(boxes => boxes.map(box =>
    parseFloat(box.style.left) + parseFloat(box.style.width)));
  assert.equal(rightEdges.length, 7);
  assert.ok(rightEdges.every(edge => edge < 100 * 316 / 612));
  await action('复制').click();
  await clipboard(onlyLeft);

  const narrowRight1 = line(/^Near right row 01/), narrowRight2 = line(/^Near right row 02/);
  const nearLeftEdge = await point(narrowLeft(7), leftRows[6].length);
  const nearRightEdge = await point(narrowRight2, 0);
  await drag(narrowLeft(7), 20, narrowLeft(1), 5);
  await action('复制').click();
  await clipboard(onlyLeft);
  await drag(narrowLeft(1), 5, narrowLeft(7), 20, { x: (nearLeftEdge.x + nearRightEdge.x) / 2, y: nearRightEdge.y, rects: 7 });
  await action('复制').click();
  await clipboard(onlyLeft);

  const narrowCaption = line(/^Fig\.$/), captionSecond = line(/^continuation$/);
  const overCaption = await point(line(/^illustration$/), 6);
  await drag(narrowLeft(1), 5, narrowLeft(7), 20, { ...overCaption, rects: 7 });
  await action('复制').click();
  await clipboard(onlyLeft);
  await drag(narrowCaption, 0, captionSecond, 'continuation'.length);
  await expect(narrowCaption).toHaveAttribute('data-pdfreader-block', 'figure-caption');
  await expect(captionSecond).toHaveAttribute('data-pdfreader-block', 'figure-caption');
  await action('复制').click();
  await clipboard('Fig. 1. An illustration and its explanation\nCaption continuation');

  await drag(narrowLeft(9), 8, narrowRight2, 19);
  await action('复制').click();
  await clipboard([leftRows[8].slice(8), leftRows[9], (await narrowRight1.textContent()).trimEnd(),
    (await narrowRight2.textContent()).slice(0, 19)].join('\n'));

  await drag(line(/^Journal title$/), 8, line(/^here$/), 2);
  await action('复制').click();
  await clipboard('title spans both columns he');

  await page.locator('input[type=file]').setInputFiles('test-results/stage02/column-spacing.pdf');
  const numberField = page.getByRole('textbox', { name: '页码' });
  async function goTo(pageNumber) {
    await numberField.fill(String(pageNumber));
    await numberField.press('Enter');
    await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.currentPageNumber)).toBe(pageNumber);
  }
  await expect(line(/^Left gap 03 row 01/)).toBeVisible({ timeout: 60000 });
  await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('page-fit');
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.currentScaleValue)).toBe('page-fit');
  for (const [pageIndex, gap] of [3, 4, 6, 18, 48].entries()) {
    const number = pageIndex + 1;
    if (pageIndex > 0) await goTo(number);
    const leftOnPage = row => line(new RegExp(`^Left gap ${String(gap).padStart(2, '0')} row 0${row}`), number);
    await expect(leftOnPage(1)).toBeVisible();
    const lineTexts = [];
    for (let row = 1; row <= 5; row++) lineTexts.push((await leftOnPage(row).textContent()).trimEnd());
    await drag(leftOnPage(1), 5, leftOnPage(5), 22);
    await action('复制').click();
    await clipboard([lineTexts[0].slice(5), ...lineTexts.slice(1, 4), lineTexts[4].slice(0, 22)].join('\n'));
  }
  await goTo(6);
  const firstPhrase = line(/^Single column text continues into the/, 6);
  const secondPhrase = line(/^second half of the same line of prose/, 6);
  await drag(firstPhrase.first(), 0, secondPhrase.nth(2), 'second half'.length);
  await action('复制').click();
  await clipboard('Single column text continues into the second half of the same line of prose\n'.repeat(2) +
    'Single column text continues into the second half');

  // Opt in with a local copy of the reported document.
  if (process.env.PDFREADER_EVENTLENS_PDF) {
    await page.locator('input[type=file]').setInputFiles(process.env.PDFREADER_EVENTLENS_PDF);
    await expect(line(/^Abstract/).first()).toBeVisible({ timeout: 60000 });
    await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('page-fit');
    for (const [number, first, last, end, expected] of [
      [3, /^EventLens adopts a coarse-to/, /^address the limitations of existing/, 22,
        'EventLens adopts a coarse-to-fine hierarchical pipeline con-\nsisting of four synergistic stages, aiming to systematically\naddress the limitation'],
      [9, /^Fig\. 5\.$/, /^while only a subset is visualized/, 28,
        'Fig. 5. Qualitative comparisons on multiple-choice and open-ended video question answering. The top four examples are multiple-choice questions from\n' +
        'VideoMME, and the bottom two examples are open-ended questions from VideoEval-Pro. For each video, 64 frames are selected as the final visual input,\n' +
        'while only a subset is visua'],
      [14, /^alignment before projection/, /^and audio understanding in video-LLMs/, 18,
        'alignment before projection,” in Proc. Conf. Empirical Methods Natural\nLang. Process., 2024, pp. 5971–5984.\n' +
        '[13] Z. Cheng et al., “VideoLLaMA 2: Advancing spatial–temporal modeling\nand audio understa'],
      [15, /^MENT$/, /^vision, including person re-identi/, 17,
        'MENT, and AAAI. His long-term research focuses on human-centric computer\nvision, including'],
    ]) {
      await goTo(number);
      const start = line(first, number), finish = line(last, number);
      await expect(start).toBeVisible();
      await drag(start, 0, finish, end);
      await action('复制').click();
      await clipboard(expected);
    }
    console.log('Verified EventLens pages 3, 9, 14, and 15 by dragging and copying the selection.');
  }

  if (process.env.PDFREADER_DDHG_PDF) {
    await page.locator('input[type=file]').setInputFiles(process.env.PDFREADER_DDHG_PDF);
    const run = index => frame.locator('.page[data-page-number="1"] .textLayer span[dir]').nth(index);
    await expect(run(103)).toHaveText('Keywords:');
    await expect(run(563)).toHaveText('video.');
    const leftText = 'ideo Question Answering (VideoQA) is a classic interactive AI task\n' +
      'Li et al. (2022), Xiao et al. (2021), Xu et al. (2021), whose objective\n' +
      'is to answer the natural language questions based on the given video';
    const rightText = 'challenge Xiao et al. (2024). Some studies Bai et al. (2024), Xiao et al.\n' +
      '(2022b, 2023) opt to model the objects, their relations, and dynamics in\nvideos';
    let abstractText;
    async function copyRuns(first, start, last, end, containsBox) {
      await run(first).evaluate((span, last) => {
        const container = PDFViewerApplication.pdfViewer.container;
        const other = span.closest('.textLayer').querySelectorAll('span[dir]')[last];
        const y = (span.getBoundingClientRect().top + other.getBoundingClientRect().bottom) / 2;
        const view = container.getBoundingClientRect();
        container.scrollTop += y - view.top - view.height / 2;
      }, last);
      await drag(run(first), start, run(last), end);
      const boxes = await selection.locator(':scope > div').evaluateAll(marks => marks.map(mark => ({
        left: parseFloat(mark.style.left), right: parseFloat(mark.style.left) + parseFloat(mark.style.width),
      })));
      if (containsBox) assert.ok(boxes.length && boxes.every(containsBox));
      await page.evaluate(() => navigator.clipboard.writeText(''));
      await viewer.press('Control+c');
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(copied);
      return copied;
    }
    for (const scale of ['page-fit', '1', '1.25', 'page-width']) {
      await frame.locator('body').evaluate(value => { PDFViewerApplication.pdfViewer.currentScaleValue = value; }, scale);
      const abstract = await copyRuns(116, 0, 485, 10, box => box.left > 33);
      assert.match(abstract, /^Recently, Video Question Answering/);
      assert.match(abstract, /state-of-the-art approaches$/);
      assert.equal(abstract.split('\n').length, 14);
      abstractText ??= abstract;
      assert.equal(abstract, abstractText);
      assert.equal(await copyRuns(485, 10, 116, 0, box => box.left > 33), abstractText);
      assert.equal(await copyRuns(103, 0, 114, 8, box => box.right < 24),
        'Keywords:\nVideo question answering\nVideo-language\nGraph neural network.');
      assert.equal(await copyRuns(489, 1, 563, 5, box => box.right < 49), leftText);
      assert.equal(await copyRuns(897, 0, 954, 6, box => box.left > 51), rightText);
      assert.equal(await copyRuns(882, 1, 897, 5), 'pen\nchall');
      assert.equal(await copyRuns(485, 0, 488, 5), 'approaches.\n1. Intro');
    }
    console.log('Verified the DDHG sidebar, abstract, and introduction at four zoom levels.');
  }

  await page.getByRole('tab', { name: 'precise-selection.pdf' }).click();
  await expect(leftFirst).toBeVisible({ timeout: 60000 });
  await button('上一页').waitFor();
  await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('page-fit');
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.currentScaleValue)).toBe('page-fit');

  const second = await point(leftSecond, 'Left second line page 1'.length);
  const right = await point(line('Right second line page 1'), 0);
  await drag(leftFirst, 5, leftSecond, 11, { x: (second.x + right.x) / 2, y: second.y });
  await expect(menu).toBeVisible();
  await expect(leftFirst).toHaveAttribute('data-pdfreader-block', 'body');
  await expect(line('Journal running header')).toHaveAttribute('data-pdfreader-block', 'header');
  await expect(line('Journal footer label')).toHaveAttribute('data-pdfreader-block', 'footer');
  await expect(line('1. Footnote details')).toHaveAttribute('data-pdfreader-block', 'footnote');
  await expect(line('Figure 1. A separate caption')).toHaveAttribute('data-pdfreader-block', 'figure-caption');
  await expect(line('Table 1: Another caption')).toHaveAttribute('data-pdfreader-block', 'table-caption');
  const expected = 'first line page 1\nLeft second';
  await action('复制').click();
  await clipboard(expected);
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await viewer.press('Control+c');
  await clipboard(expected);

  await openAt(leftFirst, 9);
  await action('翻译').click();
  await expect.poll(() => page.evaluate(() => window.calls.at(-1)?.text)).toBe('first line page 1 Left second');
  await button('关闭翻译').click();

  await openAt(leftFirst, 9);
  await action('下划线').click();
  await expect(page.locator('.document-tab.selected .dirty-dot')).toBeVisible();
  const initialMark = await frame.locator('body').evaluate(() => [...PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values()][0]);
  assert.equal(initialMark.markup, 'underline');
  const quads = Object.values(initialMark.quadPoints);
  assert.equal(quads.length, 16);
  assert.ok(quads.every((coordinate, index) => index % 2 || coordinate < 337));

  const caption = line('Figure 1. A separate caption'), continuedCaption = line('Continuation of the figure caption');
  await drag(caption, 0, continuedCaption, 12);
  await openAt(caption, 6);
  await action('复制').click();
  await clipboard('Figure 1. A separate caption\nContinuation');

  const taggedCaption = line('An accessible caption'), taggedContinuation = line('Second tagged line');
  await drag(taggedCaption, 0, taggedContinuation, 13);
  await expect(taggedCaption).toHaveAttribute('data-pdfreader-block', 'caption');
  await expect(taggedContinuation).toHaveAttribute('data-pdfreader-block', 'caption');
  await openAt(taggedCaption, 6);
  await action('复制').click();
  await clipboard('An accessible caption\nSecond tagged');

  const footnote = line('1. Footnote details'), continuedFootnote = line('Continuation of the footnote');
  await drag(footnote, 0, continuedFootnote, 12);
  await openAt(footnote, 6);
  await action('复制').click();
  await clipboard('1. Footnote details\nContinuation');

  await button('阅读工具').click();
  await button('更多 PDF 工具').click();
  await button('水平滚动').click();
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.scrollMode)).toBe(1);
  await frame.locator('body').evaluate(() => { PDFViewerApplication.pdfViewer.currentScaleValue = '0.55'; });
  const rightSecond = line('Right second line page 1');
  const pageTwo = line('Left first line page 2', 2);
  await expect(pageTwo).toBeVisible();
  await drag(rightSecond, 6, pageTwo, 10);
  await openAt(pageTwo, 6);
  await action('复制').click();
  await clipboard('second line page 1\n\nLeft first');

  await button('阅读工具').click();
  await button('更多 PDF 工具').click();
  await button('垂直滚动').click();
  await button('阅读工具').click();
  await button('旋转页面').click();
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.pagesRotation)).toBe(90);
  const pageInput = page.getByRole('textbox', { name: '页码' });
  await pageInput.fill('1');
  await pageInput.press('Enter');
  await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('page-fit');
  await expect(frame.locator('.page[data-page-number="1"] .textLayer')).toHaveAttribute('data-main-rotation', '90');
  await leftFirst.scrollIntoViewIfNeeded();
  await drag(leftFirst, 5, leftSecond, 11);
  await openAt(leftFirst, 9);
  await action('删除线').click();
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfDocument.annotationStorage.size)).toBe(2);

  await page.evaluate(() => {
    window.showSaveFilePicker = async () => ({ name: 'precise-selected.pdf', createWritable: async () => ({
      write: async blob => { window.exportBytes = [...new Uint8Array(await blob.arrayBuffer())]; },
      close: async () => {}, abort: async () => {},
    }) });
  });
  await button('导出').click();
  await expect(page.getByRole('status').filter({ hasText: '已导出' })).toBeVisible();
  const destination = 'test-results/workspace/precise-selected.pdf';
  await writeFile(destination, Buffer.from(await page.evaluate(() => window.exportBytes)));
  execFileSync('python', ['-c', `
from pypdf import PdfReader
import sys
marks = [item.get_object() for item in PdfReader(sys.argv[1]).pages[0]['/Annots']]
assert [mark['/Subtype'] for mark in marks] == ['/Underline', '/StrikeOut']
assert all(len(mark['/QuadPoints']) == 16 and max(mark['/QuadPoints'][::2]) < 337 for mark in marks)
assert all(abs(a-b) < 0.8 for a, b in zip(marks[0]['/QuadPoints'], marks[1]['/QuadPoints']))
`, destination]);

  await button('批注工具').click();
  await button('高亮').click();
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode)).toBe(9);
  const highlightStart = await point(leftFirst, 5), highlightEnd = await point(leftSecond, 11);
  await page.mouse.move(highlightStart.x, highlightStart.y);
  await page.mouse.down();
  await page.mouse.move(highlightEnd.x, highlightEnd.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => frame.locator('body').evaluate(() =>
    [...PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values()].at(-1).quadPoints.length)).toBe(16);
  await expect(selection).toHaveCount(0);
  await button('批注工具').click();
  await button('选择文字').click();
  await button('导出').click();
  await expect(page.locator('.document-tab.selected .dirty-dot')).toBeHidden();

  await page.locator('input[type=file]').setInputFiles('public/pdfjs/web/compressed.tracemonkey-pldi-09.pdf');
  const abstractStart = line(/^Dynamic languages such as JavaScript are/);
  const abstractNext = line(/^pile than statically typed ones/);
  await expect(abstractStart).toBeVisible({ timeout: 60000 });
  await page.getByRole('combobox', { name: '缩放', exact: true }).selectOption('page-fit');
  await expect.poll(() => frame.locator('body').evaluate(() => PDFViewerApplication.pdfViewer.currentScaleValue)).toBe('page-fit');
  await drag(abstractStart, 8, abstractNext, 9);
  await openAt(abstractStart, 12);
  await action('复制').click();
  await clipboard('languages such as JavaScript are more difficult to com-\npile than');

  await button('生成引文').click();
  let citation = page.getByRole('dialog', { name: '生成引文' });
  await expect(citation.getByLabel('标题', { exact: true })).toHaveValue('Trace-based Just-in-Time Type Specialization for Dynamic Languages');
  await expect(citation.getByText('标题来自首页版面，请核对。')).toBeVisible();
  await expect(citation.getByLabel('出版年')).toHaveValue('');
  await button('关闭引文').click();

  await page.getByRole('tab', { name: 'precise-selection.pdf' }).click();
  await drag(leftFirst, 7, leftFirst, 15);
  await expect(menu).toBeVisible();
  const menuBounds = await menu.boundingBox(), frameBounds = await iframe.boundingBox();
  assert.ok(menuBounds.x >= frameBounds.x && menuBounds.x + menuBounds.width <= frameBounds.x + frameBounds.width);
  assert.ok(menuBounds.y >= frameBounds.y && menuBounds.y + menuBounds.height <= frameBounds.y + frameBounds.height);
  await action('引文').click();
  citation = page.getByRole('dialog', { name: '生成引文' });
  await expect(citation.getByLabel('标题', { exact: true })).toHaveValue('Geometry and Reading Order');
  await expect(citation.getByLabel('出版年')).toHaveValue('2025');
  await expect(citation.getByLabel('DOI', { exact: true })).toHaveValue('10.1234/layout.2025');
  await expect(citation.getByText('DOI 来自首页文字，请核对。')).toBeVisible();
  const preview = citation.getByLabel('引文预览');
  await expect(preview).toHaveValue('Chen, M., & Lin, B. (2025). Geometry and Reading Order. Journal of Example Layouts, 12(3), 15–26. https://doi.org/10.1234/layout.2025');
  await citation.getByLabel('引文格式').selectOption('IEEE');
  await expect(preview).toHaveValue(/M\. Chen and B\. Lin.*vol\. 12, no\. 3, pp\. 15–26, 2025/u);
  await citation.getByLabel('引文格式').selectOption('GB/T 7714');
  await expect(preview).toHaveValue(/CHEN M, LIN B\. Geometry and Reading Order\[J\]/u);
  await citation.getByLabel('引文格式').selectOption('BibTeX');
  await citation.getByLabel('标题', { exact: true }).fill('Geometry & Reading');
  await expect(preview).toHaveValue(/@article\{chen2025geometry,.*title = \{Geometry \\& Reading\}/su);
  const bibtex = await preview.inputValue();
  await button('复制引文').click();
  await clipboard(bibtex);
  assert.equal(await page.evaluate(() => window.calls.length), 1);
  await button('关闭引文').click();

  await button('设置').click();
  const appearance = page.getByRole('dialog', { name: '设置' });
  const mode = appearance.getByLabel('界面主题');
  await mode.selectOption('system');
  await appearance.getByRole('radio', { name: '紫色' }).check();
  await appearance.getByLabel('拖选结束后显示操作栏').uncheck();
  await button('关闭设置').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(frame.locator('html')).toHaveAttribute('data-accent', 'violet');
  assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--accent-dark')), '#c5acff');
  await expect(frame.locator('html')).toHaveCSS('accent-color', 'rgb(197, 172, 255)');
  await drag(leftFirst, 7, leftFirst, 15);
  await expect(menu).toBeHidden();
  await viewer.press('Shift+F10');
  await expect(action('复制')).toBeFocused();
  await action('复制').press('ArrowRight');
  await expect(action('高亮')).toBeFocused();
  await viewer.press('Escape');
  await expect(menu).toBeHidden();

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pdfreader.local-v1.state.')).data.layout))
    .toMatchObject({ theme: 'system', accent: 'violet' });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'violet');
  await button('设置').click();
  await expect(mode).toHaveValue('system');
  await expect(appearance.getByLabel('拖选结束后显示操作栏')).not.toBeChecked();
  await mode.selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  assert.deepEqual(errors, []);
  console.log('Verified narrow column drags, caption isolation, intentional column changes, rotated markup, citations, and appearance.');
} finally {
  await browser?.close();
  await server.close();
}
