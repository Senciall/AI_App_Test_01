'use strict';
/* ═══════════════════════════════════════════════════════════════
   PDFViewer.js — PDF Editor with two-canvas rendering pipeline,
   annotation tools, undo/redo, save/export.
   Depends on: pdf-history.js, pdf-annotations.js, pdf-tools.js,
               pdf-export.js, pdf-editor.css
   ═══════════════════════════════════════════════════════════════ */

(function () {

const PDFJS_SRC    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const PDFLIB_SRC   = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const TIPTAP_SRC   = 'vendors/tiptap-bundle.js';

let _pdfjs  = null;
let _pdfLib = null;
let _shell  = null;

// ── State ───────────────────────────────────────────────────────
const ps = {
  pdfDoc:       null,
  pdfLibDoc:    null,
  pdfBytes:     null,
  pdfUrl:       null,
  scale:        1.5,
  centerEl:     null,
  docId:        null,
  polling:      null,
  progress:     null,
  isBlank:      false,
  tiptapEditor: null,
  docMode:      false,
  editMode:     false,
  originalPdfUrl: null,
  // Editor
  store:   null,   // AnnotationStore
  history: null,   // EditorHistory
  pageHeights: {}, // pageNum → PDF height in points
  pageWidths:  {}, // pageNum → PDF width in points
  dpr: window.devicePixelRatio || 1,
  // Text blocks extracted from PDF
  textBlocks:  {}, // pageNum → [ { id, text, items[], bbox: {x,y,w,h} (PDF coords), fontSize, fontFamily, color, edited: false, newText: null } ]
  activeEditBlock: null, // currently editing block id
};

async function ensurePdfjs() {
  if (_pdfjs) return;
  await _shell.loadScript(PDFJS_SRC);
  _pdfjs = window.pdfjsLib;
  _pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
}

async function ensurePdfLib() {
  if (_pdfLib) return;
  await _shell.loadScript(PDFLIB_SRC);
  _pdfLib = window.PDFLib;
}

// ── Load editor dependencies ────────────────────────────────────
async function ensureEditorModules() {
  const loads = [];
  if (!window.PdfHistory)     loads.push(_shell.loadScript('pdf-history.js'));
  if (!window.PdfAnnotations) loads.push(_shell.loadScript('pdf-annotations.js'));
  if (!window.PdfTools)       loads.push(_shell.loadScript('pdf-tools.js'));
  if (!window.PdfExport)      loads.push(_shell.loadScript('pdf-export.js'));
  _shell.loadCSS('pdf-editor.css');
  await Promise.all(loads);
}

// ══════════════════════════════════════════════════════════════════
//  MOUNT
// ══════════════════════════════════════════════════════════════════

function mount(centerEl, file, shell) {
  _shell = shell;
  ps.centerEl = centerEl;
  ps.pdfDoc = null; ps.pdfLibDoc = null; ps.pdfBytes = null;
  ps.docId = null; ps.isBlank = !!file.blank; ps.docMode = !!file.blank;
  ps.pageHeights = {};
  ps.pdfUrl = file.url || null;

  if (file.blank) {
    createBlankDocument();
  } else {
    initEditor(file);
  }
}

async function initEditor(file) {
  ps.centerEl.innerHTML = '<div class="pve-loading">Loading\u2026</div>';

  try {
    await Promise.all([ensurePdfjs(), ensureEditorModules()]);

    // Create editor state
    ps.store = new window.PdfAnnotations.AnnotationStore();
    ps.history = new window.PdfHistory.EditorHistory();

    ps.store.onChange = () => redrawAllAnnotations();
    ps.history.onChange = (canUndo, canRedo) => updateUndoRedoButtons(canUndo, canRedo);

    window.PdfTools.init(ps.store, ps.history, {
      redraw: redrawAllAnnotations,
      scale: ps.scale,
      getPageInfo: null,
    });

    setupEditorToolbar();
    setupEditorSidebar();
    setupKeyboardShortcuts();

    await loadPdf(file.url);

    // Register with server for indexing
    if (file.file) {
      const fd = new FormData(); fd.append('file', file.file);
      fetch('/api/pdf/upload', { method: 'POST', body: fd }).then(r => r.json())
        .then(r => { if (r.id) { ps.docId = r.id; loadServerAnnotations(r.id); } }).catch(() => {});
    } else if (file.path && file.path !== file.name) {
      fetch('/api/pdf/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filepath: file.path, filename: file.name }) }).then(r => r.json())
        .then(r => { if (r.id) { ps.docId = r.id; loadServerAnnotations(r.id); } }).catch(() => {});
    }

    // Register PDF editor interface so agent can read/edit text blocks
    registerPdfEditorInterface();

  } catch (err) {
    ps.centerEl.innerHTML = `<div class="pve-error">Failed to load: ${err.message}</div>`;
    console.error('[PDFViewer]', err);
  }
}

// ── Register a fake "editor" interface for the agent ────────────
// The agent system in ViewerShell checks window.__activeEditor
// We expose getText() so the agent gets full document text,
// and expose editBlock() so AI doc_ops can modify PDF text.
function registerPdfEditorInterface() {
  const pdfEditorProxy = {
    type: 'pdf',
    getText() {
      return getDocumentText();
    },
    getHTML() {
      return getDocumentText();
    },
    // Used by doc_op execution in ViewerShell
    getBlocks() {
      return getStructuredBlocks();
    },
    editBlock(blockId, newText) {
      return editBlockText(blockId, newText);
    },
    findBlock(searchText, pageNum) {
      return findBlockByText(searchText, pageNum);
    },
    replaceText(oldText, newText) {
      const block = findBlockByText(oldText);
      if (block) {
        editBlockText(block.id, (block.edited ? block.newText : block.text).replace(oldText, newText));
        return true;
      }
      return false;
    },
    // Chain interface stub so TipTap chain() calls don't crash
    chain() {
      return { focus: () => ({ run: () => {} }) };
    },
  };

  window.__activeEditor = pdfEditorProxy;
  window.__activeEditorType = 'pdf';
}

// ══════════════════════════════════════════════════════════════════
//  PDF LOADING & RENDERING
// ══════════════════════════════════════════════════════════════════

async function loadPdf(url) {
  ps.centerEl.innerHTML = '';

  // Create scrollable pages container
  const pagesEl = document.createElement('div');
  pagesEl.className = 'pve-pages';
  pagesEl.dataset.tool = 'select';
  ps.centerEl.appendChild(pagesEl);

  // Create status bar
  const statusBar = document.createElement('div');
  statusBar.className = 'pve-status-bar';
  statusBar.id = 'pve-status-bar';
  statusBar.innerHTML = `
    <span class="pve-status-item" id="pve-page-status">Page 1 of \u2014</span>
    <span class="pve-status-sep"></span>
    <span class="pve-status-item" id="pve-zoom-status">Zoom: ${Math.round(ps.scale * 100)}%</span>
    <span class="pve-status-sep"></span>
    <span class="pve-status-item" id="pve-tool-status">Tool: Select</span>`;
  ps.centerEl.appendChild(statusBar);

  // Fetch PDF bytes for pdf-lib editing later
  if (url.startsWith('blob:') || url.startsWith('http') || url.startsWith('/')) {
    try { ps.pdfBytes = new Uint8Array(await (await fetch(url)).arrayBuffer()); } catch {}
  }

  ps.pdfDoc = await _pdfjs.getDocument(url).promise;
  const total = ps.pdfDoc.numPages;

  updateStatus('page', `Page 1 of ${total}`);

  for (let n = 1; n <= total; n++) {
    await renderPage(n, pagesEl);
  }

  // Render thumbnails
  if (window.PdfTools) {
    const thumbList = document.querySelector('.pve-thumb-list');
    if (thumbList) {
      window.PdfTools.renderThumbnails(ps.pdfDoc, thumbList, (pageNum) => {
        scrollToPage(pageNum);
      });
    }
  }

  // Track scroll for page indicator
  pagesEl.addEventListener('scroll', onPagesScroll);
}

async function renderPage(pageNum, container) {
  const page = await ps.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: ps.scale });
  const dpr = ps.dpr;

  const pdfW = viewport.width / ps.scale;
  const pdfH = viewport.height / ps.scale;
  ps.pageHeights[pageNum] = pdfH;
  ps.pageWidths[pageNum] = pdfW;

  // Page wrapper
  const wrap = document.createElement('div');
  wrap.className = 'pve-page-wrap';
  wrap.dataset.page = pageNum;
  wrap.style.width = viewport.width + 'px';
  wrap.style.height = viewport.height + 'px';

  // PDF canvas (bottom layer)
  const pdfCanvas = document.createElement('canvas');
  pdfCanvas.className = 'pve-page-canvas';
  pdfCanvas.width = viewport.width * dpr;
  pdfCanvas.height = viewport.height * dpr;
  pdfCanvas.style.width = viewport.width + 'px';
  pdfCanvas.style.height = viewport.height + 'px';
  wrap.appendChild(pdfCanvas);

  const pdfCtx = pdfCanvas.getContext('2d');
  pdfCtx.scale(dpr, dpr);
  await page.render({ canvasContext: pdfCtx, viewport }).promise;

  // Text block layer — extract text items and cluster into editable blocks
  const textContent = await page.getTextContent();
  const blocks = clusterTextItems(textContent.items, viewport, pageNum);
  ps.textBlocks[pageNum] = blocks;

  // Create text block overlay container
  const blockLayer = document.createElement('div');
  blockLayer.className = 'pve-block-layer';
  blocks.forEach(block => {
    const el = createBlockOverlay(block, pageNum, pdfH);
    blockLayer.appendChild(el);
  });
  wrap.appendChild(blockLayer);

  // Annotation canvas (top layer — above block layer)
  const annotCanvas = document.createElement('canvas');
  annotCanvas.className = 'pve-annot-canvas';
  annotCanvas.width = viewport.width * dpr;
  annotCanvas.height = viewport.height * dpr;
  annotCanvas.style.width = viewport.width + 'px';
  annotCanvas.style.height = viewport.height + 'px';
  annotCanvas.dataset.page = pageNum;
  wrap.appendChild(annotCanvas);

  // Mouse events on annotation canvas
  bindAnnotCanvasEvents(annotCanvas, pageNum);

  container.appendChild(wrap);
}

// ══════════════════════════════════════════════════════════════════
//  TEXT BLOCK EXTRACTION & EDITING
// ══════════════════════════════════════════════════════════════════

function clusterTextItems(items, viewport, pageNum) {
  if (!items || !items.length) return [];

  // Convert each text item to a positioned block with font info
  const rawItems = items.filter(item => item.str && item.str.trim()).map(item => {
    const tx = item.transform; // [scaleX, skewY, skewX, scaleY, translateX, translateY]
    const fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]); // actual rendered size
    const x = tx[4];
    const y = tx[5];
    const w = item.width;
    const h = item.height || fontSize;
    return {
      str: item.str,
      x, y, w, h,
      fontSize: Math.round(fontSize * 10) / 10,
      fontName: item.fontName || 'sans-serif',
      hasEOL: item.hasEOL,
    };
  });

  // Cluster into paragraph-level blocks: items within ~1.5x line height on same x-column
  const blocks = [];
  let current = null;

  for (const item of rawItems) {
    if (!current) {
      current = newBlock(item, pageNum);
      continue;
    }

    // Check if this item belongs to the current block
    const vertGap = Math.abs(current.lastY - item.y);
    const lineH = current.fontSize * 1.8;
    const sameColumn = Math.abs(item.x - current.bbox.x) < current.fontSize * 4;
    const sameFontSize = Math.abs(item.fontSize - current.fontSize) < 2;

    if (vertGap < lineH && sameColumn && sameFontSize) {
      // Same block — append
      if (item.y !== current.lastY) {
        current.text += '\n' + item.str;
      } else {
        current.text += (current.text.endsWith(' ') || item.str.startsWith(' ') ? '' : ' ') + item.str;
      }
      current.items.push(item);
      current.lastY = item.y;
      // Expand bbox
      const right = Math.max(current.bbox.x + current.bbox.w, item.x + item.w);
      const bottom = Math.min(current.bbox.y, item.y);
      const top = Math.max(current.bbox.y + current.bbox.h, item.y + item.h);
      current.bbox.x = Math.min(current.bbox.x, item.x);
      current.bbox.y = bottom;
      current.bbox.w = right - current.bbox.x;
      current.bbox.h = top - bottom;
    } else {
      // New block
      blocks.push(current);
      current = newBlock(item, pageNum);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function newBlock(item, pageNum) {
  return {
    id: `tb_${pageNum}_${Math.random().toString(36).slice(2, 8)}`,
    page: pageNum,
    text: item.str,
    items: [item],
    bbox: { x: item.x, y: item.y, w: item.w, h: item.h },
    fontSize: item.fontSize,
    fontName: item.fontName,
    lastY: item.y,
    edited: false,
    newText: null,
  };
}

function createBlockOverlay(block, pageNum, pageHeight) {
  const s = ps.scale;
  // Convert PDF coords (origin bottom-left) to screen coords (origin top-left)
  const screenX = block.bbox.x * s;
  const screenY = (pageHeight - block.bbox.y - block.bbox.h) * s;
  const screenW = block.bbox.w * s;
  const screenH = block.bbox.h * s;

  const el = document.createElement('div');
  el.className = 'pve-text-block';
  el.dataset.blockId = block.id;
  el.dataset.page = pageNum;
  el.style.left = screenX + 'px';
  el.style.top = screenY + 'px';
  el.style.width = Math.max(screenW, 20) + 'px';
  el.style.height = Math.max(screenH, 10) + 'px';

  // Click to select + send to agent context
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    selectTextBlock(block, el, pageNum);
  });

  // Double-click to edit inline
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    activateBlockEditing(block, el, pageNum);
  });

  return el;
}

