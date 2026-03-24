'use strict';
/* ═══════════════════════════════════════════════════════════════
   pdf-tools.js — Tool implementations for PDF editor
   Depends on: pdf-annotations.js, pdf-history.js
   ═══════════════════════════════════════════════════════════════ */

(function () {

const { screenToPdf, pdfToScreen, createAnnotation, hitTest } = window.PdfAnnotations;
const { AddAnnotationCmd, RemoveAnnotationCmd, MoveAnnotationCmd, ModifyAnnotationCmd } = window.PdfHistory;

// ── Tool registry ───────────────────────────────────────────────

const TOOLS = {
  select:    { cursor: 'default',   label: 'Select',    key: 'v' },
  text:      { cursor: 'text',      label: 'Text',      key: 't' },
  highlight: { cursor: 'crosshair', label: 'Highlight', key: 'h' },
  freehand:  { cursor: 'crosshair', label: 'Pen',       key: 'p' },
  rectangle: { cursor: 'crosshair', label: 'Rectangle', key: 'r' },
  ellipse:   { cursor: 'crosshair', label: 'Ellipse',   key: 'e' },
  line:      { cursor: 'crosshair', label: 'Line',      key: 'l' },
  arrow:     { cursor: 'crosshair', label: 'Arrow',     key: 'a' },
  stickynote:{ cursor: 'crosshair', label: 'Note',      key: 'n' },
  stamp:     { cursor: 'crosshair', label: 'Stamp',     key: 's' },
  eraser:    { cursor: 'crosshair', label: 'Eraser',    key: 'x' },
};

// ── Tool state ──────────────────────────────────────────────────

const ts = {
  active: 'select',
  color: '#FF0000',
  strokeColor: '#000000',
  strokeWidth: 2,
  fillColor: 'transparent',
  fontSize: 14,
  fontFamily: 'Helvetica',
  opacity: 1.0,
  lineStyle: 'solid',
  stampText: 'APPROVED',

  // Drawing state
  drawing: false,
  startX: 0, startY: 0,
  currentPath: [],
  dragAnnotation: null,
  dragStartRect: null,
  dragOffsetX: 0, dragOffsetY: 0,

  // References
  store: null,
  history: null,
  pageHeight: 0,
  scale: 1,
  redrawFn: null,    // () => void
  getPageInfo: null,  // (screenX, screenY) => { pageNum, localX, localY, pageHeight }
};

function init(store, history, opts) {
  ts.store = store;
  ts.history = history;
  ts.redrawFn = opts.redraw;
  ts.getPageInfo = opts.getPageInfo;
  ts.scale = opts.scale || 1;
}

function setTool(name) {
  if (!TOOLS[name]) return;
  ts.active = name;
  ts.drawing = false;
  ts.store.deselect();
  // Cancel any in-progress text editing
  removeActiveTextInput();
}

function setScale(s) { ts.scale = s; }

function getState() { return ts; }

// ── Mouse event handlers ────────────────────────────────────────
// Called by the editor with local coordinates relative to the annotation canvas

function onMouseDown(e, pageNum, localX, localY, pageHeight) {
  ts.pageHeight = pageHeight;
  const pdfPt = screenToPdf(localX, localY, pageHeight, ts.scale);

  switch (ts.active) {
    case 'select':
      handleSelectDown(pageNum, localX, localY, pageHeight);
      break;
    case 'text':
      handleTextDown(pageNum, localX, localY, pageHeight, pdfPt);
      break;
    case 'highlight':
    case 'rectangle':
    case 'ellipse':
      handleShapeDown(pageNum, pdfPt);
      break;
    case 'line':
    case 'arrow':
      handleLineDown(pageNum, pdfPt);
      break;
    case 'freehand':
      handleFreehandDown(pageNum, pdfPt);
      break;
    case 'stickynote':
      handleStickyNoteDown(pageNum, pdfPt);
      break;
    case 'stamp':
      handleStampDown(pageNum, pdfPt);
      break;
    case 'eraser':
      handleEraserDown(pageNum, localX, localY, pageHeight);
      break;
  }
}

function onMouseMove(e, pageNum, localX, localY, pageHeight) {
  if (!ts.drawing) return;
  ts.pageHeight = pageHeight;
  const pdfPt = screenToPdf(localX, localY, pageHeight, ts.scale);

  switch (ts.active) {
    case 'select':
      handleSelectMove(localX, localY, pageHeight);
      break;
    case 'highlight':
    case 'rectangle':
    case 'ellipse':
      handleShapeMove(pdfPt);
      break;
    case 'line':
    case 'arrow':
      handleLineMove(pdfPt);
      break;
    case 'freehand':
      handleFreehandMove(pdfPt);
      break;
  }
}

function onMouseUp(e, pageNum, localX, localY, pageHeight) {
  if (!ts.drawing && ts.active !== 'select') return;
  ts.pageHeight = pageHeight;
  const pdfPt = screenToPdf(localX, localY, pageHeight, ts.scale);

  switch (ts.active) {
    case 'select':
      handleSelectUp();
      break;
    case 'highlight':
      handleShapeUp('highlight');
      break;
    case 'rectangle':
      handleShapeUp('rectangle');
      break;
    case 'ellipse':
      handleShapeUp('ellipse');
      break;
    case 'line':
      handleLineUp('line');
      break;
    case 'arrow':
      handleLineUp('arrow');
      break;
    case 'freehand':
      handleFreehandUp();
      break;
  }

  ts.drawing = false;
}

// ── Select tool ─────────────────────────────────────────────────

function handleSelectDown(pageNum, lx, ly, ph) {
  const annotations = ts.store.getForPage(pageNum);
  const hit = hitTest(annotations, lx, ly, ph, ts.scale);

  if (hit) {
    ts.store.select(hit.id);
    ts.drawing = true;
    ts.dragAnnotation = hit;
    ts.dragStartRect = { ...hit.rect };
    ts.dragOffsetX = lx;
    ts.dragOffsetY = ly;
  } else {
    ts.store.deselect();
    ts.dragAnnotation = null;
  }
  ts.redrawFn();
}

function handleSelectMove(lx, ly, ph) {
  if (!ts.dragAnnotation) return;
  const dx = (lx - ts.dragOffsetX) / ts.scale;
  const dy = -(ly - ts.dragOffsetY) / ts.scale; // flip Y for PDF coords
  const ann = ts.dragAnnotation;

  if (ann.type === 'freehand') {
    // Move all points
    const origRect = ts.dragStartRect;
    // Use offset from start
    const pdfDx = dx;
    const pdfDy = dy;
    // We can't move points directly here during drag — we do it on mouse up
  } else {
    ann.rect.x = ts.dragStartRect.x + dx;
    ann.rect.y = ts.dragStartRect.y + dy;
  }

  ts.dragOffsetX = lx;
  ts.dragOffsetY = ly;
  ts.dragStartRect = { ...ann.rect };
  ts.redrawFn();
}

function handleSelectUp() {
  if (ts.dragAnnotation && ts.dragStartRect) {
    // Record move for undo if position changed
    const ann = ts.dragAnnotation;
    const oldRect = ts.dragStartRect;
    if (oldRect.x !== ann.rect.x || oldRect.y !== ann.rect.y) {
      // Already moved, just record in history
      // We skip the command execute since it's already moved
      ts.history.undoStack.push(new MoveAnnotationCmd(ts.store, ann.id, oldRect, { ...ann.rect }));
      ts.history.redoStack = [];
      if (ts.history.onChange) ts.history.onChange(ts.history.canUndo, ts.history.canRedo);
    }
  }
  ts.dragAnnotation = null;
  ts.dragStartRect = null;
}

// ── Text tool ───────────────────────────────────────────────────

let _activeTextInput = null;

function handleTextDown(pageNum, lx, ly, ph, pdfPt) {
  removeActiveTextInput();
  // Create inline text input at click position
  const input = document.createElement('textarea');
  input.className = 'pve-text-input';
  input.style.left = lx + 'px';
  input.style.top = ly + 'px';
  input.style.fontSize = (ts.fontSize * ts.scale) + 'px';
  input.style.fontFamily = ts.fontFamily;
  input.style.color = ts.color;
  input.placeholder = 'Type here...';

  // Find the annotation canvas container to append to
  const container = document.querySelector(`.pve-page-wrap[data-page="${pageNum}"]`);
  if (!container) return;
  container.appendChild(input);
  input.focus();

  input.addEventListener('blur', () => {
    const text = input.value.trim();
    if (text) {
      const metrics = measureText(text, ts.fontSize, ts.fontFamily);
      const ann = createAnnotation('text', pageNum, {
        rect: { x: pdfPt.x, y: pdfPt.y, width: metrics.width, height: metrics.height },
        content: text,
        color: ts.color,
        fontSize: ts.fontSize,
        fontFamily: ts.fontFamily,
        opacity: ts.opacity,
      });
      ts.history.execute(new AddAnnotationCmd(ts.store, ann));
    }
    input.remove();
    if (_activeTextInput === input) _activeTextInput = null;
    ts.redrawFn();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); }
  });

  _activeTextInput = input;
}

