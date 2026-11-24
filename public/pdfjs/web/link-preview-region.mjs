const captionPattern = /(?:\b(?:fig(?:ure)?\.?|table)\s*|[图表]\s*)[a-z]?\d+(?:[.-]\d+)*(?![\w-])/gi;
const referenceStart = /^\s*(?:\[(\d+)\]|(\d+)[.)](?=\s))/;

function bounded(rect, { width, height }) {
  const [x1, y1, x2, y2] = rect;
  return [
    Math.max(0, Math.min(width, Math.min(x1, x2))),
    Math.max(0, Math.min(height, Math.min(y1, y2))),
    Math.max(0, Math.min(width, Math.max(x1, x2))),
    Math.max(0, Math.min(height, Math.max(y1, y2))),
  ];
}

function boxOf(lines, pad = 0) {
  return [
    Math.min(...lines.map(line => line.left)) - pad,
    Math.min(...lines.map(line => line.top)) - pad,
    Math.max(...lines.map(line => line.right)) + pad,
    Math.max(...lines.map(line => line.bottom)) + pad,
  ];
}

export async function resolveDestination(pdf, destination) {
  const dest = typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
  if (!Array.isArray(dest) || !dest[1]?.name) return null;
  const ref = dest[0];
  const pageNumber = Number.isInteger(ref) ? ref + 1
    : ref && typeof ref === 'object' ? (pdf.cachedPageNumber(ref) || (await pdf.getPageIndex(ref)) + 1) : 0;
  return pageNumber > 0 && pageNumber <= pdf.numPages ? { pageNumber, dest } : null;
}

export function destinationRegion(dest, viewport) {
  const { width, height } = viewport;
  const page = { kind: 'page', rect: [0, 0, width, height] };
  const mode = dest[1].name;
  if (mode === 'FitR' && dest.slice(2, 6).length === 4 && dest.slice(2, 6).every(Number.isFinite)) {
    const rect = bounded([
      ...viewport.convertToViewportPoint(dest[2], dest[3]),
      ...viewport.convertToViewportPoint(dest[4], dest[5]),
    ], viewport);
    if (rect[2] > rect[0] + 1 && rect[3] > rect[1] + 1) return { kind: 'region', rect };
  }
  const pdfX = ['XYZ', 'FitV', 'FitBV'].includes(mode) ? dest[2] : null;
  const pdfY = mode === 'XYZ' ? dest[3] : ['FitH', 'FitBH'].includes(mode) ? dest[2] : null;
  // An unrotated viewport converts axes independently, including the CropBox offset.
  const [vx, vy] = viewport.convertToViewportPoint(pdfX ?? 0, pdfY ?? 0);
  const x = Number.isFinite(pdfX) && vx >= 0 && vx <= width ? vx : null;
  const y = Number.isFinite(pdfY) && vy >= 0 && vy <= height ? vy : null;
  if (y !== null) {
    const band = Math.min(height, Math.max(112, Math.min(260, height * .3)));
    const top = Math.max(0, Math.min(height - band, y - band * .22));
    return { kind: 'anchor', x, y, rect: [0, top, width, top + band] };
  }
  if (x !== null && x > width * .08 && x <= width * .86) {
    const span = width * .64;
    const left = Math.max(0, Math.min(width - span, x - 16));
    return { kind: 'anchor', x, y, rect: [left, 0, left + span, height] };
  }
  return page;
}

function textRuns(items, viewport) {
  const unit = Math.hypot(viewport.transform[0], viewport.transform[1]);
  const runs = [];
  for (const item of items) {
    if (!item.str?.trim() || !item.transform || item.dir === 'ttb' || item.width <= 0) continue;
    const [a, b, c, d, x, y] = item.transform;
    if (Math.abs(b) > Math.abs(a) * .15 || Math.abs(c) > Math.abs(d) * .35) continue;
    const [left, baseline] = viewport.convertToViewportPoint(x, y);
    const size = Math.hypot(c, d) * unit;
    const right = left + item.width * unit;
    if (![left, right, baseline, size].every(Number.isFinite) || size < 1) continue;
    runs.push({ left, right, baseline, top: baseline - .95 * size, bottom: baseline + .25 * size, size, text: item.str.trim() });
  }
  return runs;
}