function selectTextBlock(block, el, pageNum) {
  // Deselect previous
  document.querySelectorAll('.pve-text-block.pve-block-selected').forEach(b => b.classList.remove('pve-block-selected'));
  el.classList.add('pve-block-selected');

  // Send to agent panel context
  if (_shell) {
    _shell.setContext({
      label: `Page ${pageNum}, Block`,
      text: block.edited ? block.newText : block.text,
      extra: `Font: ${block.fontName}, Size: ${Math.round(block.fontSize)}pt\nPosition: (${Math.round(block.bbox.x)}, ${Math.round(block.bbox.y)})\nPage ${pageNum} of ${ps.pdfDoc?.numPages || '?'}`,
      blockId: block.id,
      pageNum: pageNum,
    });
  }
}

function activateBlockEditing(block, el, pageNum) {
  // Don't double-activate
  if (ps.activeEditBlock === block.id) return;
  deactivateBlockEditing();

  ps.activeEditBlock = block.id;
  el.classList.add('pve-block-editing');

  // Hide the annotation canvas pointer events so we can type
  const annotCanvas = ps.centerEl.querySelector(`.pve-annot-canvas[data-page="${pageNum}"]`);
  if (annotCanvas) annotCanvas.style.pointerEvents = 'none';

  // Create editable textarea matching the block's position/style
  const textarea = document.createElement('textarea');
  textarea.className = 'pve-block-editor';
  textarea.value = block.edited ? block.newText : block.text;
  textarea.style.left = el.style.left;
  textarea.style.top = el.style.top;
  textarea.style.width = Math.max(parseFloat(el.style.width), 60) + 'px';
  textarea.style.minHeight = el.style.height;
  textarea.style.fontSize = (block.fontSize * ps.scale) + 'px';
  textarea.style.fontFamily = mapPdfFont(block.fontName);

  const wrap = el.closest('.pve-page-wrap');
  wrap.appendChild(textarea);
  textarea.focus();
  textarea.select();

  // On blur, commit the edit
  textarea.addEventListener('blur', () => {
    const newText = textarea.value;
    if (newText !== block.text) {
      block.edited = true;
      block.newText = newText;
      // Visual indicator that this block has been edited
      el.classList.add('pve-block-dirty');
      el.title = 'Edited: ' + newText.slice(0, 60);
    }
    textarea.remove();
    el.classList.remove('pve-block-editing');
    ps.activeEditBlock = null;
    if (annotCanvas) annotCanvas.style.pointerEvents = '';
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { textarea.value = block.edited ? block.newText : block.text; textarea.blur(); }
    // Enter without shift commits
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textarea.blur(); }
    e.stopPropagation(); // don't trigger keyboard shortcuts
  });
}

function deactivateBlockEditing() {
  if (!ps.activeEditBlock) return;
  const editor = ps.centerEl.querySelector('.pve-block-editor');
  if (editor) editor.blur();
  ps.activeEditBlock = null;
}

function mapPdfFont(fontName) {
  // Map common PDF font names to CSS
  const fn = (fontName || '').toLowerCase();
  if (fn.includes('times')) return "'Times New Roman', Times, serif";
  if (fn.includes('courier') || fn.includes('mono')) return "'Courier New', Courier, monospace";
  if (fn.includes('arial') || fn.includes('helvetica')) return "Helvetica, Arial, sans-serif";
  if (fn.includes('georgia')) return "Georgia, serif";
  if (fn.includes('calibri')) return "Calibri, sans-serif";
  if (fn.includes('cambria')) return "Cambria, serif";
  return "Helvetica, Arial, sans-serif";
}

// ── Get full document text for agent ────────────────────────────
function getDocumentText() {
  const pages = Object.keys(ps.textBlocks).sort((a, b) => +a - +b);
  let text = '';
  pages.forEach(pn => {
    text += `\n--- Page ${pn} ---\n`;
    ps.textBlocks[pn].forEach(block => {
      text += (block.edited ? block.newText : block.text) + '\n';
    });
  });
  return text.trim();
}

// ── Get structured blocks for agent ─────────────────────────────
function getStructuredBlocks() {
  const result = [];
  Object.entries(ps.textBlocks).forEach(([pageNum, blocks]) => {
    blocks.forEach(block => {
      result.push({
        id: block.id,
        page: parseInt(pageNum),
        text: block.edited ? block.newText : block.text,
        fontSize: block.fontSize,
        fontName: block.fontName,
        edited: block.edited,
        bbox: block.bbox,
      });
    });
  });
  return result;
}

// ── AI edit: replace block text programmatically ────────────────
function editBlockText(blockId, newText) {
  for (const [pageNum, blocks] of Object.entries(ps.textBlocks)) {
    const block = blocks.find(b => b.id === blockId);
    if (block) {
      block.edited = true;
      block.newText = newText;
      // Update visual
      const el = ps.centerEl.querySelector(`[data-block-id="${blockId}"]`);
      if (el) {
        el.classList.add('pve-block-dirty');
        el.title = 'AI edited: ' + newText.slice(0, 60);
      }
      return true;
    }
  }
  return false;
}

// ── Find block by text match (for AI editing by content) ────────
function findBlockByText(searchText, pageNum) {
  const pages = pageNum ? [pageNum] : Object.keys(ps.textBlocks);
  for (const pn of pages) {
    const blocks = ps.textBlocks[pn] || [];
    // Exact match first
    const exact = blocks.find(b => (b.edited ? b.newText : b.text) === searchText);
    if (exact) return exact;
    // Partial match
    const partial = blocks.find(b => (b.edited ? b.newText : b.text).includes(searchText));
    if (partial) return partial;
  }
  return null;
}

function bindAnnotCanvasEvents(canvas, pageNum) {
  const getLocal = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener('mousedown', (e) => {
    const pos = getLocal(e);
    const ph = ps.pageHeights[pageNum] || 792;
    window.PdfTools.onMouseDown(e, pageNum, pos.x, pos.y, ph);
  });

  canvas.addEventListener('mousemove', (e) => {
    const pos = getLocal(e);
    const ph = ps.pageHeights[pageNum] || 792;
    window.PdfTools.onMouseMove(e, pageNum, pos.x, pos.y, ph);
  });

  canvas.addEventListener('mouseup', (e) => {
    const pos = getLocal(e);
    const ph = ps.pageHeights[pageNum] || 792;
    window.PdfTools.onMouseUp(e, pageNum, pos.x, pos.y, ph);
  });
}

// ══════════════════════════════════════════════════════════════════
//  PDF → HTML EXTRACTION  (for edit-mode)
// ══════════════════════════════════════════════════════════════════

async function extractPdfToHtml(pdfDoc) {
  const allBlocks = [];

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const vp   = page.getViewport({ scale: 1 });
    const tc   = await page.getTextContent();
    const blocks = clusterTextItems(tc.items, vp, n);
    allBlocks.push({ pageNum: n, blocks });
  }

  // Determine modal (most common) font size → treat as body
  const sizes = [];
  allBlocks.forEach(p => p.blocks.forEach(b => sizes.push(Math.round(b.fontSize))));
  const freq = {};
  sizes.forEach(s => { freq[s] = (freq[s] || 0) + 1; });
  const bodySize = +Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || 12;

  let html = '';

  for (let pi = 0; pi < allBlocks.length; pi++) {
    const { blocks } = allBlocks[pi];
    if (pi > 0) html += '<hr data-page-break="true">\n';

    // Try to detect table-like grid on this page
    const table = detectTable(blocks);
    if (table) {
      html += tableToHtml(table);
      // Emit remaining non-table blocks
      const tableIds = new Set(table.cells.map(c => c.blockId));
      blocks.filter(b => !tableIds.has(b.id)).forEach(b => {
        html += blockToHtml(b, bodySize);
      });
    } else {
      blocks.forEach(b => { html += blockToHtml(b, bodySize); });
    }
  }

  return html;
}

