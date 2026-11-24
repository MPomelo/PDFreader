import { AnnotationMode } from '../build/pdf.mjs';
import {
  destinationRegion, linkTargetHint, refineRegion, reprojectRegion,
  resolveDestination, sourceLinkText, textLines,
} from './link-preview-region.mjs';

const linkSelector = '.annotationLayer .linkAnnotation[data-internal-link] > a[data-element-id]';
const hoverDelay = 350;
const margin = 8;
const limit = (value, extent, size) => Math.max(margin, Math.min(value, extent - size - margin));

function remember(cache, key, value, capacity) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > capacity) cache.delete(cache.keys().next().value);
  return value;
}

function surfaceSize() {
  return {
    width: Math.min(480, window.innerWidth - margin * 4),
    height: Math.min(330, Math.floor(window.innerHeight * .58) - 30),
    dpr: Math.min(2, window.devicePixelRatio || 1),
  };
}

function place(popup, link) {
  const { left, right, top, bottom } = link.getBoundingClientRect();
  const { width, height } = popup.getBoundingClientRect();
  const gap = 8, viewportWidth = window.innerWidth, viewportHeight = window.innerHeight;
  let x = left, y = bottom + gap;
  if (bottom + gap + height > viewportHeight - margin) {
    if (top - gap >= height + margin) y = top - gap - height;
    else if (right + gap + width <= viewportWidth - margin) { x = right + gap; y = top; }
    else if (left - gap >= width + margin) { x = left - width - gap; y = top; }
    else y = viewportHeight - bottom >= top ? bottom + gap : top - gap - height;
  }
  popup.style.left = limit(x, viewportWidth, width) + 'px';
  popup.style.top = limit(y, viewportHeight, height) + 'px';
}

