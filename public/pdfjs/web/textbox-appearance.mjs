// Share the same font and line metrics between the editor and its PDF appearance.
export const textBoxFont = '"Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
export const textBoxLineHeight = 1.35;

function wrapParagraph(ctx, paragraph, width) {
  // Use Unicode word boundaries where available; fall back to graphemes for long words.
  const words = new Intl.Segmenter(undefined, { granularity: 'word' });
  const letters = new Intl.Segmenter();
  const lines = [];
  let line = '';
  for (const { segment } of words.segment(paragraph)) {
    if (ctx.measureText(line + segment).width <= width) {
      line += segment;
      continue;
    }
    if (line) lines.push(line.trimEnd());
    line = '';
    if (!segment.trim()) continue;
    for (const { segment: letter } of letters.segment(segment)) {
      if (line && ctx.measureText(line + letter).width > width) {
        lines.push(line);
        line = '';
      }
      line += letter;
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

// A one-bit PDF image mask keeps the glyphs transparent and uses the annotation's
// PDF fill color. Unicode text is also stored independently in /Contents.
export function textBoxMask(value, fontSize, width, height) {
  const density = Math.min(5, 3072 / Math.max(width, height));
  const w = Math.max(1, Math.ceil(width * density)), h = Math.max(1, Math.ceil(height * density));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.scale(w / width, h / height);
  ctx.font = `${fontSize}px ${textBoxFont}`;
  ctx.textBaseline = 'top';
  const lines = value.split('\n').flatMap(line => wrapParagraph(ctx, line, width));
  const spacing = Math.min(fontSize * textBoxLineHeight, height / lines.length);
  for (const [i, line] of lines.entries()) ctx.fillText(line, 0, i * spacing, width);
  const pixels = ctx.getImageData(0, 0, w, h).data;
  const hex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
  const rows = [];
  for (let y = 0; y < h; y++) {
    let bits = '';
    for (let x = 0; x < w; x += 8) {
      let byte = 0;
      for (let b = 0; b < 8 && x + b < w; b++) {
        if (pixels[4 * (y * w + x + b) + 3] >= 100) byte |= 128 >> b;
      }
      bits += hex[byte];
    }
    rows.push(bits);
  }
  return `BI /W ${w} /H ${h} /IM true /BPC 1 /D [1 0] /F /AHx ID\n${rows.join('\n')}>\nEI`;
}