export function textLines(items, viewport) {
  const rows = [];
  for (const run of textRuns(items, viewport).sort((a, b) => a.baseline - b.baseline)) {
    const row = rows.at(-1);
    if (row && run.baseline - row.baseline <= Math.min(row.size, run.size) * .27) row.runs.push(run);
    else rows.push({ baseline: run.baseline, size: run.size, runs: [run] });
  }
  const lines = [];
  for (const row of rows) {
    let line;
    for (const run of row.runs.sort((a, b) => a.left - b.left)) {
      const gap = line ? run.left - line.right : Infinity;
      const hangingNumber = line && /^(?:\[\d+\]|\d+[.)])$/.test(line.text);
      if (gap > Math.max(7, run.size * (hangingNumber ? 2.8 : .85))) {
        line = { ...run };
        lines.push(line);
      } else {
        const separator = gap > run.size * .12 || line.text.at(-1) === ']' ? ' ' : '';
        line.text += separator + run.text;
        line.right = Math.max(line.right, run.right);
        line.top = Math.min(line.top, run.top);
        line.bottom = Math.max(line.bottom, run.bottom);
        line.size = Math.max(line.size, run.size);
      }
    }
  }
  return lines;
}

function captionLabel(text) {
  const match = /^(?:\s*)(fig(?:ure)?\.?|table|图|表)\s*([a-z]?\d+(?:[.-]\d+)*)(?![\w-])/i.exec(text);
  if (!match) return null;
  return { kind: /^(?:table|表)/i.test(match[1]) ? 'table' : 'figure', number: match[2].toLowerCase() };
}

export function linkTargetHint(name, text) {
  const target = typeof name === 'string' ? name.toLowerCase() : '';
  const figure = /^(fig(?:ure)?|table)[.:_-]/.exec(target);
  const kind = figure ? figure[1] === 'table' ? 'table' : 'figure'
    : /^(?:cite|bib|ref)[.:_-]/.test(target) ? 'reference' : null;
  if (kind !== 'reference') {
    const captions = [...text.matchAll(captionPattern)].map(match => captionLabel(match[0]))
      .filter(label => label && (!kind || label.kind === kind));
    if (captions.length === 1) return captions[0];
  }
  if (!kind || kind === 'reference') {
    const references = [...text.matchAll(/\[(\d+)\]/g)];
    if (references.length === 1) return { kind: 'reference', number: references[0][1] };
  }
  return kind ? { kind } : null;
}

export function sourceLinkText(items, viewport, rect) {
  if (!rect?.every(Number.isFinite) || rect.length !== 4) return '';
  const [left, top, right, bottom] = bounded([
    ...viewport.convertToViewportPoint(rect[0], rect[1]), ...viewport.convertToViewportPoint(rect[2], rect[3]),
  ], viewport);
  return textRuns(items, viewport).filter(run => run.right > left && run.left < right &&
    run.baseline >= top - 2 && run.top < bottom && Math.min(run.bottom, bottom) - Math.max(run.top, top) >= run.size * .3)
    .sort((a, b) => a.baseline - b.baseline || a.left - b.left).map(run => run.text).join(' ');
}

const entryNumber = text => {
  const match = referenceStart.exec(text);
  return match?.[1] ?? match?.[2];
};

function anchorDistance(line, anchor, width) {
  const dy = Math.abs(anchor.y - line.baseline);
  if (anchor.x === null || anchor.x < width * .07) return dy;
  const dx = Math.max(0, line.left - anchor.x, anchor.x - line.right);
  return dy + dx;
}

function referenceRegion(lines, hint, anchor, viewport) {
  const entry = lines
    .filter(line => {
      const number = entryNumber(line.text);
      return number && (!hint.number || number === hint.number) &&
        Math.abs(line.baseline - anchor.y) <= line.size * 2.7 &&
        (anchor.x === null || anchor.x < viewport.width * .07 || anchorDistance(line, anchor, viewport.width) <= line.size * 4);
    })
    .sort((a, b) => anchorDistance(a, anchor, viewport.width) - anchorDistance(b, anchor, viewport.width))[0];
  if (!entry) return null;
  const continuation = [entry];
  for (const line of lines) {
    if (line.baseline <= entry.baseline || line.left < entry.left - entry.size ||
        line.left > Math.min(entry.right + entry.size, entry.left + entry.size * 5)) continue;
    if (line.baseline - continuation.at(-1).baseline > entry.size * 2.1 || entryNumber(line.text)) break;
    if (continuation.length === 9 || line.size > entry.size * 1.35) return null;
    continuation.push(line);
  }
  return bounded(boxOf(continuation, 7), viewport);
}

