import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSelectionText } from '../public/pdfjs/web/selection-text.mjs';

test('reported abstract becomes one paragraph with ordinary fi letters', () => {
  const selected = `Abstract—This work aims to learn video object segmentation
(mask propagation) in a self-supervised manner. We develop a
uniﬁed framework which simultaneously models cross-frame dense
correspondence for locally discriminative feature learning and
embeds object-level context for target-mask decoding. As a result,
it is able to directly learn to perform mask-guided sequential
segmentation from unlabeled videos, in contrast to previous efforts
usually relying on an oblique solution — cheaply “copying” labels
according to pixel-wise correlations.`;
  const expected = 'Abstract—This work aims to learn video object segmentation (mask propagation) in a self-supervised manner. We develop a unified framework which simultaneously models cross-frame dense correspondence for locally discriminative feature learning and embeds object-level context for target-mask decoding. As a result, it is able to directly learn to perform mask-guided sequential segmentation from unlabeled videos, in contrast to previous efforts usually relying on an oblique solution — cheaply “copying” labels according to pixel-wise correlations.';
  assert.equal(normalizeSelectionText(selected), expected);
});

test('explicit paragraph boundaries survive while PDF padding collapses', () => {
  assert.equal(normalizeSelectionText('  First\u00A0  line.\r\n Next line.\r\n \t\r\nSecond\t paragraph.  '), 'First line. Next line.\n\nSecond paragraph.');
});

test('preserves scientific symbols instead of broad compatibility normalization', () => {
  assert.equal(normalizeSelectionText('x² + αᵢ = ½\n① ﬁnal ﬂow'), 'x² + αᵢ = ½ ① final flow');
});

test('compound words keep explicit hyphens and discretionary hyphens disappear', () => {
  assert.equal(normalizeSelectionText('self-\nsupervised and cross-\nframe segmen\u00AD\ntation'), 'self-supervised and cross-frame segmentation');
});

test('Chinese layout wraps do not insert spaces between characters', () => {
  assert.equal(normalizeSelectionText('视频目标\n分割方法。\n\n另一段。'), '视频目标分割方法。\n\n另一段。');
});

test('empty selections stay empty and cleanup is idempotent', () => {
  assert.equal(normalizeSelectionText(' \n\t '), '');
  const text = 'First line.\n\nSecond ﬁnal line.';
  assert.equal(normalizeSelectionText(normalizeSelectionText(text)), normalizeSelectionText(text));
});