function blockToHtml(block, bodySize) {
  const text = escHtml(block.edited ? block.newText : block.text).replace(/\n/g, '<br>');
  const sz   = block.fontSize;
  const bold = (block.fontName || '').toLowerCase().includes('bold');

  // Classify by font size relative to body
  if (sz > bodySize * 1.45)      return `<h1>${text}</h1>\n`;
  if (sz > bodySize * 1.2)       return `<h2>${text}</h2>\n`;
  if (sz > bodySize * 1.05 && bold) return `<h3>${text}</h3>\n`;
  if (bold && text.length < 100) return `<h4>${text}</h4>\n`;
  return `<p>${text}</p>\n`;
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Simple table detection heuristic ─────────────────────────────
// Looks for blocks aligned into a grid (≥2 cols × ≥2 rows)

function detectTable(blocks) {
  if (blocks.length < 4) return null;

  // Snap x-coords into columns (tolerance: 8pt)
  const xs = blocks.map(b => b.bbox.x).sort((a, b) => a - b);
  const cols = [xs[0]];
  xs.forEach(x => { if (Math.abs(x - cols[cols.length - 1]) > 8) cols.push(x); });
  if (cols.length < 2) return null;

  // Snap y-coords into rows
  const ys = blocks.map(b => b.bbox.y).sort((a, b) => b - a); // descending (PDF y)
  const rows = [ys[0]];
  ys.forEach(y => { if (Math.abs(y - rows[rows.length - 1]) > 8) rows.push(y); });
  if (rows.length < 2) return null;

  // Check if enough blocks fall on grid intersections
  const cells = [];
  blocks.forEach(b => {
    const ci = cols.findIndex(c => Math.abs(b.bbox.x - c) < 8);
    const ri = rows.findIndex(r => Math.abs(b.bbox.y - r) < 8);
    if (ci >= 0 && ri >= 0) cells.push({ col: ci, row: ri, text: b.edited ? b.newText : b.text, blockId: b.id });
  });

  // Need at least 60% of blocks on grid to consider it a table
  if (cells.length < blocks.length * 0.6) return null;
  if (cells.length < 4) return null;

  return { cols: cols.length, rows: rows.length, cells };
}

function tableToHtml(table) {
  const grid = Array.from({ length: table.rows }, () => Array(table.cols).fill(''));
  table.cells.forEach(c => {
    if (c.row < table.rows && c.col < table.cols) grid[c.row][c.col] = escHtml(c.text);
  });
  let html = '<table>\n';
  grid.forEach((row, ri) => {
    html += '<tr>';
    row.forEach(cell => {
      const tag = ri === 0 ? 'th' : 'td';
      html += `<${tag}>${cell}</${tag}>`;
    });
    html += '</tr>\n';
  });
  html += '</table>\n';
  return html;
}

// ══════════════════════════════════════════════════════════════════
//  EDIT MODE (PDF → TipTap)
// ══════════════════════════════════════════════════════════════════

async function enterEditMode() {
  if (ps.editMode) return;
  ps.editMode = true;
  ps.originalPdfUrl = ps.pdfUrl;

  _shell.showDot('analyzing');

  try {
    // 1. Extract PDF content into HTML
    const html = await extractPdfToHtml(ps.pdfDoc);

    // 2. Load TipTap
    await _shell.loadScript(TIPTAP_SRC);
    const T = window.TipTap;
    if (!T || !T.Editor) throw new Error('TipTap failed to load');

    // 3. Replace the canvas view with a TipTap editor
    ps.centerEl.innerHTML = '';
    ps.centerEl.className = 'pv-doc-center';

    const page = document.createElement('div');
    page.className = 'pv-doc-page';
    const editorEl = document.createElement('div');
    editorEl.id = 'pv-tiptap-editor';
    page.appendChild(editorEl);
    ps.centerEl.appendChild(page);

    // Info banner
    const banner = document.createElement('div');
    banner.className = 'pve-edit-banner';
    banner.textContent = 'Document converted to editable format. Some formatting may differ from the original PDF.';
    banner.addEventListener('click', () => banner.remove());
    ps.centerEl.insertBefore(banner, page);
    setTimeout(() => banner.remove(), 6000);

    // 4. Create TipTap editor with extracted content
    ps.tiptapEditor = new T.Editor({
      element: editorEl,
      extensions: [
        T.StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, codeBlock: { HTMLAttributes: { class: 'pv-code-block' } } }),
        T.Underline,
        T.TextAlign.configure({ types: ['heading', 'paragraph'] }),
        T.Table.configure({ resizable: true }),
        T.TableRow, T.TableCell, T.TableHeader,
        T.Image.configure({ inline: true }),
        T.Placeholder.configure({ placeholder: 'Start editing...' }),
        T.Highlight.configure({ multicolor: true }),
        T.TextStyle, T.Color,
        T.TaskList, T.TaskItem.configure({ nested: true }),
        T.Link.configure({ openOnClick: false }),
        T.Subscript, T.Superscript,
      ],
      content: html,
      autofocus: 'start',
      onUpdate: () => { updateDocOutline(); },
    });

    if (_shell.registerEditor) _shell.registerEditor(ps.tiptapEditor, 'tiptap');

    // 5. Swap toolbar to doc-style
    buildDocFlatToolbar();
    setupDocSidebar();

    _shell.showDot('ready');
    setTimeout(() => _shell.hideDot(), 1500);
  } catch (err) {
    console.error('[enterEditMode]', err);
    ps.editMode = false;
    _shell.showDot('error');
    ps.centerEl.innerHTML = `<div class="pve-error">Failed to enter edit mode: ${err.message}</div>`;
  }
}

async function exitEditMode(keepChanges) {
  if (!ps.editMode) return;

  // If keeping changes, export TipTap → PDF first (updates ps.pdfUrl)
  if (keepChanges && ps.tiptapEditor) {
    await exportEditedPdf();
  }

  // Destroy TipTap
  if (ps.tiptapEditor) { ps.tiptapEditor.destroy(); ps.tiptapEditor = null; }
  if (_shell && _shell.unregisterEditor) _shell.unregisterEditor();

  ps.editMode = false;

  // Pick URL: if we kept changes the exportEditedPdf updated ps.pdfUrl,
  // otherwise revert to the original
  const url = keepChanges ? (ps.pdfUrl || ps.originalPdfUrl) : (ps.originalPdfUrl || ps.pdfUrl);

  // Restore the PDF viewer
  ps.centerEl.className = '';
  ps.pdfDoc = null; // force reload
  if (url) {
    await initEditor({ url });
  }
}

async function exportEditedPdf() {
  const e = ps.tiptapEditor;
  if (!e) return;

  _shell.showDot('analyzing');
  try {
    await ensurePdfLib();
    const doc = await _pdfLib.PDFDocument.create();
    const font      = await doc.embedFont(_pdfLib.StandardFonts.Helvetica);
    const fontBold  = await doc.embedFont(_pdfLib.StandardFonts.HelveticaBold);
    const fontItalic = await doc.embedFont(_pdfLib.StandardFonts.HelveticaOblique);
    const courier   = await doc.embedFont(_pdfLib.StandardFonts.Courier);

    const W = 612, H = 792, M = 60, CW = W - M * 2, LH = 1.45;
    let page = doc.addPage([W, H]);
    let yPos = H - M;

    function np() { page = doc.addPage([W, H]); yPos = H - M; }

    function wrapAndDraw(text, sz, f, indent, color) {
      if (!text || !text.trim()) { yPos -= sz * 0.5; return; }
      const clr = color || _pdfLib.rgb(0, 0, 0);
      const maxW = CW - (indent || 0);
      const words = text.split(' ');
      let line = '';

      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        let tw;
        try { tw = f.widthOfTextAtSize(test, sz); } catch { tw = test.length * sz * 0.5; }
        if (tw > maxW && line) {
          if (yPos - sz < M) np();
          try { page.drawText(line, { x: M + (indent || 0), y: yPos - sz, size: sz, font: f, color: clr }); } catch {}
          yPos -= sz * LH;
          line = word;
        } else {
          line = test;
        }
      }
      if (line) {
        if (yPos - sz < M) np();
        try { page.drawText(line, { x: M + (indent || 0), y: yPos - sz, size: sz, font: f, color: clr }); } catch {}
        yPos -= sz * LH;
      }
    }

    function drawNode(node, depth) {
      if (!node) return;
      const name = node.type?.name;

      if (name === 'heading') {
        const sz = { 1: 26, 2: 22, 3: 18, 4: 15 }[node.attrs?.level] || 15;
        yPos -= sz * 0.4;
        wrapAndDraw(node.textContent, sz, fontBold, 0);
        yPos -= sz * 0.2;
      } else if (name === 'paragraph') {
        const text = node.textContent;
        if (!text.trim()) { yPos -= 8; return; }
        // Check for inline bold/italic
        let usedFont = font;
        if (node.content?.content?.length === 1) {
          const marks = node.content.content[0].marks || [];
          if (marks.some(m => m.type.name === 'bold')) usedFont = fontBold;
          else if (marks.some(m => m.type.name === 'italic')) usedFont = fontItalic;
        }
        wrapAndDraw(text, 12, usedFont, depth > 0 ? 18 : 0);
        yPos -= 3;
      } else if (name === 'bulletList') {
        if (node.content?.content) {
          node.content.content.forEach(item => {
            wrapAndDraw('\u2022 ' + item.textContent, 12, font, 18);
          });
        }
        yPos -= 4;
      } else if (name === 'orderedList') {
        if (node.content?.content) {
          node.content.content.forEach((item, idx) => {
            wrapAndDraw(`${idx + 1}. ` + item.textContent, 12, font, 18);
          });
        }
        yPos -= 4;
      } else if (name === 'taskList') {
        if (node.content?.content) {
          node.content.content.forEach(item => {
            const check = item.attrs?.checked ? '\u2611' : '\u2610';
            wrapAndDraw(check + ' ' + item.textContent, 12, font, 18);
          });
        }
        yPos -= 4;
      } else if (name === 'blockquote') {
        // Draw a left border line then render children indented
        const startY = yPos;
        if (node.content?.content) {
          node.content.content.forEach(child => drawNode(child, depth + 1));
        }
        page.drawLine({
          start: { x: M + 8, y: startY },
          end: { x: M + 8, y: yPos + 4 },
          thickness: 2,
          color: _pdfLib.rgb(0.75, 0.75, 0.75),
        });
        yPos -= 4;
      } else if (name === 'codeBlock') {
        wrapAndDraw(node.textContent, 10, courier, 12);
        yPos -= 6;
      } else if (name === 'table') {
        drawTable(node, page, doc);
      } else if (name === 'horizontalRule') {
        if (yPos - 20 < M) np();
        page.drawLine({ start: { x: M, y: yPos - 10 }, end: { x: W - M, y: yPos - 10 }, thickness: 0.5, color: _pdfLib.rgb(0.7, 0.7, 0.7) });
        yPos -= 20;
      } else if (name === 'image') {
        // Skip images for now — just note them
        yPos -= 12;
        wrapAndDraw('[Image]', 10, fontItalic, 0, _pdfLib.rgb(0.5, 0.5, 0.5));
      } else if (node.content?.content) {
        // Generic container — recurse
        node.content.content.forEach(child => drawNode(child, depth));
      }
    }

    function drawTable(tableNode) {
      if (!tableNode.content?.content) return;
      const rows = tableNode.content.content;
      const numCols = rows[0]?.content?.content?.length || 1;
      const colW = CW / numCols;
      const cellPad = 6;
      const cellFontSz = 10;

      rows.forEach((row, ri) => {
        // Estimate row height
        let maxH = cellFontSz * LH + cellPad * 2;
        const cells = row.content?.content || [];
        cells.forEach(cell => {
          const text = cell.textContent || '';
          let tw; try { tw = font.widthOfTextAtSize(text, cellFontSz); } catch { tw = text.length * cellFontSz * 0.5; }
          const lines = Math.max(1, Math.ceil(tw / (colW - cellPad * 2)));
          maxH = Math.max(maxH, lines * cellFontSz * LH + cellPad * 2);
        });

        if (yPos - maxH < M) np();

        cells.forEach((cell, ci) => {
          const x = M + ci * colW;
          const y = yPos;
          // Cell border
          page.drawRectangle({ x, y: y - maxH, width: colW, height: maxH, borderColor: _pdfLib.rgb(0.7, 0.7, 0.7), borderWidth: 0.5 });
          // Header fill
          if (ri === 0) {
            page.drawRectangle({ x: x + 0.5, y: y - maxH + 0.5, width: colW - 1, height: maxH - 1, color: _pdfLib.rgb(0.94, 0.94, 0.94) });
          }
          // Text
          const text = cell.textContent || '';
          const f = ri === 0 ? fontBold : font;
          try { page.drawText(text.slice(0, 200), { x: x + cellPad, y: y - cellPad - cellFontSz, size: cellFontSz, font: f, color: _pdfLib.rgb(0, 0, 0), maxWidth: colW - cellPad * 2 }); } catch {}
        });

        yPos -= maxH;
      });
      yPos -= 8;
    }

    // Walk TipTap document tree
    if (e.state.doc.content?.content) {
      e.state.doc.content.content.forEach(node => drawNode(node, 0));
    }

    const bytes = await doc.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    // Update internal state so "exit edit mode" can reload this PDF
    ps.pdfBytes = new Uint8Array(bytes);
    ps.pdfUrl = url;

    // Also trigger a download
    const a = document.createElement('a');
    a.href = url;
    a.download = (_shell.state.fileName || 'document').replace(/\.pdf$/i, '') + '-edited.pdf';
    a.click();

    _shell.showDot('ready');
    setTimeout(() => _shell.hideDot(), 2000);
  } catch (err) {
    console.error('[exportEditedPdf]', err);
    _shell.showDot('error');
  }
}

