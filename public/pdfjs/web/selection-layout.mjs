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

function getLines(items) {
  const rows = [];
  const center = item => item.y + item.height / 2;
  for (const item of [...items].sort((a, b) => center(a) - center(b) || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && Math.abs(center(item) - center(row[0])) <= Math.max(item.height, row[0].height) * 0.44) row.push(item);
    else rows.push([item]);
  }

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
    row.sort((a, b) => a.x - b.x);
    let parts = [], right = -1;
    for (const item of row) {
      if (item.x - right > Math.max(0.023, item.height * 1.8)) {
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

function captionKind(text) {
  if (/^(?:fig(?:ure)?\.?\s*[A-Z]?\d+[a-z]?(?:[.-]\d+)*\s*[:：.．–—]|图\s*[一二三四五六七八九十\d]+(?:[-.．]\d+)*\s*[：:.．、\s])/iu.test(text)) return 'figure-caption';
  if (/^(?:table\s*(?:[A-Z]?\d+|[IVXLCDM]+)\s*[:：.．–—]|表\s*[一二三四五六七八九十\d]+(?:[-.．]\d+)*\s*[：:.．、\s])/iu.test(text)) return 'table-caption';
  return null;
}

function lineKind(line, text, bodyHeight) {
  const role = line.block?.kind;
  const caption = captionKind(text);
  if (role && role !== 'caption') return role;
  if (caption || role) return caption || role;
  const edge = pageEdge(line);
  if (edge && /^(?:(?:page|第)\s*)?(?:\d{1,4}|[ivxlcdm]{1,6})(?:\s*(?:\/|of)\s*\d+|\s*页)?$/iu.test(text) &&
      (line.x < 0.23 || line.x + line.width > 0.77 || Math.abs(line.x + line.width / 2 - 0.5) < 0.14)) return 'page-number';
  if (line.y >= 0.69 && line.fontHeight < bodyHeight * 0.92 &&
      /^(?:[\[［(（]\d{1,2}[\]］)）]|\d{1,2}[.)、．]|[¹²³⁴⁵⁶⁷⁸⁹⁰]+|[*†‡]+)\s*\p{L}/u.test(text)) return 'footnote';
  return 'body';
}

function readingOrder(lines) {
  const visual = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const body = visual.filter(line => !isAncillary(line.kind));
  const gaps = new Set();
  for (let i = 0; i < body.length; i++) {
    const a = body[i];
    for (const b of body.slice(i + 1, i + 7)) {
      if (b.y - a.y > 3 * Math.max(a.height, b.height)) break;
      const [left, right] = a.x < b.x ? [a, b] : [b, a];
      const edge = left.x + left.width;
      if (right.x - edge >= 0.045 && right.x - left.x >= 0.22) {
        const middle = (edge + right.x) / 2;
        if (middle > 0.24 && middle < 0.76) gaps.add(Math.round(middle * 100) / 100);
      }
    }
  }
  let best = null;
  for (const gap of gaps) {
    const left = body.filter(line => line.x + line.width < gap);
    const right = body.filter(line => line.x > gap);
    if (!left.length || !right.length) continue;
    const score = Math.min(left.length, right.length) * 3 - (body.length - left.length - right.length);
    if (score > 0 && (!best || score > best.score || score === best.score && Math.abs(gap - 0.5) < Math.abs(best.gap - 0.5))) {
      best = { gap, score };
    }
  }
  if (!best) return visual;
  const order = [], left = [], right = [];
  function flush() {
    if (body.filter(line => line.rtl).length > body.length / 2) order.push(...right, ...left);
    else order.push(...left, ...right);
    left.length = right.length = 0;
  }
  for (const line of visual) {
    if (line.x + line.width < best.gap) left.push(line);
    else if (line.x > best.gap) right.push(line);
    else {
      if (!isAncillary(line.kind)) flush();
      order.push(line);
    }
  }
  flush();
  // Margin material is selected on its own, even in a two-column layout.
  return [
    ...visual.filter(line => pageEdge(line) === 'header' && (line.kind === 'header' || line.kind === 'page-number')),
    ...order.filter(line => !['header', 'footer', 'page-number'].includes(line.kind)),
    ...visual.filter(line => pageEdge(line) !== 'header' && ['header', 'footer', 'page-number'].includes(line.kind)),
  ];
}

export function layoutLines(items, repeated = () => false) {
  const lines = getLines(items);
  const entries = lines.map(line => {
    line.block = line.items.find(item => item.block)?.block;
    return { line, text: lineText(line.items).trim() };
  });
  const bodyHeight = median(entries.filter(({ line, text }) => !pageEdge(line) && line.y < 0.69 &&
    !line.block && !captionKind(text)).map(({ line }) => line.fontHeight));
  for (const { line, text } of entries) {
    const edge = pageEdge(line);
    line.kind = lineKind(line, text, bodyHeight);
    if (line.kind === 'body' && edge && repeated(edge, text, line)) line.kind = edge;
  }

  // Wrapped captions/notes keep their role when they share the small type and line spacing.
  const flowing = [];
  for (const line of [...lines].sort((a, b) => a.y - b.y)) {
    const previous = flowing.findLast(other => Math.abs(other.x - line.x) <= 0.022 &&
      line.y - other.y > other.height * 0.65 && line.y - other.y < other.height * 1.7);
    if (line.kind === 'body' && previous && /caption|footnote/.test(previous.kind) &&
        line.fontHeight < bodyHeight * 0.93 && Math.abs(line.fontHeight - previous.fontHeight) < previous.fontHeight * 0.15) {
      line.kind = previous.kind;
      line.block = previous.block || previous;
    }
    flowing.push(line);
  }
  return readingOrder(lines);
}

export function edgeSignatures(items) {
  return getLines(items).flatMap(line => {
    const edge = pageEdge(line);
    const text = runningText(lineText(line.items));
    return edge && text.length > 3 ? [{ edge, text, x: line.x, y: line.y }] : [];
  });
}
