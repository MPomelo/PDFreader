import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutLines, lineText } from '../public/pdfjs/web/selection-layout.mjs';

function text(value, x, y, pageWidth, advance = 6, height = 10) {
  return { text: value, x: x / pageWidth, y: y / 792, width: value.length * advance / pageWidth, height: height / 792, dir: 'ltr' };
}

test('column boundaries adapt to local glyphs across page widths and gutter sizes', () => {
  const leftText = 'Representative left column text fills the page';
  const rightText = 'Independent right column text fills the page';
  for (const pageWidth of [612, 842]) {
    for (const gap of [3, 4, 6, 9, 12, 18, 24, 36, 48]) {
      const start = pageWidth / 2 - 6 * leftText.length;
      const runs = [text('A heading that crosses the column boundary', start, 95, pageWidth, 14, 23)];
      for (let row = 0; row < 12; row++) {
        const y = 160 + row * 14;
        // Two paragraph endings supply evidence independent of the gutter width.
        runs.push(text(row === 3 || row === 7 ? leftText.slice(0, -7) : leftText, start, y, pageWidth));
        runs.push(text(rightText, pageWidth / 2 + gap, y + row % 2 * 4, pageWidth));
      }
      const { lines, gutter } = layoutLines(runs.reverse());
      const label = `${gap} point gutter on a ${pageWidth} point page`;
      assert.ok(gutter && gutter.split > 0.5 && gutter.split < 0.5 + gap / pageWidth, label);
      assert.equal(lines[0].column, null, label);
      assert.deepEqual(lines.slice(1).map(line => line.column), [...Array(12).fill('left'), ...Array(12).fill('right')], label);
    }
  }
});

test('an ordinary word space aligned on every row keeps single-column reading order', () => {
  const before = 'A long phrase on every line is followed';
  const after = 'by the rest of the same line of prose';
  const runs = Array.from({ length: 12 }, (_, row) => {
    const y = 140 + row * 14;
    return [text(before, 64, y, 612), text(after, 64 + (before.length + 1) * 6, y, 612)];
  }).flat();
  const { lines, gutter } = layoutLines(runs);
  assert.equal(gutter, null);
  assert.deepEqual(lines.map(line => lineText(line.items)), Array(12).fill(`${before} ${after}`));
});

const leftColumn = 'Left column text running nearly to the gutter';
const rightColumn = 'Right column text stays in its own paragraph';

test('an established column boundary extends through adjacent lines at the bottom edge', () => {
  const runs = Array.from({ length: 10 }, (_, row) => [
    text(leftColumn, 48, 630 + row * 12, 612, 5.6),
    text(rightColumn, 312, 630 + row * 12, 612, 5.6),
  ]).flat();
  const { lines } = layoutLines(runs);
  assert.deepEqual(lines.map(line => line.column), [...Array(10).fill('left'), ...Array(10).fill('right')]);
  assert.deepEqual(lines.slice(0, 10).map(line => lineText(line.items)), Array(10).fill(leftColumn));
});

test('reference numbers belong to the same column as their hanging paragraphs', () => {
  const runs = Array.from({ length: 16 }, (_, row) => {
    const y = 150 + row * 11;
    const left = text(row % 4 ? leftColumn : leftColumn.slice(0, -9), 48, y, 612, 5.6);
    const right = text(rightColumn, 332, y, 612, 5.6);
    return row % 3 ? [left, text('[42]', 312, y, 612, 4), right] : [left, right];
  }).flat();
  const { lines, gutter } = layoutLines(runs);
  assert.ok(gutter.split < 312 / 612);
  assert.deepEqual(lines.filter(line => line.column === 'left').map(line => lineText(line.items)),
    Array.from({ length: 16 }, (_, row) => row % 4 ? leftColumn : leftColumn.slice(0, -9)));
  assert.ok(lines.filter(line => lineText(line.items).startsWith('[42]')).every(line => line.column === 'right'));
});