// ══════════════════════════════════════════════════════════════════
//  ANNOTATION RENDERING
// ══════════════════════════════════════════════════════════════════

function redrawAllAnnotations(tempAnnotation) {
  const canvases = ps.centerEl.querySelectorAll('.pve-annot-canvas');
  canvases.forEach(canvas => {
    const pageNum = parseInt(canvas.dataset.page);
    const ctx = canvas.getContext('2d');
    const dpr = ps.dpr;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const annotations = ps.store.getForPage(pageNum);
    const ph = ps.pageHeights[pageNum] || 792;

    // Render stored annotations
    window.PdfAnnotations.renderAnnotations(ctx, annotations, ph, ps.scale, ps.store.selected, dpr);

    // Render temp annotation (in-progress drawing)
    if (tempAnnotation && tempAnnotation.page === pageNum) {
      ctx.save();
      ctx.scale(dpr, dpr);
      window.PdfAnnotations.renderAnnotations(
        ctx, [tempAnnotation], ph, ps.scale, null, 1  // dpr already applied
      );
      ctx.restore();
    }
  });
}

// ══════════════════════════════════════════════════════════════════
//  TOOLBAR
// ══════════════════════════════════════════════════════════════════

function setupEditorToolbar() {
  _shell.setToolbarTabs([]);   // no tabs — single flat toolbar
  buildFlatToolbar();
}

function buildFlatToolbar() {
  const el = document.createElement('div');
  el.className = 'pvr-gdocs-bar';
  const ts = window.PdfTools.getState();

  el.innerHTML = `
    <!-- Undo / Redo / Print -->
    <button class="pvr-ib" id="pve-undo" title="Undo (Ctrl+Z)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 10h10a5 5 0 0 1 0 10H9"/><polyline points="7 14 3 10 7 6"/></svg>
    </button>
    <button class="pvr-ib" id="pve-redo" title="Redo (Ctrl+Y)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 10H11a5 5 0 0 0 0 10h4"/><polyline points="17 14 21 10 17 6"/></svg>
    </button>
    <button class="pvr-ib" id="pve-print" title="Print (Ctrl+P)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Zoom -->
    <button class="pvr-ib pvr-sm" id="pve-zm-out" title="Zoom out (Ctrl+-)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <span class="pvr-zoom-pct" id="pve-zoom-pct">${Math.round(ps.scale * 100)}%</span>
    <button class="pvr-ib pvr-sm" id="pve-zm-in" title="Zoom in (Ctrl++)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Font family -->
    <select class="pvr-select" id="pve-ff" title="Font family">
      <option value="Helvetica">Arial</option>
      <option value="Times-Roman">Times</option>
      <option value="Courier">Courier</option>
      <option value="Georgia">Georgia</option>
    </select>

    <span class="pvr-div"></span>

    <!-- Font size -->
    <button class="pvr-ib pvr-sm" id="pve-sz-down" title="Decrease font size">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <input type="text" class="pvr-sz-input" id="pve-sz-val" value="${ts.fontSize}" title="Font size">
    <button class="pvr-ib pvr-sm" id="pve-sz-up" title="Increase font size">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- B  I  U  Font-color  Highlight-color -->
    <button class="pvr-ib pvr-fmt" id="pve-bold" title="Bold"><strong>B</strong></button>
    <button class="pvr-ib pvr-fmt" id="pve-italic" title="Italic"><em>I</em></button>
    <button class="pvr-ib pvr-fmt" id="pve-underline" title="Underline"><span style="text-decoration:underline">U</span></button>
    <button class="pvr-ib pvr-clr-btn" id="pve-fclr-btn" title="Font color">
      <span class="pvr-clr-letter">A</span><span class="pvr-clr-bar" id="pve-fclr-bar" style="background:${ts.color}"></span>
    </button>
    <input type="color" id="pve-fclr" value="${ts.color}" style="display:none">
    <button class="pvr-ib pvr-clr-btn" id="pve-hclr-btn" title="Highlight color">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v2H3zm4-4l7-7 3 3-7 7H7v-3z"/></svg>
      <span class="pvr-clr-bar" id="pve-hclr-bar" style="background:#facc15"></span>
    </button>
    <input type="color" id="pve-hclr" value="#facc15" style="display:none">

    <span class="pvr-div"></span>

    <!-- Select / Text tools -->
    <button class="pvr-ib pvr-active" data-tool="select" title="Select (V)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51z"/></svg>
    </button>
    <button class="pvr-ib" data-tool="text" title="Text (T)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
    </button>
    <button class="pvr-ib" data-tool="eraser" title="Eraser (X)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20H7L3 16l9-9 8 8-4 4z"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Drawing tools -->
    <button class="pvr-ib" data-tool="freehand" title="Pen (P)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>
    </button>
    <button class="pvr-ib" data-tool="highlight" title="Highlight (H)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" opacity="0.8"><path d="M3 18h18v2H3zm4-4l7-7 3 3-7 7H7v-3z"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Shape tools -->
    <button class="pvr-ib" data-tool="rectangle" title="Rectangle (R)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
    </button>
    <button class="pvr-ib" data-tool="ellipse" title="Ellipse (E)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="10" ry="7"/></svg>
    </button>
    <button class="pvr-ib" data-tool="line" title="Line (L)">
      <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><line x1="4" y1="20" x2="20" y2="4"/></svg>
    </button>
    <button class="pvr-ib" data-tool="arrow" title="Arrow (A)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="12 5 19 5 19 12"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Line / paragraph spacing -->
    <span class="pvr-drop-wrap" id="pve-spacing-wrap">
      <button class="pvr-ib" id="pve-spacing-btn" title="Line & paragraph spacing">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="21" y1="6"  x2="11" y2="6"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="18" x2="11" y2="18"/>
          <polyline points="7 8 5 6 3 8"/><polyline points="3 16 5 18 7 16"/><line x1="5" y1="6" x2="5" y2="18"/>
        </svg>
      </button>
      <div class="pvr-spacing-dd" id="pve-spacing-dd">
        <div class="pvr-dd-label">Line spacing</div>
        <button class="pvr-dd-opt" data-lh="1">Single</button>
        <button class="pvr-dd-opt" data-lh="1.15">1.15</button>
        <button class="pvr-dd-opt pvr-dd-opt-on" data-lh="1.5">1.5</button>
        <button class="pvr-dd-opt" data-lh="2">Double</button>
        <div class="pvr-dd-sep"></div>
        <div class="pvr-dd-label">Paragraph spacing</div>
        <button class="pvr-dd-opt" data-ps="add">Add space before paragraph</button>
        <button class="pvr-dd-opt" data-ps="remove">Remove space before paragraph</button>
      </div>
    </span>

    <span class="pvr-div"></span>

    <!-- Note / Stamp / Add page -->
    <button class="pvr-ib" data-tool="stickynote" title="Sticky note (N)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" opacity="0.7"><path d="M20 2H4a2 2 0 0 0-2 2v16l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>
    </button>
    <span class="pvr-drop-wrap" id="pve-stamp-wrap">
      <button class="pvr-ib" id="pve-stamp-trigger" title="Stamp (S)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M8 10h8M8 14h4"/></svg>
      </button>
      <div class="pvr-spacing-dd" id="pve-stamp-dd">
        <button class="pve-stamp-option" data-stamp="APPROVED">APPROVED</button>
        <button class="pve-stamp-option" data-stamp="REJECTED">REJECTED</button>
        <button class="pve-stamp-option" data-stamp="DRAFT">DRAFT</button>
        <button class="pve-stamp-option" data-stamp="CONFIDENTIAL">CONFIDENTIAL</button>
        <button class="pve-stamp-option" data-stamp="FINAL">FINAL</button>
      </div>
    </span>
    <button class="pvr-ib" id="pve-add-pg" title="Add page">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Stroke width + color swatches -->
    <input type="range" id="pve-stroke-w" min="1" max="20" value="${ts.strokeWidth}" class="pvr-slider" title="Stroke width" style="width:55px">
    <div class="pvr-swatches">
      <button class="pvr-sw pvr-sw-on" data-color="#ef4444" style="background:#ef4444"></button>
      <button class="pvr-sw" data-color="#f59e0b" style="background:#f59e0b"></button>
      <button class="pvr-sw" data-color="#22c55e" style="background:#22c55e"></button>
      <button class="pvr-sw" data-color="#3b82f6" style="background:#3b82f6"></button>
      <button class="pvr-sw" data-color="#000000" style="background:#000;border:1px solid rgba(255,255,255,0.25)"></button>
    </div>
    <input type="color" id="pve-fill-clr" value="#ffffff" class="pvr-fill-swatch" title="Fill color">
    <label class="pvr-fill-lbl"><input type="checkbox" id="pve-fill-tog"> Fill</label>

    <!-- Spacer -->
    <span style="flex:1"></span>

    <!-- Save / Export / Rotate -->
    <button class="pvr-ib" id="pve-save" title="Save (Ctrl+S)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
    </button>
    <button class="pvr-ib" id="pve-export" title="Export PDF" style="color:var(--accent)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="pvr-ib" id="pve-rotate" title="Rotate 90\u00B0 CW">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21.5 2v6h-6"/><path d="M22 13A10 10 0 1 1 19.1 4.6"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Edit mode toggle -->
    <button class="pvr-ib pvr-edit-mode-btn" id="pve-edit-mode" title="Edit as document (reflowable text, tables, paragraphs)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
      <span style="font-size:11px">Edit</span>
    </button>

    <!-- Mode badge -->
    <span class="pvr-mode-badge" id="pve-mode-badge">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      Viewing
    </span>
  `;

  _shell.setToolbarBandEl(el);
  wireFlatToolbar(el);
}