function captionRegion(lines, hint, anchor, viewport) {
  const { width, height } = viewport;
  const middle = width / 2;
  const caption = lines.filter(line => {
    const label = captionLabel(line.text);
    return label?.kind === hint.kind && (!hint.number || label.number === hint.number) &&
      Math.abs(line.baseline - anchor.y) <= Math.min(285, height * .38) &&
      (anchor.x === null || anchor.x < width * .07 || anchor.x >= line.left - 32 && anchor.x <= line.right + width * .22);
  }).sort((a, b) => anchorDistance(a, anchor, width) - anchorDistance(b, anchor, width))[0];
  if (!caption) return null;
  const left = line => line.right <= middle + 3;
  const right = line => line.left >= middle - 3;
  const textBlock = line => line.right - line.left >= width * .16 && line.text.length >= 24;
  const isTwoColumn = lines.filter(line => left(line) && textBlock(line)).length >= 2 &&
    lines.filter(line => right(line) && textBlock(line)).length >= 2;
  const inColumn = isTwoColumn && left(caption) ? left : isTwoColumn && right(caption) ? right : () => true;
  const column = lines.filter(inColumn);
  const captionLines = [caption];
  for (const next of column) {
    if (next.baseline <= caption.baseline) continue;
    if (next.baseline - captionLines.at(-1).baseline > caption.size * 1.65 || captionLabel(next.text) ||
        Math.abs(next.left - caption.left) > caption.size * 2 || next.size > caption.size * 1.18) break;
    if (captionLines.length >= 4) return null;
    captionLines.push(next);
  }
  const [cx1, cy1, cx2, cy2] = boxOf(captionLines, 5);
  const maximumDepth = Math.min(height * .4, 310);
  let top = cy1, bottom = cy2;
  if (hint.kind === 'figure') {
    // Short axis labels sit next to bottom-of-figure anchors. Find preceding
    // prose or another caption instead of treating those labels as boundaries.
    const previous = lines.findLast(line => line.bottom < caption.top - 7 &&
      (inColumn(line) || line.left < middle && line.right > middle) &&
      (captionLabel(line.text) || line.size >= caption.size * .9 && textBlock(line)));
    if (anchor.y <= cy1 - 22) top = Math.max(cy1 - maximumDepth, anchor.y - 12);
    else top = Math.max(cy1 - maximumDepth, previous ? previous.bottom + 4 : 0);
    if (cy1 - top < 22) return null;
  } else {
    if (anchor.y > cy2 + 22) return null;
    const following = column.filter(line => line.top > cy2 && !captionLines.includes(line));
    const end = following.find((line, index) => {
      if (captionLabel(line.text)) return true;
      const preceding = following[index - 1];
      // A separated line of prose after table rows is a reasonable lower limit.
      return preceding && line.top - preceding.bottom > line.size * 2 &&
        line.text.length > 32 && /[.!?。！？]$/.test(line.text);
    });
    bottom = Math.min(cy2 + maximumDepth * .75, end ? end.top - 4 : height);
    if (bottom - cy2 < 22) return null;
  }
  const x1 = inColumn === right ? middle - 3 : 0;
  const x2 = inColumn === left ? middle + 3 : width;
  return bounded([Math.min(cx1, x1 + 5), top, Math.max(cx2, x2 - 5), bottom], viewport);
}

export function refineRegion(hint, anchor, viewport, lines) {
  if (!hint || anchor.kind !== 'anchor' || anchor.y === null) return anchor;
  const rect = hint.kind === 'reference' ? referenceRegion(lines, hint, anchor, viewport)
    : captionRegion(lines, hint, anchor, viewport);
  return rect ? { kind: hint.kind, rect } : anchor;
}

// Reproject the crop through PDF space so CropBox offsets, UserUnit and 90-degree rotations are accounted for.
export function reprojectRegion(rect, source, destination) {
  const [left, top, right, bottom] = rect;
  return bounded([
    ...destination.convertToViewportPoint(...source.convertToPdfPoint(left, top)),
    ...destination.convertToViewportPoint(...source.convertToPdfPoint(right, bottom)),
  ], destination);
}