function removeActiveTextInput() {
  if (_activeTextInput) {
    _activeTextInput.blur();
    if (_activeTextInput.parentElement) _activeTextInput.remove();
    _activeTextInput = null;
  }
}

function measureText(text, fontSize, fontFamily) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px ${fontFamily}`;
  const metrics = ctx.measureText(text);
  const lines = text.split('\n').length;
  return { width: metrics.width / 1 + 10, height: fontSize * 1.3 * lines + 4 };
}

// ── Shape tools (highlight, rectangle, ellipse) ─────────────────

let _tempAnnotation = null;

function handleShapeDown(pageNum, pdfPt) {
  ts.drawing = true;
  ts.startX = pdfPt.x;
  ts.startY = pdfPt.y;

  _tempAnnotation = createAnnotation(ts.active, pageNum, {
    rect: { x: pdfPt.x, y: pdfPt.y, width: 0, height: 0 },
    color: ts.active === 'highlight' ? ts.color : ts.strokeColor,
    strokeColor: ts.strokeColor,
    strokeWidth: ts.strokeWidth,
    fillColor: ts.fillColor,
    opacity: ts.active === 'highlight' ? 0.35 : ts.opacity,
    lineStyle: ts.lineStyle,
  });
}

function handleShapeMove(pdfPt) {
  if (!_tempAnnotation) return;
  const x = Math.min(ts.startX, pdfPt.x);
  const y = Math.min(ts.startY, pdfPt.y);
  const w = Math.abs(pdfPt.x - ts.startX);
  const h = Math.abs(pdfPt.y - ts.startY);
  _tempAnnotation.rect = { x, y, width: w, height: h };
  ts.redrawFn(_tempAnnotation);
}

function handleShapeUp(type) {
  if (!_tempAnnotation) return;
  if (_tempAnnotation.rect.width > 2 && _tempAnnotation.rect.height > 2) {
    _tempAnnotation.type = type;
    ts.history.execute(new AddAnnotationCmd(ts.store, _tempAnnotation));
  }
  _tempAnnotation = null;
  ts.redrawFn();
}

// ── Line / Arrow tools ─────────────────────────────────────────

function handleLineDown(pageNum, pdfPt) {
  ts.drawing = true;
  ts.startX = pdfPt.x;
  ts.startY = pdfPt.y;

  _tempAnnotation = createAnnotation(ts.active, pageNum, {
    rect: { x: pdfPt.x, y: pdfPt.y, width: 0, height: 0 },
    strokeColor: ts.strokeColor,
    strokeWidth: ts.strokeWidth,
    color: ts.strokeColor,
    opacity: ts.opacity,
    lineStyle: ts.lineStyle,
  });
}

function handleLineMove(pdfPt) {
  if (!_tempAnnotation) return;
  _tempAnnotation.rect.width = pdfPt.x - ts.startX;
  _tempAnnotation.rect.height = pdfPt.y - ts.startY;
  ts.redrawFn(_tempAnnotation);
}

function handleLineUp(type) {
  if (!_tempAnnotation) return;
  const r = _tempAnnotation.rect;
  if (Math.hypot(r.width, r.height) > 5) {
    _tempAnnotation.type = type;
    ts.history.execute(new AddAnnotationCmd(ts.store, _tempAnnotation));
  }
  _tempAnnotation = null;
  ts.redrawFn();
}

// ── Freehand tool ───────────────────────────────────────────────

function handleFreehandDown(pageNum, pdfPt) {
  ts.drawing = true;
  ts.currentPath = [{ x: pdfPt.x, y: pdfPt.y }];

  _tempAnnotation = createAnnotation('freehand', pageNum, {
    points: ts.currentPath,
    color: ts.color,
    strokeWidth: ts.strokeWidth,
    opacity: ts.opacity,
  });
}

function handleFreehandMove(pdfPt) {
  if (!_tempAnnotation) return;
  ts.currentPath.push({ x: pdfPt.x, y: pdfPt.y });
  _tempAnnotation.points = ts.currentPath;
  ts.redrawFn(_tempAnnotation);
}

function handleFreehandUp() {
  if (!_tempAnnotation || ts.currentPath.length < 2) {
    _tempAnnotation = null;
    ts.currentPath = [];
    return;
  }
  // Calculate bounding rect for the freehand path
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ts.currentPath.forEach(p => {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  });
  _tempAnnotation.rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  ts.history.execute(new AddAnnotationCmd(ts.store, _tempAnnotation));
  _tempAnnotation = null;
  ts.currentPath = [];
  ts.redrawFn();
}

// ── Sticky note tool ────────────────────────────────────────────

function handleStickyNoteDown(pageNum, pdfPt) {
  const content = prompt('Sticky note text:');
  if (!content) return;
  const ann = createAnnotation('stickynote', pageNum, {
    rect: { x: pdfPt.x, y: pdfPt.y, width: 24, height: 24 },
    content,
    color: '#FFEB3B',
  });
  ts.history.execute(new AddAnnotationCmd(ts.store, ann));
  ts.redrawFn();
}

// ── Stamp tool ──────────────────────────────────────────────────

function handleStampDown(pageNum, pdfPt) {
  const ann = createAnnotation('stamp', pageNum, {
    rect: { x: pdfPt.x, y: pdfPt.y, width: 100, height: 30 },
    stampText: ts.stampText,
    content: ts.stampText,
    color: ts.color,
    fontSize: 18,
    opacity: ts.opacity,
  });
  ts.history.execute(new AddAnnotationCmd(ts.store, ann));
  ts.redrawFn();
}

// ── Eraser tool ─────────────────────────────────────────────────

function handleEraserDown(pageNum, lx, ly, ph) {
  const annotations = ts.store.getForPage(pageNum);
  const hit = hitTest(annotations, lx, ly, ph, ts.scale);
  if (hit) {
    ts.history.execute(new RemoveAnnotationCmd(ts.store, hit));
    ts.redrawFn();
  }
}

// ── Delete selected ─────────────────────────────────────────────

function deleteSelected() {
  const ann = ts.store.getSelected();
  if (!ann) return;
  ts.history.execute(new RemoveAnnotationCmd(ts.store, ann));
  ts.redrawFn();
}

// ── Get temp annotation for live preview ────────────────────────

function getTempAnnotation() {
  return _tempAnnotation;
}

// ── Thumbnail rendering ─────────────────────────────────────────

function renderThumbnails(pdfDoc, container, onPageClick) {
  container.innerHTML = '';
  const total = pdfDoc.numPages;

  for (let n = 1; n <= total; n++) {
    const wrap = document.createElement('div');
    wrap.className = 'pve-thumb';
    wrap.dataset.page = n;
    if (n === 1) wrap.classList.add('pve-thumb-active');

    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);

    const label = document.createElement('span');
    label.className = 'pve-thumb-label';
    label.textContent = n;
    wrap.appendChild(label);

    wrap.addEventListener('click', () => {
      container.querySelectorAll('.pve-thumb').forEach(t => t.classList.remove('pve-thumb-active'));
      wrap.classList.add('pve-thumb-active');
      if (onPageClick) onPageClick(n);
    });

    container.appendChild(wrap);

    // Render thumbnail async
    (async (pageNum, cvs) => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const vp = page.getViewport({ scale: 0.2 });
        cvs.width = vp.width;
        cvs.height = vp.height;
        await page.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;
      } catch {}
    })(n, canvas);
  }
}

function setActiveThumbnail(pageNum) {
  document.querySelectorAll('.pve-thumb').forEach(t => {
    t.classList.toggle('pve-thumb-active', +t.dataset.page === pageNum);
  });
  const active = document.querySelector(`.pve-thumb[data-page="${pageNum}"]`);
  if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Exports ─────────────────────────────────────────────────────

window.PdfTools = {
  TOOLS,
  init,
  setTool,
  setScale,
  getState,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  deleteSelected,
  getTempAnnotation,
  renderThumbnails,
  setActiveThumbnail,
  removeActiveTextInput,
};

})();
