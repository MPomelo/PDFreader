import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prepareMarkdown, plainText } from '../src/translation/markdown.ts';
import { StreamAccumulator, RequestGate } from '../src/translation/client.ts';
import { panelLayout, parseWidths } from '../src/ui/panel-widths.ts';

mkdirSync('.local', { recursive: true });
await build({ entryPoints: ['src/translation/MarkdownRenderer.tsx'], outfile: '.local/stage04-renderer.mjs', bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'test-css', setup(plugin) { plugin.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'test-css' })); plugin.onLoad({ filter: /.*/, namespace: 'test-css' }, () => ({ contents: '', loader: 'js' })); } }] });
const { MarkdownRenderer } = await import(pathToFileURL(resolve('.local/stage04-renderer.mjs')).href);
const render = source => renderToStaticMarkup(React.createElement(MarkdownRenderer, { source }));

test('math, GFM tables, lists, fractions, matrices, aligned equations and code share one renderer', () => {
  const source = String.raw`## 实验

- 行内 $x_i^2 + \alpha$。
- 分式 $\frac{a}{b}$。

$$
\begin{aligned}
L &= \sum_{i=1}^{n} x_i \\
A &= \begin{bmatrix}1&2\\3&4\end{bmatrix}
\end{aligned}
$$

| 模型 | 指标 |
| --- | --- |
| DANN | 0.92 |

> 引用与 **加粗**

\(y = \beta_1\)

\[z = \frac{1}{2}\]
`;
  const html = render(source);
  for (const token of ['<table', '<ul', '<blockquote', 'katex-mathml', 'mfrac', 'mtable', '<strong>']) assert.ok(html.includes(token), token);
  assert.ok(!html.includes('katex-error'));
});
test('all prefixes of a valid formula avoid premature KaTeX errors and retain its source tail', () => {
  const formula = String.raw`Before $\frac{\alpha_1}{x^2}$ after`;
  for (let i = 0; i <= formula.length; ++i) {
    const prefix = formula.slice(0, i); const prepared = prepareMarkdown(prefix);
    assert.ok(!render(prefix).includes('katex-error'), prefix);
    if (prepared.tail) assert.ok(prefix.endsWith(prepared.tail));
  }
  assert.equal(prepareMarkdown(String.raw`before \[\frac{a}`).tail, String.raw`\[\frac{a}`);
});
test('code, escape sequences, money and Markdown/LaTeX source survive render-only normalization', () => {
  const source = 'Costs $5 and $10. `\\(code\\)`\n\n```tex\n$x$ \\[literal\\]\n```';
  const normalized = prepareMarkdown(source);
  assert.equal(normalized.tail, ''); assert.ok(normalized.markdown.includes('```tex\n$x$ \\[literal\\]\n```'));
  const html = render(source); assert.ok(!html.includes('class="katex"')); assert.ok(html.includes('$5 and $10'));
  assert.equal(plainText('**bold** and $x_1$\n\n- item'), 'bold and x_1\nitem');
  const chineseMoney = render('金额 $5、$10。\n\n$$\nx^2\n$$');
  assert.ok(chineseMoney.includes('$5、$10')); assert.equal((chineseMoney.match(/class="katex-display"/g) || []).length, 1);
  assert.ok(render('$5 + 3$').includes('class="katex"'));
});
test('invalid formulas fail locally while valid formulas in the same answer still render', () => {
  const html = render(String.raw`Bad $\frac{1}{$.

Good $\frac{1}{2}$.`);
  assert.ok(html.includes('katex-error')); assert.ok(html.includes('mfrac')); assert.ok(html.includes('frac'));
  const unclosed = render(String.raw`Bad $\frac{1}{

Good $\frac{1}{2}$.`);
  assert.ok(unclosed.includes('<pre>')); assert.ok(unclosed.includes('mfrac'));
});
test('raw HTML, unsafe links and remote images cannot execute or fetch through the renderer', () => {
  const html = render('<script>alert(1)</script>\n\n![tracking](https://example.com/pixel.png)\n\n[x](javascript:alert%281%29)\n\n$\\includegraphics{https://example.com/math.png}$');
  assert.ok(!html.includes('<script')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('href="javascript:')); assert.ok(!html.includes('src="https://'));
});
test('stream ordering ignores duplicates, separates thinking, and rejects gaps and malformed events', () => {
  const stream = new StreamAccumulator();
  const first = { requestId: 'one', documentId: 'doc', seq: 1, content: '中文', reasoning: 'thought' };
  assert.equal(stream.push(first), true); assert.equal(stream.push(first), false);
  stream.push({ ...first, seq: 2, content: ' $x$', reasoning: '' });
  assert.equal(stream.text, '中文 $x$'); assert.equal(stream.reasoning, 'thought');
  assert.throws(() => stream.push({ ...first, seq: 4 }), /顺序/);
  assert.throws(() => stream.push({ ...first, seq: NaN }), /格式/);
});
test('late A stream chunks after B/cancel/document changes cannot commit', () => {
  const gate = new RequestGate(async () => {}); const a = gate.begin('A'); const b = gate.begin('B');
  assert.equal(gate.accepts(a, 'A'), false); assert.equal(gate.accepts(b, 'B'), true);
  gate.invalidate(); assert.equal(gate.accepts(b, 'B'), false);
});
test('panel widths clamp corrupted preferences and preserve a readable desktop PDF region', () => {
  assert.deepEqual(parseWidths('broken'), { left: 220, right: 340 });
  assert.deepEqual(parseWidths('{"left":10000,"right":-20}'), { left: 400, right: 280 });
  for (const viewport of [1001, 1280, 1920]) {
    const layout = panelLayout({ left: 400, right: 720 }, viewport, true, true);
    assert.ok(viewport - layout.left - layout.right >= 360);
  }
  const hidden = panelLayout({ left: 300, right: 500 }, 1280, false, false); assert.equal(hidden.left + hidden.right, 0);
  assert.equal(panelLayout({ left: 220, right: 720 }, 720, true, true).overlay, true);
});
