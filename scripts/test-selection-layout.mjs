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