function wireFlatToolbar(el) {
  const ts = window.PdfTools.getState();

  // ── Undo / Redo / Print ─────────────────────────────────────
  el.querySelector('#pve-undo').addEventListener('click', () => ps.history.undo());
  el.querySelector('#pve-redo').addEventListener('click', () => ps.history.redo());
  el.querySelector('#pve-print').addEventListener('click', () => window.print());

  // ── Zoom ────────────────────────────────────────────────────
  el.querySelector('#pve-zm-out').addEventListener('click', () => setZoom(ps.scale - 0.25));
  el.querySelector('#pve-zm-in').addEventListener('click', () => setZoom(ps.scale + 0.25));

  // ── Font family ─────────────────────────────────────────────
  el.querySelector('#pve-ff').addEventListener('change', (e) => { ts.fontFamily = e.target.value; });

  // ── Font size ───────────────────────────────────────────────
  const szInput = el.querySelector('#pve-sz-val');
  el.querySelector('#pve-sz-down').addEventListener('click', () => {
    ts.fontSize = Math.max(6, ts.fontSize - 1);
    szInput.value = ts.fontSize;
  });
  el.querySelector('#pve-sz-up').addEventListener('click', () => {
    ts.fontSize = Math.min(96, ts.fontSize + 1);
    szInput.value = ts.fontSize;
  });
  szInput.addEventListener('change', () => {
    const v = parseInt(szInput.value);
    if (v >= 6 && v <= 96) ts.fontSize = v;
    szInput.value = ts.fontSize;
  });

  // ── Font color ──────────────────────────────────────────────
  const fClrPicker = el.querySelector('#pve-fclr');
  const fClrBar    = el.querySelector('#pve-fclr-bar');
  el.querySelector('#pve-fclr-btn').addEventListener('click', () => fClrPicker.click());
  fClrPicker.addEventListener('input', (e) => {
    ts.color = e.target.value;
    fClrBar.style.background = e.target.value;
  });

  // ── Highlight color ─────────────────────────────────────────
  const hClrPicker = el.querySelector('#pve-hclr');
  const hClrBar    = el.querySelector('#pve-hclr-bar');
  el.querySelector('#pve-hclr-btn').addEventListener('click', () => hClrPicker.click());
  hClrPicker.addEventListener('input', (e) => {
    hClrBar.style.background = e.target.value;
  });

  // ── Tool buttons ────────────────────────────────────────────
  el.querySelectorAll('[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('pvr-active'));
      btn.classList.add('pvr-active');
      const tool = btn.dataset.tool;
      window.PdfTools.setTool(tool);
      updateToolCursor(tool);
      updateStatus('tool', `Tool: ${window.PdfTools.TOOLS[tool]?.label || tool}`);
    });
  });

  // ── Color swatches ──────────────────────────────────────────
  el.querySelectorAll('.pvr-sw').forEach(sw => {
    sw.addEventListener('click', () => {
      el.querySelectorAll('.pvr-sw').forEach(s => s.classList.remove('pvr-sw-on'));
      sw.classList.add('pvr-sw-on');
      ts.color = sw.dataset.color;
      ts.strokeColor = sw.dataset.color;
      fClrBar.style.background = sw.dataset.color;
      fClrPicker.value = sw.dataset.color;
    });
  });

  // ── Stroke width ────────────────────────────────────────────
  const strokeSlider = el.querySelector('#pve-stroke-w');
  if (strokeSlider) strokeSlider.addEventListener('input', () => { ts.strokeWidth = parseInt(strokeSlider.value); });

  // ── Fill ────────────────────────────────────────────────────
  const fillClr = el.querySelector('#pve-fill-clr');
  const fillTog = el.querySelector('#pve-fill-tog');
  fillClr.addEventListener('input', () => { ts.fillColor = fillTog.checked ? fillClr.value : 'transparent'; });
  fillTog.addEventListener('change', () => { ts.fillColor = fillTog.checked ? fillClr.value : 'transparent'; });

  // ── Line spacing dropdown ─────────────────────────────────
  const spacingBtn = el.querySelector('#pve-spacing-btn');
  const spacingDd  = el.querySelector('#pve-spacing-dd');
  spacingBtn.addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(); spacingDd.classList.toggle('open'); });
  el.querySelectorAll('[data-lh]').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      el.querySelectorAll('[data-lh]').forEach(o => o.classList.remove('pvr-dd-opt-on'));
      opt.classList.add('pvr-dd-opt-on');
      ts.lineHeight = parseFloat(opt.dataset.lh);
      spacingDd.classList.remove('open');
    });
  });

  // ── Stamp dropdown ──────────────────────────────────────────
  const stampBtn = el.querySelector('#pve-stamp-trigger');
  const stampDd  = el.querySelector('#pve-stamp-dd');
  stampBtn.addEventListener('click', (e) => { e.stopPropagation(); closeAllDropdowns(); stampDd.classList.toggle('open'); });
  el.querySelectorAll('.pve-stamp-option').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      ts.stampText = opt.dataset.stamp;
      window.PdfTools.setTool('stamp');
      updateToolCursor('stamp');
      stampDd.classList.remove('open');
    });
  });

  function closeAllDropdowns() { spacingDd.classList.remove('open'); stampDd.classList.remove('open'); }
  document.addEventListener('click', closeAllDropdowns);

  // ── Add page ────────────────────────────────────────────────
  el.querySelector('#pve-add-pg').addEventListener('click', addPage);

  // ── Save / Export / Rotate ──────────────────────────────────
  el.querySelector('#pve-save').addEventListener('click', saveAnnotations);
  el.querySelector('#pve-export').addEventListener('click', exportAnnotatedPdf);
  el.querySelector('#pve-rotate').addEventListener('click', rotatePage);

  // ── Edit mode ─────────────────────────────────────────────
  el.querySelector('#pve-edit-mode').addEventListener('click', enterEditMode);
}

// ══════════════════════════════════════════════════════════════════
//  SIDEBAR
// ══════════════════════════════════════════════════════════════════

function setupEditorSidebar() {
  const sb = document.createElement('div');
  sb.style.cssText = 'display:flex;flex-direction:column;height:100%;';
  sb.innerHTML = `
    <div style="padding:10px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:rgba(255,255,255,0.35);">Pages</div>
    <div class="pve-thumb-list" id="pve-thumb-list"></div>`;
  _shell.setSidebarContent(sb);
}

// ══════════════════════════════════════════════════════════════════
//  ZOOM
// ══════════════════════════════════════════════════════════════════

function setZoom(newScale) {
  ps.scale = Math.max(0.25, Math.min(4, newScale));
  window.PdfTools.setScale(ps.scale);
  updateStatus('zoom', `Zoom: ${Math.round(ps.scale * 100)}%`);
  const label = document.getElementById('pve-zoom-pct');
  if (label) label.textContent = Math.round(ps.scale * 100) + '%';
  rerender();
}

function fitWidth() {
  const container = ps.centerEl.querySelector('.pve-pages');
  if (!container || !ps.pdfDoc) return;
  ps.pdfDoc.getPage(1).then(page => {
    const vp = page.getViewport({ scale: 1 });
    const containerW = container.clientWidth - 40;
    setZoom(containerW / vp.width);
  });
}

function fitPage() {
  const container = ps.centerEl.querySelector('.pve-pages');
  if (!container || !ps.pdfDoc) return;
  ps.pdfDoc.getPage(1).then(page => {
    const vp = page.getViewport({ scale: 1 });
    const containerW = container.clientWidth - 40;
    const containerH = container.clientHeight - 40;
    setZoom(Math.min(containerW / vp.width, containerH / vp.height));
  });
}

function rotatePage() {
  // Rotation is complex with pdf.js — for now just re-render at 90 degree offsets
  // This would need pdf-lib to actually rotate the page
  console.log('[PDFViewer] Rotate not yet implemented');
}

