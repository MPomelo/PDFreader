import { edgeSignatures, findMixedColumns, isAncillary, layoutLines, lineText, readStructure, runningText } from './selection-layout.mjs';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function relativeRect(rect, parent, rotation) {
  const x = (rect.left - parent.left) / parent.width;
  const y = (rect.top - parent.top) / parent.height;
  const width = rect.width / parent.width;
  const height = rect.height / parent.height;
  switch (rotation) {
    case 90: return { x: y, y: 1 - x - width, width: height, height: width };
    case 180: return { x: 1 - x - width, y: 1 - y - height, width, height };
    case 270: return { x: 1 - y - height, y: x, width: height, height: width };
    default: return { x, y, width, height };
  }
}

function visualRect(box, parent, rotation) {
  const unit = { left: 0, top: 0, width: 1, height: 1 };
  const { x, y, width, height } = relativeRect({ ...box, left: box.x, top: box.y }, unit, (360 - rotation) % 360);
  return new DOMRect(parent.left + x * parent.width, parent.top + y * parent.height, width * parent.width, height * parent.height);
}

function textRange(span, start, end) {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0, started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const next = offset + node.length;
    if (!started && start <= next) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= next) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset = next;
  }
  return null;
}

function positionsFor(run) {
  run.positions ??= [...Array.from(segmenter.segment(run.text), part => part.index), run.text.length];
  return run.positions;
}

function caretOffset(run, x, parent, rotation) {
  const positions = positionsFor(run);
  const box = run.box;
  const fraction = Math.min(1, Math.max(0, (x - box.x) / box.width));
  let low = 0, high = positions.length - 1;
  while (high > low + 1) {
    const index = (low + high) >> 1;
    const rect = textRange(run.span, positions[index], positions[index])?.getBoundingClientRect();
    if (!rect?.height && !rect?.width) break;
    const candidate = relativeRect(rect, parent, rotation).x;
    if ((candidate <= x) !== (run.dir === 'rtl')) low = index;
    else high = index;
  }
  if (high > low + 1) return positions[Math.round((run.dir === 'rtl' ? 1 - fraction : fraction) * (positions.length - 1))];
  let best = positions[low], distance = Infinity;
  for (const index of [low, high]) {
    const rect = textRange(run.span, positions[index], positions[index])?.getBoundingClientRect();
    if (!rect?.height && !rect?.width) continue;
    const delta = Math.abs(x - relativeRect(rect, parent, rotation).x);
    if (delta < distance) {
      best = positions[index];
      distance = delta;
    }
  }
  return best;
}

function clipRun(run, start, end) {
  if (start === 0 && end === run.text.length) return run.boxes;
  if (run.span.isConnected) {
    const layer = run.span.closest('.textLayer');
    const parent = layer.getBoundingClientRect();
    const rotation = Number(layer.dataset.mainRotation) || 0;
    const range = textRange(run.span, start, end);
    const boxes = range && Array.from(range.getClientRects(), rect => relativeRect(rect, parent, rotation))
      .filter(box => box.width > 0 && box.height > 0);
    if (boxes?.length) {
      run.clips ??= new Map();
      run.clips.set(`${start}:${end}`, boxes);
      return boxes;
    }
  }
  return run.clips?.get(`${start}:${end}`);
}

function getPageNumber(layer) {
  return Number(layer.closest('.page')?.dataset.pageNumber);
}

function getPosition(layer, clientX, clientY) {
  const parent = layer.getBoundingClientRect();
  const rotation = Number(layer.dataset.mainRotation) || 0;
  const { x, y } = relativeRect({ left: clientX, top: clientY, width: 0, height: 0 }, parent, rotation);
  return { parent, rotation, x, y };
}

