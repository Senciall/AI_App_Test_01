'use strict';
/* ═══════════════════════════════════════════════════════════════
   ImageViewer.js — Image display with pan, zoom, rotate
   Registers as window.Viewers.img
   ═══════════════════════════════════════════════════════════════ */

(function () {

let _shell = null;

const st = {
  centerEl: null,
  img:      null,
  wrap:     null,
  zoom:     1,
  rotate:   0,
  panX:     0,
  panY:     0,
  panning:  false,
  spaceDown:false,
  dragStart:null,
  fileName: '',
  fileExt:  '',
};

// ── Mount ──────────────────────────────────────────────────────
function mount(centerEl, file, shell) {
  _shell = shell;
  st.centerEl = centerEl;
  st.zoom = 1; st.rotate = 0; st.panX = 0; st.panY = 0;
  st.panning = false; st.spaceDown = false; st.dragStart = null;
  st.fileName = file.name || '';
  st.fileExt  = st.fileName.split('.').pop().toLowerCase();

  centerEl.innerHTML = '';
  centerEl.style.cssText = 'overflow:hidden;position:relative;display:flex;align-items:center;justify-content:center;background:#1a1a1a;width:100%;height:100%;';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'transform-origin:center center;transition:transform 0.12s ease;will-change:transform;display:flex;align-items:center;justify-content:center;width:100%;height:100%;';
  st.wrap = wrap;

  const img = document.createElement('img');
  img.style.cssText = 'object-fit:contain;max-width:100%;max-height:100%;user-select:none;-webkit-user-drag:none;';
  img.draggable = false;
  img.src = file.url || ('/api/files/serve?path=' + encodeURIComponent(file.path));
  img.addEventListener('load', () => {
    updateSidebar();
    _shell.setContext({
      label: st.fileName,
      text: 'Image: ' + st.fileName + ', ' + img.naturalWidth + 'x' + img.naturalHeight + 'px, format: ' + st.fileExt.toUpperCase(),
    });
  });
  st.img = img;
  wrap.appendChild(img);
  centerEl.appendChild(wrap);

  setupToolbar();
  setupSidebar();
  bindEvents();
}

function cleanup() {
  unbindEvents();
  st.img = null; st.wrap = null; st.centerEl = null;
}

// ── Transform ──────────────────────────────────────────────────
function applyTransform() {
  if (!st.wrap) return;
  st.wrap.style.transform = 'translate(' + st.panX + 'px,' + st.panY + 'px) scale(' + st.zoom + ') rotate(' + st.rotate + 'deg)';
  var lbl = document.getElementById('iv-zoom-label');
  if (lbl) lbl.textContent = Math.round(st.zoom * 100) + '%';
}

function zoomIn()  { st.zoom = Math.min(st.zoom + 0.25, 10); applyTransform(); }
function zoomOut() { st.zoom = Math.max(st.zoom - 0.25, 0.1); applyTransform(); }
function fitZoom() { st.zoom = 1; st.panX = 0; st.panY = 0; st.rotate = 0; applyTransform(); }
function rotateCCW() { st.rotate = (st.rotate - 90) % 360; applyTransform(); }

// ── Toolbar ────────────────────────────────────────────────────
function setupToolbar() {
  _shell.setToolbarTabs([
    { name: 'View', id: 'view', onActivate: function () { showBand(); } },
  ]);
  showBand();
}

function showBand() {
  var el = document.createElement('div');
  el.className = 'pvr-group';
  el.style.cssText = 'display:flex;align-items:center;gap:6px;';
  el.innerHTML =
    '<button id="iv-zoom-out" title="Zoom out" style="min-width:28px;">&#8722;</button>' +
    '<span id="iv-zoom-label" style="font-size:12px;min-width:42px;text-align:center;color:var(--text);">' + Math.round(st.zoom * 100) + '%</span>' +
    '<button id="iv-zoom-in" title="Zoom in" style="min-width:28px;">+</button>' +
    '<div class="pvr-sep" style="width:1px;height:18px;background:var(--border);margin:0 6px;"></div>' +
    '<button id="iv-rotate" title="Rotate 90\u00B0 counter-clockwise">Rotate \u21BA</button>' +
    '<button id="iv-fit" title="Reset zoom to fit">Fit</button>';
  _shell.setToolbarBandEl(el);
  el.querySelector('#iv-zoom-out').addEventListener('click', zoomOut);
  el.querySelector('#iv-zoom-in').addEventListener('click', zoomIn);
  el.querySelector('#iv-rotate').addEventListener('click', rotateCCW);
  el.querySelector('#iv-fit').addEventListener('click', fitZoom);
}

// ── Sidebar ────────────────────────────────────────────────────
function setupSidebar() {
  var sb = document.createElement('div');
  sb.id = 'iv-sidebar';
  sb.style.cssText = 'font-size:11px;padding:12px;display:flex;flex-direction:column;gap:8px;';
  sb.innerHTML = '<div style="color:var(--text-muted);margin-bottom:4px;font-weight:600;">Image Info</div>' +
    '<div id="iv-meta"></div>';
  _shell.setSidebarContent(sb);
  updateSidebar();
}

function updateSidebar() {
  var meta = document.getElementById('iv-meta');
  if (!meta) return;
  var img = st.img;
  var w = img ? img.naturalWidth : 0;
  var h = img ? img.naturalHeight : 0;
  var sizeEst = (w && h) ? estimateSize(w, h, st.fileExt) : '...';
  var pairs = [
    ['Filename', st.fileName],
    ['Format', st.fileExt.toUpperCase()],
    ['Dimensions', w && h ? w + ' \u00D7 ' + h + ' px' : 'Loading...'],
    ['Est. size', sizeEst],
  ];
  meta.innerHTML = pairs.map(function (p) {
    return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);">' +
      '<span style="color:var(--text-muted);">' + p[0] + '</span>' +
      '<span style="color:var(--text);">' + _shell.escHtml(p[1]) + '</span></div>';
  }).join('');
}

function estimateSize(w, h, ext) {
  var bpp = { png: 4, svg: 0.5, gif: 1, webp: 0.5, jpg: 0.8, jpeg: 0.8 };
  var b = (bpp[ext] || 1) * w * h;
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b > 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

// ── Pan / Zoom events ──────────────────────────────────────────
function onWheel(e) {
  e.preventDefault();
  if (e.deltaY < 0) zoomIn(); else zoomOut();
}

function onKeyDown(e) {
  if (e.code === 'Space' && !st.spaceDown) {
    st.spaceDown = true;
    if (st.centerEl) st.centerEl.style.cursor = 'grab';
    e.preventDefault();
  }
}
function onKeyUp(e) {
  if (e.code === 'Space') {
    st.spaceDown = false;
    if (st.centerEl) st.centerEl.style.cursor = '';
  }
}

function onMouseDown(e) {
  if (!st.spaceDown) return;
  st.panning = true;
  st.dragStart = { x: e.clientX - st.panX, y: e.clientY - st.panY };
  if (st.centerEl) st.centerEl.style.cursor = 'grabbing';
  e.preventDefault();
}
function onMouseMove(e) {
  if (!st.panning || !st.dragStart) return;
  st.panX = e.clientX - st.dragStart.x;
  st.panY = e.clientY - st.dragStart.y;
  if (st.wrap) st.wrap.style.transition = 'none';
  applyTransform();
}
function onMouseUp() {
  if (st.panning) {
    st.panning = false;
    st.dragStart = null;
    if (st.wrap) st.wrap.style.transition = 'transform 0.12s ease';
    if (st.centerEl) st.centerEl.style.cursor = st.spaceDown ? 'grab' : '';
  }
}

var _boundWheel, _boundKeyDown, _boundKeyUp, _boundMouseDown, _boundMouseMove, _boundMouseUp;

function bindEvents() {
  _boundWheel     = onWheel;
  _boundKeyDown   = onKeyDown;
  _boundKeyUp     = onKeyUp;
  _boundMouseDown = onMouseDown;
  _boundMouseMove = onMouseMove;
  _boundMouseUp   = onMouseUp;
  st.centerEl.addEventListener('wheel', _boundWheel, { passive: false });
  document.addEventListener('keydown', _boundKeyDown);
  document.addEventListener('keyup', _boundKeyUp);
  st.centerEl.addEventListener('mousedown', _boundMouseDown);
  document.addEventListener('mousemove', _boundMouseMove);
  document.addEventListener('mouseup', _boundMouseUp);
}

function unbindEvents() {
  if (st.centerEl) st.centerEl.removeEventListener('wheel', _boundWheel);
  document.removeEventListener('keydown', _boundKeyDown);
  document.removeEventListener('keyup', _boundKeyUp);
  if (st.centerEl) st.centerEl.removeEventListener('mousedown', _boundMouseDown);
  document.removeEventListener('mousemove', _boundMouseMove);
  document.removeEventListener('mouseup', _boundMouseUp);
}

// ── Register ───────────────────────────────────────────────────
window.Viewers = window.Viewers || {};
window.Viewers.img = { mount: mount, cleanup: cleanup };

})();
