// All positions use the unrotated, normalized text layer of one PDF page.
const regionRoles = new Map([
  ['Caption', 'caption'], ['Note', 'footnote'], ['FENote', 'footnote'],
  ['PageHeader', 'header'], ['PageFooter', 'footer'],
]);
const ancillary = new Set(['header', 'footer', 'page-number', 'footnote', 'caption', 'figure-caption', 'table-caption']);

export function isAncillary(kind) { return ancillary.has(kind); }

export function readStructure(tree, block = null, roles = new Map()) {
  if (!tree) return roles;
  const kind = regionRoles.get(tree.role);
  const region = kind ? { kind } : block;
  if (tree.type === 'content' && region) roles.set(tree.id, region);
  for (const child of tree.children || []) readStructure(child, region, roles);
  return roles;
}

export function pageEdge(box) {
  if (box.y + box.height <= 0.105) return 'header';
  if (box.y >= 0.90) return 'footer';
  return null;
}

export function runningText(text) {
  return text.normalize('NFC').toLowerCase().replace(/\p{N}+/gu, '#').replace(/\s+/g, ' ').trim();
}

export function lineText(items) {
  return items.map((item, index) => {
    const previous = items[index - 1];
    const gap = previous && Math.max(item.x - previous.x - previous.width, previous.x - item.x - item.width);
    const space = gap > 0.002 && !/\s$/u.test(previous.text) && !/^\s/u.test(item.text) ? ' ' : '';
    return space + item.text;
  }).join('');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0.018;
}

const center = item => item.y + item.height / 2;
const rightEdge = item => item.x + item.width;