function boxUnion(boxes) {
  const left = Math.min(...boxes.map(box => box.x));
  const top = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width));
  const bottom = Math.max(...boxes.map(box => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function createPreciseSelection(viewer, { enabled, requestNativeLayout, onChange, onFinish }) {
  const scrollbox = viewer.parentElement;
  const models = new Map(), metadata = new Map(), loading = new Map(), overlays = new Set();
  const nativeLayouts = new Map();
  let pdf = null, metadataVersion = 0, drag = null, current = null, frame = 0;

  function layerFor(page) {
    return viewer.querySelector('.page[data-page-number="' + page + '"] .textLayer');
  }

  function paint() {
    for (const overlay of overlays) overlay.remove();
    overlays.clear();
    for (const group of current?.groups || []) {
      const layer = layerFor(group.page);
      if (!layer) continue;
      const overlay = document.createElement('div');
      overlay.className = 'pdfreader-precise-selection';
      overlay.setAttribute('aria-hidden', 'true');
      for (const box of group.boxes) {
        const mark = document.createElement('div');
        mark.style.cssText = `left:${box.x * 100}%;top:${box.y * 100}%;width:${box.width * 100}%;height:${box.height * 100}%`;
        overlay.append(mark);
      }
      layer.append(overlay);
      overlays.add(overlay);
    }
  }

  function clear() {
    if (!current) return;
    current = null;
    paint();
    onChange();
  }

  function prepare(page) {
    if (!pdf || page < 1 || page > pdf.numPages || loading.has(page)) return loading.get(page);
    const source = pdf;
    const task = (async () => {
      const pdfPage = await source.getPage(page);
      const [content, tree] = await Promise.all([pdfPage.getTextContent(), pdfPage.getStructTree().catch(() => null)]);
      if (pdf !== source) return;
      const viewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
      const items = content.items.filter(item => item.str?.trim()).map(item => {
        const [x, baseline] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        return { text: item.str, dir: item.dir, x: x / viewport.width, y: (baseline - item.height) / viewport.height,
          width: item.width / viewport.width, height: item.height / viewport.height };
      });
      metadata.set(page, {
        roles: readStructure(tree),
        margins: edgeSignatures(items),
        nativeSize: pdfPage.rotate === 0 ? [viewport.width, viewport.height] : null,
        mixedColumns: page === 1 && pdfPage.rotate === 0 ? findMixedColumns(items) : null,
      });
      metadataVersion++;
    })().catch(() => {});
    loading.set(page, task);
    return task;
  }

  function prepareNearby(page) {
    for (const index of [page, page - 1, page + 1, page - 2, page + 2]) prepare(index);
    if (pdf && page >= 1 && page <= pdf.numPages && !nativeLayouts.has(page) && requestNativeLayout?.(page)) {
      nativeLayouts.set(page, null);
      if (nativeLayouts.size > 32) nativeLayouts.delete(nativeLayouts.keys().next().value);
    }
  }

  function repeated(page, edge, text, line) {
    const signature = runningText(text);
    return [page - 1, page + 1, page - 2, page + 2].some(other => metadata.get(other)?.margins.some(margin =>
      margin.edge === edge && margin.text === signature && Math.abs(margin.y - line.y) < 0.035 &&
      Math.abs(margin.x - line.x) < 0.06));
  }

  function modelFor(page, layer = layerFor(page)) {
    const cached = models.get(page);
    if (!layer || !layer.isConnected) return cached;
    const parent = layer.getBoundingClientRect();
    const rotation = Number(layer.dataset.mainRotation) || 0;
    if (!parent.width || !parent.height) return cached;
    if (cached?.layer === layer && cached.version === metadataVersion && cached.width === parent.width &&
        cached.height === parent.height && cached.rotation === rotation) return cached;
    const roles = metadata.get(page)?.roles;
    const items = [];
    const spans = layer.querySelectorAll('span[dir]');
    for (let index = 0; index < spans.length; index++) {
      const span = spans[index];
      const text = span.textContent;
      if (!text) continue;
      const range = textRange(span, 0, text.length);
      const boxes = Array.from(range?.getClientRects() || [], rect => relativeRect(rect, parent, rotation))
        .filter(box => box.width > 0 && box.height > 0);
      if (!boxes.length) continue;
      let block;
      for (let parent = span.parentElement; parent && parent !== layer && !block; parent = parent.parentElement) {
        block = roles?.get(parent.id);
      }
      const box = boxUnion(boxes);
      items.push({ ...box, box, boxes, span, text, block, dir: span.dir, index });
    }
    if (!items.length) return cached;
    const native = nativeLayouts.get(page);
    const nativeSize = metadata.get(page)?.nativeSize;
    const compatible = native && nativeSize && Math.abs(nativeSize[0] - native.width) < 0.5 &&
      Math.abs(nativeSize[1] - native.height) < 0.5;
    const { lines, gutter, regions, usedNative } = layoutLines(items, (edge, text, line) => repeated(page, edge, text, line),
      compatible ? native.lines : null, metadata.get(page)?.mixedColumns);
    layer.dataset.pdfreaderLayout = usedNative ? 'poppler' : 'browser';
    for (const line of lines) for (const run of line.items) run.span.dataset.pdfreaderBlock = line.kind;
    const model = { page, layer, version: metadataVersion, rotation, width: parent.width, height: parent.height, lines, gutter, regions };
    models.delete(page);
    models.set(page, model);
    if (models.size > 32) models.delete(models.keys().next().value);
    return model;
  }

  function hit(clientX, clientY, exact = false) {
    const target = document.elementFromPoint(clientX, clientY);
    const layer = target?.closest('.textLayer');
    if (!viewer.contains(layer)) return null;
    const page = getPageNumber(layer);
    const model = drag?.models.get(page) || modelFor(page, layer);
    if (!model) return null;
    const { parent, rotation, x, y } = getPosition(layer, clientX, clientY);
    const startColumn = drag?.anchor.model.page === page ? drag.anchor.line.column : null;
    const gutter = model.regions ? model.regions.find(region => y >= region.top && y < region.bottom)?.gutter : model.gutter;
    const inGutter = gutter && x > gutter.left && x < gutter.right;
    let best = null, distance = Infinity;
    for (let lineIndex = 0; lineIndex < model.lines.length; lineIndex++) {
      const line = model.lines[lineIndex];
      const dx = Math.max(line.x - x, 0, x - line.x - line.width);
      const dy = Math.max(line.y - y, 0, y - line.y - line.height);
      if (dy > line.height * (exact ? 0.12 : 0.45) || dx > (exact ? 0.003 : 0.018)) continue;
      const crossesColumn = startColumn && line.column && startColumn !== line.column;
      if ((inGutter || crossesColumn) && !line.items.some(run => run.text.trim() && run.boxes.some(box =>
        x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height))) continue;
      const rank = (dx * parent.width) ** 2 + (dy * parent.height) ** 2 +
        0.005 * ((line.y + line.height / 2 - y) * parent.height) ** 2;
      if (rank < distance) {
        best = { line, lineIndex };
        distance = rank;
      }
    }
    if (!best) return null;
    let runIndex = 0, gap = Infinity;
    for (let i = 0; i < best.line.items.length; i++) {
      const run = best.line.items[i];
      const delta = Math.max(run.x - x, 0, x - run.x - run.width);
      if (delta < gap) { runIndex = i; gap = delta; }
    }
    const run = best.line.items[runIndex];
    return { ...best, model, runIndex, offset: caretOffset(run, x, parent, rotation) };
  }

  function collect(anchor, focus) {
    const position = at => [at.model.page, at.lineIndex, at.runIndex, at.offset];
    const a = position(anchor), b = position(focus);
    const difference = a.reduce((order, value, index) => order || value - b[index], 0);
    if (!difference) return null;
    const [start, end] = difference < 0 ? [anchor, focus] : [focus, anchor];
    const ancillary = isAncillary(anchor.line.kind);
    const sameRegion = start.model.page === end.model.page && start.line.region === end.line.region;
    const column = !ancillary && sameRegion && start.line.column === end.line.column ? start.line.column : null;
    const groups = [];
    for (let page = start.model.page; page <= end.model.page; page++) {
      const model = drag.models.get(page) || modelFor(page);
      if (!model) return undefined;
      drag.models.set(page, model);
      const from = page === start.model.page ? start.lineIndex : 0;
      const to = page === end.model.page ? end.lineIndex : model.lines.length - 1;
      const boxes = [], lines = [], kinds = new Set(), anchors = [];
      for (let row = from; row <= to; row++) {
        const line = model.lines[row];
        if (ancillary) {
          if ((line.block || line) !== (anchor.line.block || anchor.line)) continue;
        } else if (isAncillary(line.kind) || column && (line.region !== start.line.region || line.column !== column)) continue;
        const first = line === start.line ? start.runIndex : 0;
        const last = line === end.line ? end.runIndex : line.items.length - 1;
        const parts = [];
        for (let i = first; i <= last; i++) {
          const run = line.items[i];
          const begin = line === start.line && i === first ? start.offset : 0;
          const finish = line === end.line && i === last ? end.offset : run.text.length;
          if (finish <= begin) continue;
          const text = run.text.slice(begin, finish);
          parts.push({ ...run, text });
          if (!text.trim()) continue;
          const selectionBoxes = clipRun(run, begin, finish);
          if (!selectionBoxes) return undefined;
          boxes.push(...selectionBoxes);
          anchors.push([run.index, begin, finish]);
        }
        const text = lineText(parts).trimEnd();
        if (text.trim()) {
          kinds.add(line.kind);
          lines.push(text);
        }
      }
      if (boxes.length) groups.push({ page, boxes, text: lines.join('\n'), kinds: [...kinds], anchors });
    }
    if (!groups.length) return null;
    return { groups, text: groups.map(group => group.text).join('\n\n'),
      anchor: JSON.stringify(groups.map(group => [group.page, group.anchors])) };
  }

  function update(clientX, clientY) {
    const hovered = hit(clientX, clientY);
    if (!hovered) return false;
    const anchor = drag.anchor.line;
    if (isAncillary(anchor.kind) ? (hovered.line.block || hovered.line) !== (anchor.block || anchor) : isAncillary(hovered.line.kind)) return false;
    drag.models.set(hovered.model.page, hovered.model);
    const result = collect(drag.anchor, hovered);
    if (result === undefined) return false;
    if (result?.anchor !== current?.anchor) {
      current = result;
      paint();
    }
    return true;
  }

  function updateFromPoints(x, y) {
    const points = drag.points;
    drag.points = [];
    if (!update(x, y)) points.reverse().some(point => update(point.x, point.y));
  }

  function tick() {
    frame = 0;
    if (!drag?.started) return;
    const { x, y } = drag.point;
    const bounds = scrollbox.getBoundingClientRect();
    updateFromPoints(x, y);
    if (x < bounds.left || x > bounds.right || y < bounds.top - 32 || y > bounds.bottom + 32) return;
    const top = y - bounds.top, bottom = bounds.bottom - y;
    const speed = top < 24 ? -Math.min(16, (24 - top) * 0.65) : bottom < 24 ? Math.min(16, (24 - bottom) * 0.65) : 0;
    const before = scrollbox.scrollTop;
    if (speed) scrollbox.scrollTop += speed;
    if (scrollbox.scrollTop !== before) frame = requestAnimationFrame(tick);
  }

  function end(cancelled = false) {
    if (!drag) return;
    const { started, id, point: dragPoint } = drag;
    drag = null;
    cancelAnimationFrame(frame);
    frame = 0;
    viewer.classList.remove('pdfreader-precise-drag');
    if (viewer.hasPointerCapture(id)) viewer.releasePointerCapture(id);
    if (cancelled) clear();
    else if (started) {
      document.getSelection()?.removeAllRanges();
      onChange();
      if (current) onFinish(current, dragPoint);
    } else onChange();
  }

  document.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !['mouse', 'pen'].includes(event.pointerType) ||
        !(event.target instanceof Element) || !viewer.contains(event.target)) return;
    if (!enabled() || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
        event.target.closest('a, input, textarea, select, button, [contenteditable=true], .annotationLayer, .editToolbar')) {
      clear();
      return;
    }
    clear();
    const anchor = hit(event.clientX, event.clientY, true);
    if (!anchor) return;
    const run = anchor.line.items[anchor.runIndex];
    if (anchor.offset > 0 && anchor.offset < run.text.length) {
      clipRun(run, 0, anchor.offset);
      clipRun(run, anchor.offset, run.text.length);
    }
    prepareNearby(anchor.model.page);
    drag = { id: event.pointerId, anchor, origin: { x: event.clientX, y: event.clientY },
      started: false, points: [], models: new Map([[anchor.model.page, anchor.model]]) };
  }, true);

  document.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.id) return;
    if (!event.buttons) { end(true); return; }
    const point = { x: event.clientX, y: event.clientY };
    if (!drag.started) {
      if (Math.hypot(point.x - drag.origin.x, point.y - drag.origin.y) < 3) return;
      drag.started = true;
      viewer.classList.add('pdfreader-precise-drag');
      viewer.setPointerCapture(event.pointerId);
      document.getSelection()?.removeAllRanges();
    }
    event.preventDefault();
    if (drag.point) drag.points.push(drag.point);
    drag.point = point;
    if (!frame) frame = requestAnimationFrame(tick);
  }, true);

  document.addEventListener('pointerup', event => {
    if (event.pointerId !== drag?.id) return;
    if (drag.started) updateFromPoints(event.clientX, event.clientY);
    end();
  }, true);
  document.addEventListener('pointercancel', event => { if (event.pointerId === drag?.id) end(true); }, true);
  window.addEventListener('blur', () => { if (drag) end(drag.started); });

  return {
    get current() { return current; },
    get tracking() { return Boolean(drag); },
    clear,
    setDocument(document) {
      end(true);
      clear();
      pdf = document;
      metadata.clear();
      loading.clear();
      models.clear();
      nativeLayouts.clear();
      metadataVersion++;
      if (pdf) prepareNearby(1);
    },
    setNativeLayout(page, layout) {
      if (!nativeLayouts.has(page) || !Array.isArray(layout?.lines)) return;
      nativeLayouts.set(page, layout);
      models.delete(page);
    },
    prepareNearby,
    pageRendered(page) {
      // A new text layer with the same size may contain different search-highlight DOM.
      models.delete(page);
      if (current) paint();
      prepareNearby(page);
    },
    clientRects(selection = current) {
      const bounds = scrollbox.getBoundingClientRect();
      return (selection?.groups || []).flatMap(group => {
        const layer = layerFor(group.page);
        if (!layer) return [];
        const parent = layer.getBoundingClientRect();
        const rotation = Number(layer.dataset.mainRotation) || 0;
        return group.boxes.map(box => visualRect(box, parent, rotation))
          .filter(rect => rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom);
      });
    },
  };
}