async function rerender() {
  if (!ps.pdfDoc) return;
  const container = ps.centerEl.querySelector('.pve-pages');
  if (!container) return;
  deactivateBlockEditing();
  const scrollTop = container.scrollTop;

  // Preserve text edits before re-rendering
  const savedEdits = {};
  for (const [pn, blocks] of Object.entries(ps.textBlocks)) {
    blocks.forEach(b => { if (b.edited) savedEdits[b.text] = b.newText; });
  }

  container.innerHTML = '';
  ps.pageHeights = {};
  ps.pageWidths = {};

  for (let n = 1; n <= ps.pdfDoc.numPages; n++) {
    await renderPage(n, container);
  }

  // Restore edits to newly-created blocks
  for (const [pn, blocks] of Object.entries(ps.textBlocks)) {
    blocks.forEach(b => {
      if (savedEdits[b.text] !== undefined) {
        b.edited = true;
        b.newText = savedEdits[b.text];
        const el = ps.centerEl.querySelector(`[data-block-id="${b.id}"]`);
        if (el) { el.classList.add('pve-block-dirty'); el.title = 'Edited: ' + b.newText.slice(0, 60); }
      }
    });
  }

  redrawAllAnnotations();
  container.scrollTop = scrollTop;

  // Re-register editor interface with updated blocks
  registerPdfEditorInterface();
}

// ══════════════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════════════

function scrollToPage(pageNum) {
  const wrap = ps.centerEl.querySelector(`.pve-page-wrap[data-page="${pageNum}"]`);
  if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (window.PdfTools) window.PdfTools.setActiveThumbnail(pageNum);
}

function onPagesScroll() {
  const container = ps.centerEl.querySelector('.pve-pages');
  if (!container) return;
  const wraps = container.querySelectorAll('.pve-page-wrap');
  const containerTop = container.scrollTop + container.offsetHeight / 3;
  let currentPage = 1;
  wraps.forEach(w => {
    if (w.offsetTop <= containerTop) currentPage = parseInt(w.dataset.page);
  });
  updateStatus('page', `Page ${currentPage} of ${ps.pdfDoc?.numPages || '?'}`);
  if (window.PdfTools) window.PdfTools.setActiveThumbnail(currentPage);
}

// ══════════════════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════════════════

let _keyHandler = null;

function setupKeyboardShortcuts() {
  _keyHandler = (e) => {
    // Don't intercept when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); ps.history.undo(); }
    else if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); ps.history.redo(); }
    else if (ctrl && e.key === 's') { e.preventDefault(); saveAnnotations(); }
    else if (ctrl && e.key === 'p') { e.preventDefault(); window.print(); }
    else if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(ps.scale + 0.25); }
    else if (ctrl && e.key === '-') { e.preventDefault(); setZoom(ps.scale - 0.25); }
    else if (ctrl && e.key === '0') { e.preventDefault(); setZoom(1); }
    else if (ctrl && e.key === 'a') { e.preventDefault(); /* select all on current page */ }
    else if (e.key === 'Delete' || e.key === 'Backspace') { window.PdfTools.deleteSelected(); }
    else if (e.key === 'Escape') {
      window.PdfTools.setTool('select');
      updateToolCursor('select');
      ps.store.deselect();
    }
    // Tool shortcuts
    else if (!ctrl) {
      const toolMap = { v:'select', t:'text', h:'highlight', p:'freehand', r:'rectangle', e:'ellipse', l:'line', a:'arrow', n:'stickynote', s:'stamp', x:'eraser' };
      const tool = toolMap[e.key.toLowerCase()];
      if (tool) {
        window.PdfTools.setTool(tool);
        updateToolCursor(tool);
        updateStatus('tool', `Tool: ${window.PdfTools.TOOLS[tool]?.label || tool}`);
      }
    }

    // Page navigation
    if (e.key === 'PageDown') scrollToPage(Math.min(getCurrentPage() + 1, ps.pdfDoc?.numPages || 1));
    if (e.key === 'PageUp') scrollToPage(Math.max(getCurrentPage() - 1, 1));
    if (e.key === 'Home' && !ctrl) scrollToPage(1);
    if (e.key === 'End' && !ctrl) scrollToPage(ps.pdfDoc?.numPages || 1);

    // Arrow nudge
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
      const sel = ps.store.getSelected();
      if (sel) {
        e.preventDefault();
        const d = 1 / ps.scale;
        if (e.key === 'ArrowUp') sel.rect.y += d;
        if (e.key === 'ArrowDown') sel.rect.y -= d;
        if (e.key === 'ArrowLeft') sel.rect.x -= d;
        if (e.key === 'ArrowRight') sel.rect.x += d;
        redrawAllAnnotations();
      }
    }
  };
  document.addEventListener('keydown', _keyHandler);
}

function getCurrentPage() {
  const container = ps.centerEl.querySelector('.pve-pages');
  if (!container) return 1;
  const wraps = container.querySelectorAll('.pve-page-wrap');
  const containerTop = container.scrollTop + container.offsetHeight / 3;
  let current = 1;
  wraps.forEach(w => { if (w.offsetTop <= containerTop) current = parseInt(w.dataset.page); });
  return current;
}

// ══════════════════════════════════════════════════════════════════
//  SAVE / LOAD / EXPORT
// ══════════════════════════════════════════════════════════════════

async function saveAnnotations() {
  if (!ps.docId || !ps.store) return;
  try {
    _shell.showDot('analyzing');
    await window.PdfExport.saveAnnotations(ps.docId, ps.store.annotations);
    _shell.showDot('ready');
    setTimeout(_shell.hideDot, 2000);
    updateStatus('tool', 'Saved!');
    setTimeout(() => updateStatus('tool', `Tool: ${window.PdfTools.getState().active}`), 2000);
  } catch (err) {
    console.error('[save]', err);
    _shell.showDot('error');
  }
}

async function loadServerAnnotations(docId) {
  try {
    const annotations = await window.PdfExport.loadAnnotations(docId);
    if (annotations.length > 0) {
      annotations.forEach(a => ps.store.add(a));
      redrawAllAnnotations();
    }
  } catch {}
}

async function exportAnnotatedPdf() {
  if (!ps.pdfUrl) return;
  try {
    _shell.showDot('analyzing');

    await ensurePdfLib();
    const pdfBytes = ps.pdfBytes || new Uint8Array(await (await fetch(ps.pdfUrl)).arrayBuffer());
    const pdfDoc = await _pdfLib.PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    const helvetica = await pdfDoc.embedFont(_pdfLib.StandardFonts.Helvetica);
    const helveticaBold = await pdfDoc.embedFont(_pdfLib.StandardFonts.HelveticaBold);
    const timesBold = await pdfDoc.embedFont(_pdfLib.StandardFonts.TimesRomanBold);
    const times = await pdfDoc.embedFont(_pdfLib.StandardFonts.TimesRoman);
    const courier = await pdfDoc.embedFont(_pdfLib.StandardFonts.Courier);

    // Flatten text edits: white-out original text area, stamp new text
    for (const [pageNum, blocks] of Object.entries(ps.textBlocks)) {
      const editedBlocks = blocks.filter(b => b.edited && b.newText !== null);
      if (!editedBlocks.length) continue;

      const pi = parseInt(pageNum) - 1;
      if (pi < 0 || pi >= pages.length) continue;
      const page = pages[pi];
      const { height: pageH } = page.getSize();

      for (const block of editedBlocks) {
        // White-out the original text area
        const pad = 2;
        page.drawRectangle({
          x: block.bbox.x - pad,
          y: block.bbox.y - pad,
          width: block.bbox.w + pad * 2,
          height: block.bbox.h + pad * 2,
          color: _pdfLib.rgb(1, 1, 1), // white
        });

        // Stamp new text at same position with matching font
        const font = pickFont(block.fontName, helvetica, helveticaBold, times, timesBold, courier);
        const fontSize = block.fontSize || 12;
        const lines = block.newText.split('\n');
        const lineH = fontSize * 1.3;
        // Start from top of block
        let y = block.bbox.y + block.bbox.h - fontSize;

        for (const line of lines) {
          if (!line.trim()) { y -= lineH; continue; }
          try {
            page.drawText(line, {
              x: block.bbox.x,
              y: y,
              size: fontSize,
              font: font,
              color: _pdfLib.rgb(0, 0, 0),
            });
          } catch (err) {
            // If font can't encode char, fall back to helvetica
            try {
              page.drawText(line, { x: block.bbox.x, y, size: fontSize, font: helvetica, color: _pdfLib.rgb(0, 0, 0) });
            } catch {}
          }
          y -= lineH;
        }
      }
    }

    // Also flatten annotation overlays
    if (ps.store && ps.store.annotations.length > 0) {
      await window.PdfExport.exportPdf(
        null, // skip re-loading, we already have pdfDoc
        ps.store.annotations,
        null, // don't download yet
      );
    }

    const outBytes = await pdfDoc.save();
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (_shell.state.fileName || 'document').replace(/\.pdf$/i, '') + '_edited.pdf';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    _shell.showDot('ready');
    setTimeout(_shell.hideDot, 2000);
  } catch (err) {
    console.error('[export]', err);
    _shell.showDot('error');
  }
}

function pickFont(fontName, helvetica, helveticaBold, times, timesBold, courier) {
  const fn = (fontName || '').toLowerCase();
  if (fn.includes('bold') && fn.includes('times')) return timesBold;
  if (fn.includes('times')) return times;
  if (fn.includes('bold')) return helveticaBold;
  if (fn.includes('courier') || fn.includes('mono')) return courier;
  return helvetica;
}

