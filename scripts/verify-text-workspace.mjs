import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = 'http://127.0.0.1:1432';
const server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'preview', '--port', '1432', '--strictPort']);
server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ai0AAAAASUVORK5CYII=';
const source = [
  '# 研究笔记', '', '价格 $10 和 $20。', '',
  String.raw`行内 \(\alpha_1 + \mathbf{v}\) 和 \\(\mathrm{e}^x\\)。`, '',
  String.raw`\[\begin{bmatrix}1 & 2\\3 & 4\end{bmatrix}\]`, '',
  String.raw`错误 \(\unknown{a}\)`, '', '未闭合 $x^2', '',
  '| 表格 | 测试 |', '| --- | --- |', '| a | b |', '',
  '- [x] 任务', '', '```js', '  const amount = "$20";' + ' '.repeat(240) + '// end', '```', '',
  '```unknown', '  raw $x$', '```', '', '![缺图](<例子.assets/不存在 的图片.png>)',
  '![远程](https://example.invalid/note.png)',
].join('\n');
let browser;

try {
  await expect.poll(async () => fetch(base).then(response => response.ok, () => false), { timeout: 15_000 }).toBe(true);
  browser = await chromium.launch(process.env.PDFREADER_CHROMIUM
    ? { executablePath: process.env.PDFREADER_CHROMIUM }
    : process.platform === 'win32' ? { channel: 'msedge' } : {});
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  let remoteLoads = 0;
  await context.route('https://example.invalid/note.png', route => {
    remoteLoads++;
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') });
  });
  await context.addInitScript(({ source, png }) => {
    const callbacks = new Map(), events = new Map(), disk = new Map(), images = new Map();
    const saved = [];
    let next = 0;
    const markdown = 'C:/samples/例子.markdown';
    const legacy = 'C:/samples/旧文本.txt';
    disk.set(markdown, { name: '例子.markdown', path: markdown, revision: 'source', encoding: 'UTF-8', bom: false, content: source, assetsDir: '例子.assets' });
    window.fixture = { disk, nextOpen: [markdown], nextSave: '', saved, emit: (event, payload) => events.get(event)?.({ payload }) };
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: fn => { callbacks.set(++next, fn); return next; },
      async invoke(command, args) {
        switch (command) {
          case 'plugin:event|listen': events.set(args.event, callbacks.get(args.handler)); return args.handler;
          case 'plugin:window|is_maximized': return false;
          case 'local_read': return { version: 1, revision: 0, data: null };
          case 'local_write': return { version: 1, revision: 1, data: args.data };
          case 'startup_pdfs': return { paths: [], errors: [] };
          case 'choose_documents': return window.fixture.nextOpen;
          case 'read_text':
            if (args.path === legacy) return {
              name: '旧文本.txt', path: legacy, revision: 'legacy', encoding: args.encoding ?? null, bom: false,
              content: args.encoding ? '旧文本\r\n第二行' : null, assetsDir: '旧文本.assets',
            };
            return disk.get(args.path);
          case 'choose_text_destination':
            return window.fixture.nextSave ? { path: window.fixture.nextSave, revision: disk.get(window.fixture.nextSave)?.revision ?? null } : null;
          case 'read_text_image': {
            const image = images.get(args.path + '|' + args.relative);
            if (image) return image;
            throw new Error('missing');
          }
          case 'read_dropped_image': return { name: '拖入 图片.png', mime: 'image/png', data: png };
          case 'store_text_image': {
            const folder = disk.get(args.path).assetsDir;
            images.set(args.path + '|' + folder + '/' + args.name, { mime: 'image/png', data: args.data });
            return args.name;
          }
          case 'save_text': {
            const { path, expectedRevision, sourcePath, parts, links, attachments, encoding, bom } = args.request;
            if ((disk.get(path)?.revision ?? null) !== expectedRevision) throw new Error('保存冲突');
            const name = path.split('/').at(-1), assetsDir = name.replace(/\.[^.]+$/, '') + '.assets';
            const urls = attachments.map(({ kind, name, data }, index) => {
              if (kind === 'copy') data = images.get(sourcePath + '|' + disk.get(sourcePath).assetsDir + '/' + name).data;
              const filename = index && attachments.slice(0, index).some(file => file.name === name)
                ? name.replace(/\.(\w+)$/, `-${index + 1}.$1`) : name;
              const relative = assetsDir + '/' + filename;
              images.set(path + '|' + relative, { mime: 'image/png', data });
              return '<' + relative + '>';
            });
            const content = parts.map((part, index) => index ? urls[links[index - 1]] + part : part).join('');
            const result = { name, path, assetsDir, revision: 'rev-' + ++next, urls };
            disk.set(path, { ...result, encoding, bom, content });
            saved.push(args.request);
            return result;
          }
          default: throw new Error('Unexpected IPC: ' + command);
        }
      },
    };
  }, { source, png });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  const button = name => page.getByRole('button', { name, exact: true });
  const tab = name => page.getByRole('tab', { name, exact: true });
  const editor = kind => page.getByRole('textbox', { name: kind + ' 编辑器', exact: true });
  const selectSave = path => page.evaluate(path => { window.fixture.nextSave = path; }, path);
  const newTab = async kind => {
    await button('新建或打开文档').click();
    await button('新建 ' + kind).click();
  };

  await page.locator('input[type=file]').setInputFiles(resolve('docs/assets/research-notes.pdf'));
  await expect(tab('research-notes.pdf')).toHaveAttribute('aria-selected', 'true');
  await newTab('TXT');
  const txt = editor('TXT');
  await txt.fill('# 原样 $20 `代码`\n找我');
  await expect(page.locator('footer')).toContainText('UTF-8');
  await txt.press('Control+f');
  await page.getByRole('textbox', { name: '查找', exact: true }).fill('找我');
  await page.getByRole('textbox', { name: '替换', exact: true }).fill('已替换');
  await button('全部替换').click();
  await button('关闭查找').click();
  await expect(txt).toContainText('已替换');
  await txt.press('Control+z');
  await expect(txt).toContainText('找我');
  await txt.press('Control+y');
  await expect(txt).toContainText('已替换');
  await selectSave('C:/samples/原样.txt');
  await txt.press('Control+s');
  await expect(tab('原样.txt')).toBeVisible();
  assert.equal(await page.evaluate(() => window.fixture.disk.get('C:/samples/原样.txt').content), '# 原样 $20 `代码`\n已替换');
  await txt.press('End');
  await page.keyboard.insertText(' 草稿');
  await page.evaluate(() => { window.fixture.disk.get('C:/samples/原样.txt').revision = 'external'; });
  await txt.press('Control+s');
  await expect(page.getByRole('alert')).toContainText('保存冲突');
  await button('关闭 原样.txt').click();
  await expect(page.getByRole('dialog', { name: '有尚未保存的修改' })).toBeVisible();
  await button('取消').click();
  await expect(txt).toContainText('草稿');
  await selectSave('C:/copies/草稿.txt');
  await button('另存为').click();
  await expect(tab('草稿.txt')).toBeVisible();

  await page.evaluate(() => window.fixture.emit('pdfs-dropped', ['C:/samples/旧文本.txt']));
  await expect(page.getByRole('dialog', { name: '选择文件编码' })).toBeVisible();
  await button('打开').last().click();
  await expect(editor('TXT')).toContainText('旧文本');
  await expect(page.locator('footer')).toContainText('GB18030 · CRLF');

  await button('打开').click();
  await expect(tab('例子.markdown')).toHaveAttribute('aria-selected', 'true');
  const preview = page.getByRole('article', { name: 'Markdown 预览' });
  await expect(preview.locator('.katex')).toHaveCount(3);
  await expect(preview).toContainText('价格 $10 和 $20。');
  await expect(preview).toContainText(String.raw`\(\unknown{a}\)`);
  await expect(preview).toContainText('未闭合 $x^2');
  await expect(preview.locator('table')).toBeVisible();
  await expect(preview.locator('code.language-js .hljs-keyword')).toHaveText('const');
  await expect(preview.locator('code.language-unknown')).toContainText('raw $x$');
  assert.equal(await preview.locator('pre').first().evaluate(node => node.scrollWidth > node.clientWidth), true);
  await preview.getByRole('button', { name: '复制代码' }).first().click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^  const amount = "\$20"; /);
  await expect(preview).toContainText('不存在 的图片.png');
  assert.equal(remoteLoads, 0);
  await button('加载网络图片 · 远程').click();
  await expect(preview.getByRole('img', { name: '远程' })).toBeVisible();
  assert.equal(remoteLoads, 1);
  await button('编辑').click();
  const md = editor('Markdown');
  assert.equal(await md.locator('.cm-line').evaluateAll(lines => lines.map(line => line.textContent).join('\n')), source);
  await md.press('Control+Home');
  await page.keyboard.insertText('草稿 ');
  await button('左右分栏').click();
  await md.press('Control+z');
  assert.equal(await md.locator('.cm-line').evaluateAll(lines => lines.map(line => line.textContent).join('\n')), source);

  await newTab('Markdown');
  await button('左右分栏').click();
  for (let index = 0; index < 2; index++) {
    await md.evaluate((element, png) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], '实验 结果.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png);
    await expect(preview.getByRole('img', { name: '实验 结果' })).toHaveCount(index + 1);
  }
  await selectSave('C:/samples/论文 笔记.md');
  await md.press('Control+s');
  await expect(tab('论文 笔记.md')).toBeVisible();
  await expect(md).toContainText('论文 笔记.assets/实验 结果-2.png');
  await page.evaluate(() => window.fixture.emit('images-dropped', { paths: ['C:/samples/拖入 图片.png'], x: 0, y: 0 }));
  await expect(md).toContainText('论文 笔记.assets/拖入 图片.png');
  await selectSave('C:/copies/另存 笔记.markdown');
  await button('另存为').click();
  await expect(tab('另存 笔记.markdown')).toBeVisible();
  await expect(md).toContainText('另存 笔记.assets/实验 结果.png');
  await expect(preview.getByRole('img')).toHaveCount(3);
  assert.equal(await page.evaluate(() => window.fixture.saved.at(-1).attachments.length), 3);
  await tab('research-notes.pdf').click();
  await expect(page.getByRole('button', { name: '导出' })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log('Text workspace browser checks passed (mocked native file IPC, real CodeMirror, Markdown and PDF.js).');
} finally {
  await browser?.close();
  server.kill();
}
