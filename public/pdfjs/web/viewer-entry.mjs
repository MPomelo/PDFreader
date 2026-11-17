// Pin the integration flags after PDF.js preferences load, before components are
// constructed. The upstream modules remain unmodified.
export function configureViewer(app, options) {
  const initialize = app._initializeViewerComponents;
  app._initializeViewerComponents = function (...args) {
    options.set('enableScripting', false);
    options.set('viewerCssTheme', 1);
    options.set('viewOnLoad', 1); // LocalRepository restores by full content hash.
    options.set('sidebarViewOnLoad', 0); // A single host navigation entry; thumbnails remain in Tools.
    options.set('enableComment', true);
    options.set('enableHighlightFloatingButton', true);
    return initialize.apply(this, args);
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // The same-origin Viewer dispatches webviewerloaded on the parent's document.
  let owner;
  try { owner = parent.document; } catch { owner = document; }
  const configure = event => {
    if (event.detail?.source !== window) return;
    configureViewer(window.PDFViewerApplication, window.PDFViewerApplicationOptions);
  };
  owner.addEventListener('webviewerloaded', configure);
  try {
    const { PDFViewerApplication: app } = await import('./viewer.mjs');
    await app.initializedPromise;
  } finally { owner.removeEventListener('webviewerloaded', configure); }
  await import('./bridge.mjs');
}