async function addPage() {
  try {
    await ensurePdfLib();
    if (!ps.pdfLibDoc) {
      ps.pdfLibDoc = ps.pdfBytes
        ? await _pdfLib.PDFDocument.load(ps.pdfBytes)
        : await _pdfLib.PDFDocument.create();
    }
    ps.pdfLibDoc.addPage([612, 792]);
    ps.pdfBytes = await ps.pdfLibDoc.save();
    const blob = new Blob([ps.pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    ps.pdfUrl = url;
    await loadPdf(url);
    // Scroll to last page
    scrollToPage(ps.pdfDoc.numPages);
  } catch (err) { console.error('[addPage]', err); }
}

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

function updateStatus(key, text) {
  const map = { page: 'pve-page-status', zoom: 'pve-zoom-status', tool: 'pve-tool-status' };
  const el = document.getElementById(map[key]);
  if (el) el.textContent = text;
}

function updateToolCursor(tool) {
  const pagesEl = ps.centerEl.querySelector('.pve-pages');
  if (pagesEl) pagesEl.dataset.tool = tool;
  // Update all annotate toolbar buttons
  document.querySelectorAll('[data-tool]').forEach(b => {
    b.classList.toggle('pvr-active', b.dataset.tool === tool);
  });
}

function updateUndoRedoButtons(canUndo, canRedo) {
  const undoBtn = document.getElementById('pve-undo');
  const redoBtn = document.getElementById('pve-redo');
  if (undoBtn) undoBtn.style.opacity = canUndo ? '1' : '0.35';
  if (redoBtn) redoBtn.style.opacity = canRedo ? '1' : '0.35';
}

// ══════════════════════════════════════════════════════════════════
//  BLANK DOCUMENT (TipTap) — preserved from previous version
// ══════════════════════════════════════════════════════════════════

async function createBlankDocument() {
  ps.centerEl.innerHTML = '<div class="pv-loading">Setting up editor\u2026</div>';
  try {
    await _shell.loadScript(TIPTAP_SRC);
    const T = window.TipTap;
    if (!T || !T.Editor) throw new Error('TipTap failed to load');

    ps.centerEl.innerHTML = '';
    ps.centerEl.className = 'pv-doc-center';

    const page = document.createElement('div');
    page.className = 'pv-doc-page';
    const editorEl = document.createElement('div');
    editorEl.id = 'pv-tiptap-editor';
    page.appendChild(editorEl);
    ps.centerEl.appendChild(page);

    ps.tiptapEditor = new T.Editor({
      element: editorEl,
      extensions: [
        T.StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, codeBlock: { HTMLAttributes: { class: 'pv-code-block' } } }),
        T.Underline,
        T.TextAlign.configure({ types: ['heading', 'paragraph'] }),
        T.Table.configure({ resizable: true }),
        T.TableRow, T.TableCell, T.TableHeader,
        T.Image.configure({ inline: true }),
        T.Placeholder.configure({ placeholder: 'Start typing your document\u2026' }),
        T.Highlight.configure({ multicolor: true }),
        T.TextStyle, T.Color,
        T.TaskList, T.TaskItem.configure({ nested: true }),
        T.Link.configure({ openOnClick: false }),
        T.Subscript, T.Superscript,
      ],
      content: '',
      autofocus: 'end',
      onUpdate: () => { updateDocOutline(); },
    });

    // Register editor for agent doc_ops
    if (_shell.registerEditor) _shell.registerEditor(ps.tiptapEditor, 'tiptap');

    setupDocToolbar();
    setupDocSidebar();
  } catch (err) {
    ps.centerEl.innerHTML = `<div class="pv-error">Failed to create editor: ${err.message}</div>`;
  }
}

function setupDocToolbar() {
  _shell.setToolbarTabs([]);   // no tabs — flat toolbar matching PDF editor
  buildDocFlatToolbar();
}

function buildDocFlatToolbar() {
  const el = document.createElement('div');
  el.className = 'pvr-gdocs-bar';
  const e = ps.tiptapEditor;
  if (!e) return;

  el.innerHTML = `
    <!-- Undo / Redo / Print -->
    <button class="pvr-ib" id="pvd-undo" title="Undo (Ctrl+Z)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 10h10a5 5 0 0 1 0 10H9"/><polyline points="7 14 3 10 7 6"/></svg>
    </button>
    <button class="pvr-ib" id="pvd-redo" title="Redo (Ctrl+Y)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 10H11a5 5 0 0 0 0 10h4"/><polyline points="17 14 21 10 17 6"/></svg>
    </button>
    <button class="pvr-ib" id="pvd-print" title="Print (Ctrl+P)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Zoom (100%) -->
    <span class="pvr-zoom-pct">100%</span>

    <span class="pvr-div"></span>

    <!-- Paragraph style -->
    <select class="pvr-select" id="pvd-heading" title="Style" style="min-width:90px">
      <option value="paragraph">Normal text</option>
      <option value="1">Heading 1</option>
      <option value="2">Heading 2</option>
      <option value="3">Heading 3</option>
      <option value="4">Heading 4</option>
    </select>

    <span class="pvr-div"></span>

    <!-- Font family -->
    <select class="pvr-select" id="pvd-font" title="Font" style="min-width:80px">
      <option value="system-ui">Arial</option>
      <option value="Georgia, serif">Georgia</option>
      <option value="'Times New Roman', serif">Times</option>
      <option value="'Courier New', monospace">Courier</option>
    </select>

    <span class="pvr-div"></span>

    <!-- Font size -->
    <button class="pvr-ib pvr-sm" id="pvd-sz-down" title="Decrease font size">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <input type="text" class="pvr-sz-input" id="pvd-sz-val" value="11" title="Font size">
    <button class="pvr-ib pvr-sm" id="pvd-sz-up" title="Increase font size">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- B  I  U  Strikethrough -->
    <button class="pvr-ib pvr-fmt" data-cmd="bold" title="Bold (Ctrl+B)"><strong>B</strong></button>
    <button class="pvr-ib pvr-fmt" data-cmd="italic" title="Italic (Ctrl+I)"><em>I</em></button>
    <button class="pvr-ib pvr-fmt" data-cmd="underline" title="Underline (Ctrl+U)"><span style="text-decoration:underline">U</span></button>
    <button class="pvr-ib pvr-fmt" data-cmd="strike" title="Strikethrough"><s>S</s></button>

    <!-- Font color -->
    <button class="pvr-ib pvr-clr-btn" id="pvd-fclr-btn" title="Font color">
      <span class="pvr-clr-letter">A</span><span class="pvr-clr-bar" id="pvd-fclr-bar" style="background:#000000"></span>
    </button>
    <input type="color" id="pvd-fclr" value="#000000" style="display:none">

    <!-- Highlight -->
    <button class="pvr-ib pvr-clr-btn" id="pvd-hclr-btn" title="Highlight color">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v2H3zm4-4l7-7 3 3-7 7H7v-3z"/></svg>
      <span class="pvr-clr-bar" id="pvd-hclr-bar" style="background:#facc15"></span>
    </button>
    <input type="color" id="pvd-hclr" value="#facc15" style="display:none">

    <span class="pvr-div"></span>

    <!-- Insert: link, image, divider -->
    <button class="pvr-ib" id="pvd-ins-link" title="Insert link">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
    </button>
    <button class="pvr-ib" id="pvd-ins-image" title="Insert image">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Text alignment -->
    <button class="pvr-ib" data-align="left" title="Align left">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="17" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>
    </button>
    <button class="pvr-ib" data-align="center" title="Align center">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="18" y1="14" x2="6" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>
    </button>
    <button class="pvr-ib" data-align="right" title="Align right">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="7" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Line spacing -->
    <span class="pvr-drop-wrap" id="pvd-spacing-wrap">
      <button class="pvr-ib" id="pvd-spacing-btn" title="Line & paragraph spacing">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="21" y1="6"  x2="11" y2="6"/><line x1="21" y1="12" x2="11" y2="12"/><line x1="21" y1="18" x2="11" y2="18"/>
          <polyline points="7 8 5 6 3 8"/><polyline points="3 16 5 18 7 16"/><line x1="5" y1="6" x2="5" y2="18"/>
        </svg>
      </button>
      <div class="pvr-spacing-dd" id="pvd-spacing-dd">
        <div class="pvr-dd-label">Line spacing</div>
        <button class="pvr-dd-opt" data-lh="1">Single</button>
        <button class="pvr-dd-opt" data-lh="1.15">1.15</button>
        <button class="pvr-dd-opt pvr-dd-opt-on" data-lh="1.5">1.5</button>
        <button class="pvr-dd-opt" data-lh="2">Double</button>
      </div>
    </span>

    <span class="pvr-div"></span>

    <!-- Lists -->
    <button class="pvr-ib" data-cmd="bulletList" title="Bullet list">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="5" cy="6" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="18" r="1" fill="currentColor"/></svg>
    </button>
    <button class="pvr-ib" data-cmd="orderedList" title="Numbered list">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="3" y="8" font-size="7" fill="currentColor" stroke="none">1</text><text x="3" y="14" font-size="7" fill="currentColor" stroke="none">2</text><text x="3" y="20" font-size="7" fill="currentColor" stroke="none">3</text></svg>
    </button>
    <button class="pvr-ib" data-cmd="taskList" title="Checklist">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="4" height="4" rx="0.5"/><line x1="10" y1="7" x2="21" y2="7"/><rect x="3" y="15" width="4" height="4" rx="0.5"/><line x1="10" y1="17" x2="21" y2="17"/><polyline points="4 16 5 17 7 15"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Blockquote / code -->
    <button class="pvr-ib" data-cmd="blockquote" title="Blockquote">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" opacity="0.7"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>
    </button>
    <button class="pvr-ib" data-cmd="codeBlock" title="Code block">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Insert: table, divider -->
    <button class="pvr-ib" id="pvd-ins-table" title="Insert table">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
    </button>
    <button class="pvr-ib" id="pvd-ins-hr" title="Insert divider">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/></svg>
    </button>

    <!-- Spacer -->
    <span style="flex:1"></span>

    <!-- Export -->
    <button class="pvr-ib" id="pvd-exp-pdf" title="Save as PDF" style="color:var(--accent)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="pvr-ib" id="pvd-exp-html" title="Save as HTML">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
    </button>

    ${ps.editMode ? `
    <span class="pvr-div"></span>
    <button class="pvr-ib pvr-back-view-btn" id="pvd-back-view" title="Back to PDF view (keep changes)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      <span style="font-size:11px">View</span>
    </button>
    <button class="pvr-ib pvr-back-view-btn" id="pvd-discard" title="Discard changes and return to original PDF">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    ` : ''}

    <span class="pvr-div"></span>

    <!-- Mode badge -->
    <span class="pvr-mode-badge ${ps.editMode ? 'pvr-mode-edit' : ''}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
      Editing
    </span>
  `;

  _shell.setToolbarBandEl(el);
  wireDocFlatToolbar(el, e);
}