function getRows(items, tolerance = 0.44) {
  const rows = [];
  for (const item of [...items].sort((a, b) => center(a) - center(b) || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && Math.abs(center(item) - center(row[0])) <= Math.max(item.height, row[0].height) * tolerance) row.push(item);
    else rows.push([item]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  return rows;
}

function findGutter(items) {
  const ink = items.filter(item => item.text.trim() && !pageEdge(item));
  // As in Recursive XY Cut, measure spaces against local characters. Look for
  // a common whitespace strip down multiple baselines before joining any lines.
  const advance = runs => median(runs.map(run => run.width / run.text.trimEnd().length));
  const alignment = Math.max(0.0015, advance(ink) * 0.65);
  const candidates = new Map(), rows = [];
  for (const row of getRows(ink, 0.68)) {
    const start = row[0].x;
    const end = Math.max(...row.map(item => item.x + item.width));
    const y = median(row.map(center));
    const height = median(row.map(item => item.height));
    const glyph = advance(row);
    const gaps = [];
    let left = start, wideGaps = 0;
    for (const item of row) {
      const right = item.x;
      const middle = (left + right) / 2;
      if (right - left > glyph * 1.5) wideGaps++;
      if (right - left >= Math.max(0.001, glyph * 0.26) && left - start >= 0.10 && end - right >= 0.10 && middle > 0.24 && middle < 0.76) {
        const key = Math.round(right / alignment);
        if (!candidates.has(key)) candidates.set(key, []);
        const gap = { left, right, y, height, glyph };
        gaps.push(gap);
        candidates.get(key).push(gap);
      }
      left = Math.max(left, item.x + item.width);
    }
    rows.push({ start, end, y, gaps, wideGaps });
  }
  let best = null;
  for (const pairs of candidates.values()) {
    if (pairs.length < 2) continue;
    const left = Math.max(...pairs.map(pair => pair.left));
    const right = Math.min(...pairs.map(pair => pair.right));
    const split = (left + right) / 2;
    const height = median(pairs.map(pair => pair.height));
    const glyph = median(pairs.map(pair => pair.glyph));
    const width = right - left;
    if (width < Math.max(0.001, glyph * 0.18)) continue;
    const top = Math.min(...pairs.map(pair => pair.y)) - height * 1.5;
    const bottom = Math.max(...pairs.map(pair => pair.y)) + height * 1.5;
    const nearby = rows.filter(row => row.y >= top && row.y <= bottom);
    const straddlingRows = nearby.filter(row => split - row.start >= 0.10 && row.end - split >= 0.10).length;
    // Count whitespace at the split even when the right column starts farther
    // in on a continuation line. Clearance favors the space before reference
    // numbers over the smaller space between the number and its paragraph.
    const minimumClearance = Math.max(0.0005, glyph * 0.09);
    const support = nearby.flatMap(row => {
      const gap = row.gaps.find(gap => gap.left + minimumClearance <= split && gap.right - minimumClearance >= split);
      if (!gap) return [];
      // A row with several wide, aligned spaces is weaker evidence for a
      // prose column boundary. Tables often produce a stronger vertical
      // whitespace strip than the prose elsewhere on the page.
      return [Math.min(split - gap.left, gap.right - split, glyph * 1.5) / Math.max(1, row.wideGaps)];
    });
    const narrow = width <= glyph * 1.5;
    if (support.length < Math.max(narrow ? 4 : 2, Math.ceil(straddlingRows * (narrow ? 0.60 : 0.38)))) continue;
    if (narrow) {
      // A word gap can also line up. Require evidence that one column ends or
      // wraps independently when the whitespace is only about a glyph wide.
      const leftEdges = pairs.map(pair => pair.left).sort((a, b) => a - b);
      const unevenEnds = left - leftEdges[1] >= glyph;
      const separateRows = nearby.filter(row => row.end <= split || row.start >= split).length;
      if (!unevenEnds && separateRows < 2) continue;
    }
    const score = support.reduce((sum, space) => sum + space, 0);
    if (!best || score > best.score || (score === best.score && Math.abs(split - 0.5) < Math.abs(best.split - 0.5))) {
      best = { left, right, split, top, bottom, height, score };
    }
  }
  if (best && best.right - best.left > best.height * 4) {
    // As text wraps below an inset picture, the inner edge can move towards
    // the gutter. Use the narrower corridor where neighboring rows still
    // agree on the opposite edge.
    for (const pairs of candidates.values()) {
      if (pairs.length < 2 || !pairs.some(pair => pair.y >= best.top - best.height * 2 && pair.y <= best.bottom + best.height * 2)) continue;
      const left = Math.max(...pairs.map(pair => pair.left));
      const right = Math.min(...pairs.map(pair => pair.right));
      if (right - left < 0.006 || left < best.left - 0.002 || right > best.right + 0.002) continue;
      const sameEdge = Math.abs(left - best.left) < 0.002 || Math.abs(right - best.right) < 0.002;
      if (!sameEdge || right - left >= best.right - best.left) continue;
      best = { ...best, left, right, split: (left + right) / 2 };
    }
  }
  return best;
}

// Look for a narrow sidebar beside a wide paragraph above balanced prose
// columns. The evidence comes from PDF coordinates, before CSS text sizing.
export function findMixedColumns(items) {
  const ink = items.filter(item => item.text.trim() && !pageEdge(item)).sort((a, b) => a.y - b.y);
  const height = median(ink.map(item => item.height));
  const bands = [];
  let bottom = 0;
  for (const item of ink) {
    if (!bands.length || item.y - bottom > height * 1.6) {
      const boundary = bands.length ? (item.y + bottom) / 2 : 0;
      if (bands.length) bands.at(-1).bottom = boundary;
      bands.push({ top: boundary, bottom: 1, items: [] });
    }
    bands.at(-1).items.push(item);
    bottom = Math.max(bottom, item.y + item.height);
  }

  for (let i = 1; i < bands.length; i++) {
    const upper = bands[i - 1], lower = bands[i];
    if (upper.top < 0.12 || lower.top < 0.28 || lower.top > 0.72) continue;
    const body = findGutter(lower.items);
    if (!body || Math.abs(body.split - 0.5) > 0.06) continue;
    const proseWidth = runs => {
      if (!runs.length) return 0;
      const width = Math.max(...runs.map(rightEdge)) - runs[0].x;
      // Widely separated cells can span a column without filling it.
      return runs.reduce((ink, run) => ink + run.width, 0) >= width * 0.70 ? width : 0;
    };
    const paired = getRows(lower.items, 0.68).filter(row => {
      const left = row.filter(item => rightEdge(item) <= body.split);
      const right = row.filter(item => item.x >= body.split);
      return row.length === left.length + right.length && proseWidth(left) >= 0.27 && proseWidth(right) >= 0.27;
    });
    if (paired.length < 6) continue;
    const sidebar = findGutter(upper.items);
    if (!sidebar || sidebar.right > body.left - 0.05 || sidebar.right - sidebar.left < 0.035 ||
        upper.items.some(item => item.x < sidebar.split && rightEdge(item) > sidebar.split)) continue;
    const left = getRows(upper.items.filter(item => rightEdge(item) <= sidebar.split));
    const right = getRows(upper.items.filter(item => item.x >= sidebar.split));
    if (left.length < 3 || right.length < 6 ||
        Math.abs(center(left[0][0]) - center(right[0][0])) > height ||
        Math.abs(left[0][0].x - median(paired.map(row => row[0].x))) > 0.025 ||
        right.filter(row => Math.abs(row[0].x - sidebar.right) < 0.02 &&
          Math.max(...row.map(rightEdge)) >= body.right + 0.12).length < 5) continue;
    return [{ top: upper.top, bottom: upper.bottom, gutter: sidebar },
      { top: lower.top, bottom: lower.bottom, gutter: body }];
  }
  return null;
}

function getLines(rows) {
  const lines = [];
  function finish(parts) {
    if (!parts.length) return;
    const rtl = parts.filter(item => item.dir === 'rtl').length > parts.length / 2;
    if (rtl) parts.reverse();
    const x = Math.min(...parts.map(item => item.x));
    const right = Math.max(...parts.map(item => item.x + item.width));
    const y = Math.min(...parts.map(item => item.y));
    const bottom = Math.max(...parts.map(item => item.y + item.height));
    lines.push({ items: parts, x, y, width: right - x, height: bottom - y, fontHeight: median(parts.map(part => part.height)), rtl });
  }
  for (const row of rows) {
    let parts = [], right = -1;
    for (const item of row) {
      const gap = item.x - right;
      if (gap > Math.max(0.023, item.height * 1.8)) {
        finish(parts);
        parts = [];
        right = -1;
      }
      parts.push(item);
      right = Math.max(right, item.x + item.width);
    }
    finish(parts);
  }
  return lines;
}

function columnLines(items, gutter) {
  if (!gutter) return getLines(getRows(items));
  const { split, height } = gutter;
  const rows = getRows(items, 0.68).map(row => {
    const ink = row.filter(item => item.text.trim());
    const crosses = item => item.x < split && item.x + item.width > split;
    const left = ink.filter(item => item.x + item.width <= split);
    const right = ink.filter(item => item.x >= split);
    const connected = left.length && right.length &&
      right[0].x - Math.max(...left.map(item => item.x + item.width)) < (gutter.right - gutter.left) * 0.65;
    const heading = left.length && right.length &&
      median(left.map(item => item.height)) > height * 1.45 &&
      median(right.map(item => item.height)) > height * 1.45;
    return { row, y: median((ink.length ? ink : row).map(center)),
      fits: ink.length && !ink.some(crosses) && !heading && !connected };
  });
  // Extend the evidence band through adjacent compatible rows, including text
  // near the page edges that was excluded from gutter detection.
  let first = rows.findIndex(row => row.y >= gutter.top);
  let last = rows.findLastIndex(row => row.y <= gutter.bottom);
  while (first > 0 && rows[first - 1].fits && rows[first].y - rows[first - 1].y <= height * 2) first--;
  while (last >= 0 && last < rows.length - 1 && rows[last + 1].fits && rows[last + 1].y - rows[last].y <= height * 2) last++;

  const left = [], right = [], spanning = [];
  rows.forEach(({ row, fits }, index) => {
    if (!fits || index < first || index > last) {
      spanning.push(...row);
      return;
    }
    for (const item of row) {
      if (item.x + item.width <= split) left.push(item);
      else if (item.x >= split) right.push(item);
    }
  });
  return [left, right, spanning].flatMap(group => getLines(getRows(group)));
}

function mixedColumnLines(items, bands, gutter) {
  const regions = [];
  let top = 0;
  for (const band of bands) {
    if (band.top > top) regions.push({ top, bottom: band.top, gutter });
    regions.push({ ...band, local: true });
    top = band.bottom;
  }
  if (top < 1) regions.push({ top, bottom: 1, gutter });

  for (const [index, region] of regions.entries()) {
    const runs = items.filter(item => center(item) >= region.top && center(item) < region.bottom);
    let lines;
    if (region.local) {
      const { split } = region.gutter;
      // A rebuilt text layer must agree with the two bands. A run that crosses
      // a split might contain real text from a spanning line.
      if (runs.some(item => item.text.trim() && (item.x < split && rightEdge(item) > split ||
          item.y < region.top || item.y + item.height > region.bottom))) return null;
      const left = runs.filter(item => item.x + item.width / 2 < split);
      const right = runs.filter(item => item.x + item.width / 2 >= split);
      if (!left.some(item => item.text.trim()) || !right.some(item => item.text.trim())) return null;
      const leftLines = getLines(getRows(left));
      const rightLines = getLines(getRows(right));
      for (const line of leftLines) line.column = 'left';
      for (const line of rightLines) line.column = 'right';
      lines = [...leftLines, ...rightLines];
    } else {
      lines = columnLines(runs, gutter);
    }
    region.lines = lines;
    for (const line of lines) line.region = index;
  }
  if (regions.reduce((count, region) => count + region.lines.reduce((sum, line) =>
    sum + line.items.filter(item => item.text.trim()).length, 0), 0) !==
    items.filter(item => item.text.trim()).length) return null;
  return regions;
}

function fromNativeLayout(items, regions) {
  if (!regions?.length) return null;
  const rows = regions.map(() => []);
  for (const item of items) {
    let best = -1, distance = Infinity;
    for (let index = 0; index < regions.length; index++) {
      const region = regions[index];
      const vertical = Math.abs(center(item) - center(region));
      if (vertical > Math.max(item.height, region.height) * 0.72) continue;
      const overlap = Math.min(item.x + item.width, region.x + region.width) - Math.max(item.x, region.x);
      if (overlap < item.width * 0.72) continue;
      const rank = vertical + (1 - overlap / item.width) * item.height;
      if (rank < distance) { best = index; distance = rank; }
    }
    if (best >= 0) rows[best].push(item);
    // Never remove printable text when the two engines disagree on a page.
    else if (item.text.trim()) return null;
  }
  return getLines(rows.map(row => row.sort((a, b) => a.x - b.x)));
}

const standaloneTable = /^table\s+(?:[A-Z]?\d+|[IVXLCDM]+)$/iu;

function captionKind(text) {
  if (/^(?:fig(?:ure)?\.?\s*[A-Z]?\d+[a-z]?(?:[.-]\d+)*\s*[:：.．–—]|图\s*[一二三四五六七八九十\d]+(?:[-.．]\d+)*\s*[：:.．、\s])/iu.test(text)) return 'figure-caption';
  if (standaloneTable.test(text) ||
      /^(?:table\s*(?:[A-Z]?\d+|[IVXLCDM]+)\s*[:：.．–—]|表\s*[一二三四五六七八九十\d]+(?:[-.．]\d+)*\s*[：:.．、\s])/iu.test(text)) return 'table-caption';
  return null;
}

function lineKind(line, text, bodyHeight) {
  const role = line.block?.kind;
  const caption = captionKind(text);
  if (role && role !== 'caption') return role;
  if (caption || role) return caption || role;
  const edge = pageEdge(line);
  if ((edge === 'footer' || edge === 'header' && line.y + line.height <= 0.075) &&
      /^(?:(?:page|第)\s*)?(?:\d{1,6}|[ivxlcdm]{1,6})(?:\s*(?:\/|of)\s*\d+|\s*页)?$/iu.test(text) &&
      (line.x < 0.23 || line.x + line.width > 0.77 || Math.abs(line.x + line.width / 2 - 0.5) < 0.14)) return 'page-number';
  if (line.y >= 0.80 && /^\d{1,2}\s*https?:\/\//iu.test(text)) return 'footnote';
  if (line.y >= 0.69 && line.fontHeight < bodyHeight * 0.92 &&
      /^(?:[\[［(（]\d{1,2}[\]］)）]|\d{1,2}[.)、．]|[¹²³⁴⁵⁶⁷⁸⁹⁰]+|[*†‡]+)\s*\p{L}/u.test(text)) return 'footnote';
  return 'body';
}

function readingOrder(lines, gutter, moveMargins = true) {
  const visual = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  if (!gutter) return visual;
  const body = visual.filter(line => !isAncillary(line.kind));
  const rtl = body.filter(line => line.rtl).length > body.length / 2;
  const order = [], left = [], right = [];
  function flush() {
    if (rtl) order.push(...right, ...left);
    else order.push(...left, ...right);
    left.length = right.length = 0;
  }
  for (const line of visual) {
    if (line.column === 'left') left.push(line);
    else if (line.column === 'right') right.push(line);
    else {
      if (!isAncillary(line.kind)) flush();
      order.push(line);
    }
  }
  flush();
  return moveMargins ? marginOrder(visual, order) : order;
}

function marginOrder(visual, order) {
  // Margin material is selected on its own, even in a two-column layout.
  return [
    ...visual.filter(line => pageEdge(line) === 'header' && (line.kind === 'header' || line.kind === 'page-number')),
    ...order.filter(line => !['header', 'footer', 'page-number'].includes(line.kind)),
    ...visual.filter(line => pageEdge(line) !== 'header' && ['header', 'footer', 'page-number'].includes(line.kind)),
  ];
}

export function layoutLines(items, repeated = () => false, nativeRegions = null, bands = null) {
  const gutter = findGutter(items);
  const nativeLines = fromNativeLayout(items, nativeRegions);
  const regions = !nativeLines && bands ? mixedColumnLines(items, bands, gutter) : null;
  const lines = nativeLines || regions?.flatMap(region => region.lines) || columnLines(items, gutter);
  const entries = lines.map(line => {
    line.block = line.items.find(item => item.block)?.block;
    line.column ??= !gutter ? null : rightEdge(line) <= gutter.split ? 'left' : line.x >= gutter.split ? 'right' : null;
    return { line, text: lineText(line.items).trim() };
  });
  const bodyHeight = median(entries.filter(({ line, text }) => !pageEdge(line) && line.y < 0.69 &&
    !line.block && !captionKind(text)).map(({ line }) => line.fontHeight));
  for (const { line, text } of entries) {
    const edge = pageEdge(line);
    line.kind = lineKind(line, text, bodyHeight);
    if (line.kind === 'body' && edge && repeated(edge, text, line)) line.kind = edge;
  }

  // Continue captions within the same text block, even on pages without a
  // reliable body font sample.
  const texts = new Map(entries.map(({ line, text }) => [line, text]));
  const flowing = [];
  for (const line of [...lines].sort((a, b) => a.y - b.y)) {
    const previous = flowing.findLast(other => other.region === line.region &&
      (other.column === line.column || other.column === null && other.kind.endsWith('caption')) &&
      (Math.abs(other.x - line.x) <= 0.022 || centeredTableTitle(line, other, texts.get(other))) &&
      line.y - other.y > other.height * 0.65 && line.y - other.y < other.height * 1.7);
    if (line.kind === 'body' && previous &&
        continuesAncillary(line, previous, texts.get(previous), bodyHeight)) {
      line.kind = previous.kind;
      line.block = previous.block || previous;
      line.column = previous.column;
    }
    flowing.push(line);
  }
  const order = nativeLines || (regions ? marginOrder([...lines].sort((a, b) => a.y - b.y || a.x - b.x),
    regions.flatMap(region => readingOrder(region.lines, region.gutter, false))) : readingOrder(lines, gutter));
  return { lines: order, gutter, regions, usedNative: Boolean(nativeLines) };
}

function continuesAncillary(line, previous, previousText, bodyHeight) {
  if (centeredTableTitle(line, previous, previousText)) return true;
  if (Math.abs(line.fontHeight - previous.fontHeight) >= previous.fontHeight * 0.15) return false;
  if (previous.kind === 'footnote') return line.fontHeight < bodyHeight * 0.93;
  if (!previous.kind.endsWith('caption')) return false;
  const extendsRight = line.x + line.width > previous.x + previous.width + 0.022;
  if (!extendsRight) return true;
  // Short opening lines can wrap into a longer second line in smaller type.
  // A line that extends beyond a completed caption is usually another block.
  return line.fontHeight < bodyHeight * 0.93 && !/[.!?。！？]$/u.test(previousText);
}

function centeredTableTitle(line, previous, previousText) {
  return previous.kind === 'table-caption' && standaloneTable.test(previousText) &&
    line.fontHeight >= previous.fontHeight * 0.60 && line.fontHeight <= previous.fontHeight * 1.45 &&
    line.width > previous.width * 1.4 &&
    Math.abs(line.x + line.width / 2 - previous.x - previous.width / 2) <= 0.022;
}

export function edgeSignatures(items) {
  return getLines(getRows(items)).flatMap(line => {
    const edge = pageEdge(line);
    const text = runningText(lineText(line.items));
    return edge && text.length > 3 ? [{ edge, text, x: line.x, y: line.y }] : [];
  });
}