test('aligned caption lines of the same size as the body form one selectable block', () => {
  const runs = [
    text('Fig. 5. An example showing how the selection continues from one line to another', 48, 380, 612),
    text('and includes a second line even when it is the same size as the surrounding text', 48, 392, 612),
    text('and a short closing line.', 48, 404, 612),
    text('A separate paragraph with the same type size begins below.', 48, 416, 612),
  ];
  const { lines } = layoutLines(runs);
  assert.deepEqual(lines.map(line => line.kind), ['figure-caption', 'figure-caption', 'figure-caption', 'body']);
  assert.equal(lines[1].block, lines[0]);
  assert.equal(lines[2].block, lines[0]);
});

test('a short last line keeps its full-width figure caption membership', () => {
  const runs = [
    text('Figure 4. The caption runs across the width of the page for more than one line.', 48, 200, 612),
    text('The middle line occupies nearly all the available width, even when followed by', 48, 212, 612),
    text('a much shorter last line.', 48, 224, 612),
  ];
  for (let row = 0; row < 12; row++) {
    runs.push(text(leftColumn, 48, 300 + row * 12, 612, 5.3));
    runs.push(text(rightColumn, 320, 300 + row * 12, 612, 5.3));
  }
  const { lines, gutter } = layoutLines(runs);
  assert.ok(gutter);
  const caption = lines.filter(line => line.kind === 'figure-caption');
  assert.equal(caption.length, 3);
  assert.equal(caption[2].block, caption[0]);
  assert.ok(caption.every(line => line.column === null));
});

test('native line positions keep original text and fall back when a span is unaligned', () => {
  const first = text('Opening sentence', 48, 220, 612);
  const second = text('Separate caption', 48, 242, 612);
  const regions = [second, first].map(({ x, y, width, height }) => ({ x, y, width, height }));
  const native = layoutLines([second, first], undefined, regions);
  assert.ok(native.usedNative);
  assert.deepEqual(native.lines.map(line => line.items[0]), [second, first]);
  const fallback = layoutLines([second, first], undefined, regions.slice(0, 1));
  assert.equal(fallback.usedNative, false);
  assert.deepEqual(fallback.lines.map(line => line.items[0]), [first, second]);
});

test('a centered table number and title share a caption block', () => {
  const { lines } = layoutLines([
    text('TABLE II', 330, 400, 612),
    text('FINE-GRAINED RESULTS ON MULTIPLE TASKS', 246, 412, 612),
    text('Separate text below the table', 246, 444, 612),
  ]);
  assert.deepEqual(lines.map(line => line.kind), ['table-caption', 'table-caption', 'body']);
  assert.equal(lines[1].block, lines[0]);
});

test('table cell gaps carry less weight than the boundary between prose columns', () => {
  const runs = [];
  for (let row = 0; row < 20; row++) {
    for (const x of [140, 215, 295, 375, 455]) {
      runs.push(text('17.25', x, 145 + row * 11, 612));
    }
  }
  for (let row = 0; row < 10; row++) {
    runs.push(text(leftColumn, 48, 414 + row * 12, 612, 5.3));
    runs.push(text(rightColumn, 320, 414 + row * 12, 612, 5.3));
  }
  const { lines, gutter } = layoutLines(runs);
  assert.ok(gutter.split > 0.47 && gutter.split < 0.52);
  const prose = lines.filter(line => line.y > 0.5);
  assert.deepEqual(prose.map(line => line.column), [...Array(10).fill('left'), ...Array(10).fill('right')]);
});

test('a column can widen below an inset without crossing the body gutter', () => {
  const runs = [];
  for (let row = 0; row < 16; row++) {
    const y = 330 + row * 12;
    runs.push(text(leftColumn, 48, y, 612, 5.45));
    runs.push(text(rightColumn, row < 14 ? 405 : 312, y, 612, row < 14 ? 3.55 : 5.45));
  }
  const { lines, gutter } = layoutLines(runs);
  assert.ok(gutter.split < 312 / 612);
  assert.deepEqual(lines.map(line => line.column), [...Array(16).fill('left'), ...Array(16).fill('right')]);
});