function wireDocFlatToolbar(el, e) {
  // ── Undo / Redo / Print ─────────────────────────────────────
  el.querySelector('#pvd-undo').addEventListener('click', () => e.chain().focus().undo().run());
  el.querySelector('#pvd-redo').addEventListener('click', () => e.chain().focus().redo().run());
  el.querySelector('#pvd-print').addEventListener('click', () => window.print());

  // ── Heading style ───────────────────────────────────────────
  el.querySelector('#pvd-heading').addEventListener('change', ev => {
    const v = ev.target.value;
    if (v === 'paragraph') e.chain().focus().setParagraph().run();
    else e.chain().focus().toggleHeading({ level: parseInt(v) }).run();
  });

  // ── Font size ───────────────────────────────────────────────
  let docFontSize = 11;
  const szInput = el.querySelector('#pvd-sz-val');
  function applyDocFontSize() {
    // TipTap doesn't natively have font-size, use CSS approach via style
    document.querySelector('.pv-doc-page')?.style.setProperty('font-size', docFontSize + 'pt');
  }
  el.querySelector('#pvd-sz-down').addEventListener('click', () => { docFontSize = Math.max(8, docFontSize - 1); szInput.value = docFontSize; applyDocFontSize(); });
  el.querySelector('#pvd-sz-up').addEventListener('click',   () => { docFontSize = Math.min(72, docFontSize + 1); szInput.value = docFontSize; applyDocFontSize(); });
  szInput.addEventListener('change', () => { const v = parseInt(szInput.value); if (v >= 8 && v <= 72) docFontSize = v; szInput.value = docFontSize; applyDocFontSize(); });

  // ── Font family ─────────────────────────────────────────────
  el.querySelector('#pvd-font').addEventListener('change', ev => {
    document.querySelector('.pv-doc-page')?.style.setProperty('font-family', ev.target.value);
  });

  // ── Format commands (bold, italic, etc.) ────────────────────
  const cmdMap = {
    bold:       () => e.chain().focus().toggleBold().run(),
    italic:     () => e.chain().focus().toggleItalic().run(),
    underline:  () => e.chain().focus().toggleUnderline().run(),
    strike:     () => e.chain().focus().toggleStrike().run(),
    highlight:  () => e.chain().focus().toggleHighlight().run(),
    bulletList: () => e.chain().focus().toggleBulletList().run(),
    orderedList:() => e.chain().focus().toggleOrderedList().run(),
    taskList:   () => e.chain().focus().toggleTaskList().run(),
    blockquote: () => e.chain().focus().toggleBlockquote().run(),
    codeBlock:  () => e.chain().focus().toggleCodeBlock().run(),
  };
  el.querySelectorAll('[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => { if (cmdMap[btn.dataset.cmd]) cmdMap[btn.dataset.cmd](); });
  });

  // ── Font color ──────────────────────────────────────────────
  const fClrPicker = el.querySelector('#pvd-fclr');
  const fClrBar    = el.querySelector('#pvd-fclr-bar');
  el.querySelector('#pvd-fclr-btn').addEventListener('click', () => fClrPicker.click());
  fClrPicker.addEventListener('input', ev => { e.chain().focus().setColor(ev.target.value).run(); fClrBar.style.background = ev.target.value; });

  // ── Highlight color ─────────────────────────────────────────
  const hClrPicker = el.querySelector('#pvd-hclr');
  const hClrBar    = el.querySelector('#pvd-hclr-bar');
  el.querySelector('#pvd-hclr-btn').addEventListener('click', () => hClrPicker.click());
  hClrPicker.addEventListener('input', ev => { e.chain().focus().toggleHighlight({ color: ev.target.value }).run(); hClrBar.style.background = ev.target.value; });

  // ── Alignment ───────────────────────────────────────────────
  el.querySelectorAll('[data-align]').forEach(btn => {
    btn.addEventListener('click', () => e.chain().focus().setTextAlign(btn.dataset.align).run());
  });

  // ── Line spacing dropdown ───────────────────────────────────
  const spacingBtn = el.querySelector('#pvd-spacing-btn');
  const spacingDd  = el.querySelector('#pvd-spacing-dd');
  spacingBtn.addEventListener('click', (ev) => { ev.stopPropagation(); spacingDd.classList.toggle('open'); });
  el.querySelectorAll('[data-lh]').forEach(opt => {
    opt.addEventListener('click', (ev) => {
      ev.stopPropagation();
      el.querySelectorAll('[data-lh]').forEach(o => o.classList.remove('pvr-dd-opt-on'));
      opt.classList.add('pvr-dd-opt-on');
      const lh = parseFloat(opt.dataset.lh);
      document.querySelector('.pv-doc-page')?.style.setProperty('line-height', String(lh));
      spacingDd.classList.remove('open');
    });
  });
  document.addEventListener('click', () => spacingDd.classList.remove('open'));

  // ── Insert ──────────────────────────────────────────────────
  el.querySelector('#pvd-ins-link').addEventListener('click', () => { const url = prompt('Link URL:'); if (url) e.chain().focus().setLink({ href: url }).run(); else e.chain().focus().unsetLink().run(); });
  el.querySelector('#pvd-ins-image').addEventListener('click', () => { const url = prompt('Image URL:'); if (url) e.chain().focus().setImage({ src: url }).run(); });
  el.querySelector('#pvd-ins-table').addEventListener('click', () => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run());
  el.querySelector('#pvd-ins-hr').addEventListener('click', () => e.chain().focus().setHorizontalRule().run());

  // ── Export ──────────────────────────────────────────────────
  el.querySelector('#pvd-exp-pdf').addEventListener('click', ps.editMode ? exportEditedPdf : exportDocToPdf);
  el.querySelector('#pvd-exp-html').addEventListener('click', exportDocToHtml);

  // ── Back to PDF view (edit mode only) ─────────────────────
  const backBtn = el.querySelector('#pvd-back-view');
  if (backBtn) backBtn.addEventListener('click', () => exitEditMode(true));
  const discardBtn = el.querySelector('#pvd-discard');
  if (discardBtn) discardBtn.addEventListener('click', () => {
    if (confirm('Discard changes and return to original PDF?')) exitEditMode(false);
  });
}

function setupDocSidebar() {
  const sb = document.createElement('div');
  sb.style.cssText = 'display:flex;flex-direction:column;height:100%;';
  sb.innerHTML = `<div style="padding:10px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:rgba(255,255,255,0.35);">Outline</div><div id="pv-doc-outline" style="flex:1;overflow-y:auto;padding:0 4px;"></div>`;
  _shell.setSidebarContent(sb);
  updateDocOutline();
}

function updateDocOutline() {
  const e = ps.tiptapEditor; if (!e) return;
  const outline = document.getElementById('pv-doc-outline');
  if (!outline) return;
  const headings = [];
  e.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') headings.push({ level: node.attrs.level, text: node.textContent, pos });
  });
  outline.innerHTML = '';
  if (!headings.length) {
    outline.innerHTML = '<div style="padding:12px;font-size:11px;color:var(--text-muted);font-style:italic;">No headings yet</div>';
  } else {
    headings.forEach(h => {
      const item = document.createElement('div');
      item.className = 'pvs-outline-item';
      item.style.paddingLeft = (12 + (h.level - 1) * 12) + 'px';
      item.textContent = h.text || '(empty)';
      item.addEventListener('click', () => e.chain().focus().setTextSelection(h.pos + 1).run());
      outline.appendChild(item);
    });
  }
}

async function exportDocToPdf() {
  const e = ps.tiptapEditor; if (!e) return;
  _shell.showDot('analyzing');
  try {
    await ensurePdfLib();
    const doc = await _pdfLib.PDFDocument.create();
    const font = await doc.embedFont(_pdfLib.StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(_pdfLib.StandardFonts.HelveticaBold);
    const W = 612, H = 792, M = 72, CW = W - M * 2, LH = 1.4;
    let page = doc.addPage([W, H]); let yPos = H - M;
    function np() { page = doc.addPage([W, H]); yPos = H - M; }
    function dl(text, sz, f, indent) { if (yPos - sz < M) np(); try { page.drawText(text, { x: M + (indent||0), y: yPos - sz, size: sz, font: f, color: _pdfLib.rgb(0,0,0) }); } catch {} yPos -= sz * LH; }

    e.state.doc.content.content.forEach(node => {
      if (node.type.name === 'heading') { const sz = { 1:24, 2:20, 3:16, 4:14 }[node.attrs.level] || 14; yPos -= sz * 0.5; dl(node.textContent, sz, fontBold, 0); yPos -= sz * 0.3; }
      else if (node.type.name === 'paragraph') { const t = node.textContent; if (!t.trim()) { yPos -= 12; return; } const mc = Math.floor(CW / 6); const words = t.split(' '); let ln = ''; words.forEach(w => { if ((ln + ' ' + w).length > mc && ln) { dl(ln.trim(), 12, font, 0); ln = w; } else ln = ln ? ln + ' ' + w : w; }); if (ln) dl(ln.trim(), 12, font, 0); yPos -= 4; }
      else if (node.type.name === 'bulletList' || node.type.name === 'orderedList') { node.content.content.forEach((item, idx) => { dl((node.type.name === 'bulletList' ? '\u2022 ' : `${idx+1}. `) + item.textContent, 12, font, 18); }); yPos -= 4; }
    });

    const bytes = await doc.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = (_shell.state.fileName || 'document').replace(/\.pdf$/i, '') + '.pdf';
    a.click(); URL.revokeObjectURL(a.href);
    _shell.showDot('ready'); setTimeout(_shell.hideDot, 2000);
  } catch (err) { console.error('[doc] PDF export failed:', err); _shell.showDot('error'); }
}

function exportDocToHtml() {
  const e = ps.tiptapEditor; if (!e) return;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${_shell.escHtml(_shell.state.fileName || 'Document')}</title><style>body{font-family:system-ui;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333;}h1,h2,h3{margin-top:1.5em;}table{border-collapse:collapse;width:100%;}td,th{border:1px solid #ddd;padding:8px;}pre{background:#f4f4f4;padding:16px;border-radius:6px;}</style></head><body>${e.getHTML()}</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = (_shell.state.fileName || 'document').replace(/\.pdf$/i, '') + '.html';
  a.click(); URL.revokeObjectURL(a.href);
}

// ══════════════════════════════════════════════════════════════════
//  CLEANUP
// ══════════════════════════════════════════════════════════════════

function cleanup() {
  if (ps.tiptapEditor) { ps.tiptapEditor.destroy(); ps.tiptapEditor = null; }
  if (ps.polling) { clearInterval(ps.polling); ps.polling = null; }
  if (ps.progress) { ps.progress.close(); ps.progress = null; }
  if (ps.pdfDoc) { ps.pdfDoc.destroy(); ps.pdfDoc = null; }
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler); _keyHandler = null; }
  if (window.PdfTools) window.PdfTools.removeActiveTextInput();
  if (_shell && _shell.unregisterEditor) _shell.unregisterEditor();
  window.__activeEditor = null;
  window.__activeEditorType = null;
  ps.store = null; ps.history = null;
  ps.pdfLibDoc = null; ps.pdfBytes = null;
  ps.docMode = false; ps.editMode = false; ps.originalPdfUrl = null;
  ps.pageHeights = {}; ps.pageWidths = {};
  ps.textBlocks = {}; ps.activeEditBlock = null;
}

// ══════════════════════════════════════════════════════════════════
//  REGISTER
// ══════════════════════════════════════════════════════════════════

window.Viewers = window.Viewers || {};
window.Viewers.pdf = { mount, cleanup };

})();
