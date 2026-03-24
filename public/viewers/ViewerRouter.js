'use strict';
/* ═══════════════════════════════════════════════════════════════
   ViewerRouter.js — Detects file type and mounts correct viewer
   ═══════════════════════════════════════════════════════════════ */

(function () {

const VIEWER_MAP = {
  pdf:   'viewers/PDFViewer.js',
  gdoc:  'viewers/GDocViewer.js',
  img:   'viewers/ImageViewer.js',
  xlsx:  'viewers/SpreadsheetViewer.js',
  code:  'viewers/CodeViewer.js',
  doc:   'viewers/DocViewer.js',
  audio: 'viewers/AudioViewer.js',
  video: 'viewers/VideoViewer.js',
};

const loaded = {};

async function loadViewer(type) {
  const src = VIEWER_MAP[type] || VIEWER_MAP.doc;
  if (!loaded[src]) {
    loaded[src] = ViewerShell.loadScript(src);
  }
  await loaded[src];
}

async function route(type, file) {
  const shell = window.ViewerShell;

  // Cleanup previous viewer
  if (shell.state.viewer && shell.state.viewer.cleanup) {
    try { shell.state.viewer.cleanup(); } catch {}
  }
  shell.state.viewer = null;

  const centerEl = shell.getCenterEl();
  centerEl.innerHTML = '<div class="pv-loading">Loading\u2026</div>';

  try {
    await loadViewer(type);

    // Find the viewer in window.Viewers
    const viewers = window.Viewers || {};
    const viewer = viewers[type] || viewers.doc;

    if (!viewer || !viewer.mount) {
      centerEl.innerHTML = '<div class="pv-error">No viewer available for this file type</div>';
      return;
    }

    centerEl.innerHTML = '';
    viewer.mount(centerEl, file, shell);
    shell.registerViewer(viewer);
  } catch (err) {
    centerEl.innerHTML = `<div class="pv-error">Failed to load viewer: ${err.message}</div>`;
  }
}

window.ViewerRouter = { route };

})();