export function createLinkPreview(viewer, app, { getDocument, enabled }) {
  const popup = document.createElement('div');
  popup.className = 'pdfreader-link-preview';
  popup.hidden = true;
  popup.setAttribute('aria-hidden', 'true');
  const pageLabel = document.createElement('div');
  pageLabel.className = 'pdfreader-link-preview-label';
  const image = document.createElement('div');
  image.className = 'pdfreader-link-preview-image';
  popup.append(pageLabel, image);
  document.body.append(popup);

  let pending = null;
  let cache = newCache();
  function newCache() { return { images: new Map(), text: new Map() }; }
  function close() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.render?.cancel();
    pending = null;
    popup.hidden = true;
    image.replaceChildren();
  }
  function reset() {
    close();
    cache = newCache();
  }
  function current(job) {
    return pending === job && getDocument() === job.pdf && job.link.isConnected && enabled();
  }
  function getText(job, page) {
    const pages = job.cache.text;
    let promise = pages.get(page.pageNumber);
    if (!promise) {
      promise = page.getTextContent().then(result => result.items).catch(error => {
        if (pages.get(page.pageNumber) === promise) pages.delete(page.pageNumber);
        throw error;
      });
    }
    return remember(pages, page.pageNumber, promise, 4);
  }
  async function chooseRegion(job, annotation, sourcePage, targetPage, dest, base) {
    const region = destinationRegion(dest, base);
    if (region.kind !== 'anchor' || region.y === null) return region;
    try {
      let hint = linkTargetHint(annotation.dest, annotation.overlaidText || '');
      if (!hint?.number && current(job)) {
        const items = await getText(job, sourcePage);
        const sourceViewport = sourcePage.getViewport({ scale: 1, rotation: 0 });
        if (items.length <= 15000) hint = linkTargetHint(annotation.dest, sourceLinkText(items, sourceViewport, annotation.rect)) || hint;
      }
      if (hint && current(job)) {
        const items = await getText(job, targetPage);
        if (current(job) && items.length <= 15000) return refineRegion(hint, region, base, textLines(items, base));
      }
    } catch { /* The destination itself is still usable if its text is unavailable. */ }
    return region;
  }
  async function render(job, page, base, region, size, rotation) {
    const viewport = page.getViewport({ scale: 1, rotation });
    const [left, top, right, bottom] = reprojectRegion(region.rect, base, viewport);
    const width = right - left, height = bottom - top;
    if (width < 1 || height < 1) return null;
    const scale = Math.min(size.width / width, size.height / height, 1.45);
    const renderScale = scale * size.dpr;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * renderScale);
    canvas.height = Math.ceil(height * renderScale);
    canvas.style.width = Math.ceil(width * scale) + 'px';
    canvas.style.height = Math.ceil(height * scale) + 'px';
    const canvasContext = canvas.getContext('2d', { alpha: false });
    if (!canvasContext) return null;
    job.render = page.render({
      canvas, canvasContext, viewport: page.getViewport({ scale: renderScale, rotation }),
      transform: [1, 0, 0, 1, -left * renderScale, -top * renderScale],
      annotationMode: AnnotationMode.DISABLE,
      optionalContentConfigPromise: app.pdfViewer.optionalContentConfigPromise,
      background: '#fff',
    });
    try {
      await job.render.promise;
      return canvas;
    } finally {
      job.render = null;
    }
  }
  function show(job, result) {
    if (!current(job)) return;
    pageLabel.textContent = `第 ${result.pageNumber} 页`;
    image.replaceChildren(result.canvas);
    popup.dataset.region = result.kind;
    popup.hidden = false;
    place(popup, job.link);
  }
  async function preview(job) {
    if (!current(job)) return;
    const size = surfaceSize();
    if (size.width < 120 || size.height < 80) return;
    const viewRotation = app.pdfViewer.pagesRotation;
    const id = job.link.dataset.elementId;
    const key = [job.source, id, viewRotation, size.width, size.height, size.dpr].join(':');
    const previews = job.cache.images;
    const cached = previews.get(key);
    if (cached) {
      show(job, remember(previews, key, cached, 6));
      return;
    }
    const sourcePage = await job.pdf.getPage(job.source);
    if (!current(job)) return;
    const annotations = await sourcePage.getAnnotations({ intent: 'display' });
    if (!current(job)) return;
    const annotation = annotations.find(item => item.id === id && item.subtype === 'Link' && item.dest && !item.url);
    if (!annotation) return;
    const target = await resolveDestination(job.pdf, annotation.dest);
    if (!target || !current(job)) return;
    const page = await job.pdf.getPage(target.pageNumber);
    if (!current(job)) return;
    const base = page.getViewport({ scale: 1, rotation: 0 });
    const region = await chooseRegion(job, annotation, sourcePage, page, target.dest, base);
    if (!current(job)) return;
    const rotation = (page.rotate + viewRotation + 360) % 360;
    const canvas = await render(job, page, base, region, size, rotation);
    if (canvas && current(job)) {
      show(job, remember(previews, key, { canvas, pageNumber: target.pageNumber, kind: region.kind }, 6));
    }
  }
  viewer.addEventListener('pointerover', event => {
    if (event.pointerType !== 'mouse' || event.buttons || !enabled() || !(event.target instanceof Element)) return;
    const link = event.target.closest(linkSelector);
    if (!link || link === pending?.link) return;
    close();
    const pdf = getDocument(), source = Number(link.closest('.page')?.dataset.pageNumber);
    if (!pdf || !Number.isInteger(source) || source < 1 || source > pdf.numPages) return;
    const job = { link, source, pdf, cache, render: null, timer: null };
    pending = job;
    job.timer = setTimeout(() => { void preview(job).catch(() => { if (pending === job) close(); }); }, hoverDelay);
  }, { passive: true });
  viewer.addEventListener('pointerout', event => {
    if (pending?.link.contains(event.target) && !(event.relatedTarget instanceof Node && pending.link.contains(event.relatedTarget))) close();
  }, { passive: true });
  document.addEventListener('pointerdown', close, { passive: true, capture: true });
  document.addEventListener('contextmenu', close, { passive: true });
  document.addEventListener('selectionchange', () => { if (pending && !enabled()) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); }, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) close(); });
  app.pdfViewer.container.addEventListener('scroll', close, { passive: true });
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  window.addEventListener('pagehide', reset);
  for (const name of ['pagechanging', 'scalechanging', 'rotationchanging', 'cursortoolchanged',
    'annotationeditormodechanged', 'presentationmodechanged']) {
    app.eventBus.on(name, close);
  }
  app.eventBus.on('optionalcontentconfigchanged', reset);
  return { close, reset };
}
