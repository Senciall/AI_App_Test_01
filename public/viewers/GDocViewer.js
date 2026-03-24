'use strict';
/* ═══════════════════════════════════════════════════════════════
   GDocViewer.js — Grid-flow document viewer / editor
   Renders .gdoc documents using GDocEngine.
   ═══════════════════════════════════════════════════════════════ */

(function () {

let _shell = null;
let G      = null;  // GDocEngine ref
let W      = null;  // GDocWidgets ref

// ── State ───────────────────────────────────────────────────────
const ds = {
  doc:        null,   // the gdoc document object
  centerEl:   null,
  selected:   null,   // selected widget id
  editing:    null,   // widget id being inline-edited
  filePath:   null,
  saveTimer:  null,   // auto-save debounce
  dirty:      false,
};

// ══════════════════════════════════════════════════════════════════
//  MOUNT
// ══════════════════════════════════════════════════════════════════

function mount(centerEl, file, shell) {
  _shell = shell;
  ds.centerEl = centerEl;
  ds.selected = null;
  ds.editing  = null;
  ds.filePath = file.path || null;

  centerEl.innerHTML = '<div class="gd-loading">Loading\u2026</div>';

  Promise.all([_shell.loadScript('gdoc-engine.js'), _shell.loadScript('gdoc-widgets.js')]).then(() => {
    G = window.GDocEngine;
    W = window.GDocWidgets;
    if (!G || !W) { centerEl.innerHTML = '<div class="gd-error">GDoc engine failed to load</div>'; return; }
    _shell.loadCSS('gdoc-editor.css');

    if (file.blank) {
      ds.doc = G.createDocument(file.preset || 'Letter');
      ds.doc.meta.title = (file.name || 'Untitled Document').replace(/\.gdoc$/i, '');
      seedTemplate(ds.doc, file.template || 'blank');
    } else if (file.gdocText) {
      ds.doc = G.parseDocument(file.gdocText);
    } else if (file.url) {
      // Load from URL
      fetch(file.url).then(r => r.text()).then(text => {
        ds.doc = G.parseDocument(text);
        renderAll();
        setupToolbar();
        setupSidebar();
        setupKeys();
        setupImageHandlers();
      }).catch(err => { centerEl.innerHTML = '<div class="gd-error">' + err.message + '</div>'; });
      return;
    } else {
      ds.doc = G.createDocument('Letter');
    }

    renderAll();
    setupToolbar();
    setupSidebar();
    setupKeys();
    setupImageHandlers();
  });
}

// ══════════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════════

function seedTemplate(doc, template) {
  const add = (def) => { ds.doc = G.addWidget(ds.doc, def); };

  if (template === 'report') {
    add({ type: 'title',   colSpan: 12, rowSpan: 2, content: 'Project Report' });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Author: \u2022 Date: \u2022 Department:', style: { color: '#666', fontSize: '13px' } });
    add({ type: 'divider', colSpan: 12, rowSpan: 1 });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Executive Summary', style: { fontSize: '18px', fontFamily: 'Georgia, serif' } });
    add({ type: 'textbox', colSpan: 12, rowSpan: 5, content: 'Provide a brief overview of the project, key findings, and recommendations here.' });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Key Metrics', style: { fontSize: '18px', fontFamily: 'Georgia, serif' } });
    add({ type: 'table',   colSpan: 12, rowSpan: 4, headers: ['Metric', 'Target', 'Actual', 'Status'], rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', '']] });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Detailed Analysis', style: { fontSize: '18px', fontFamily: 'Georgia, serif' } });
    add({ type: 'textbox', colSpan: 12, rowSpan: 6, content: 'Write the detailed analysis here. Use the AI agent to help draft, expand, or restructure this section.' });

  } else if (template === 'resume') {
    add({ type: 'title',   colSpan: 12, rowSpan: 2, content: 'Your Name' });
    add({ type: 'textbox', colSpan: 12, rowSpan: 1, content: 'email@example.com \u2022 (555) 123-4567 \u2022 City, State', style: { align: 'center', color: '#555', fontSize: '13px' } });
    add({ type: 'divider', colSpan: 12, rowSpan: 1 });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Professional Summary', style: { fontSize: '16px', fontFamily: 'Georgia, serif' } });
    add({ type: 'textbox', colSpan: 12, rowSpan: 3, content: 'Results-driven professional with experience in...' });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Experience', style: { fontSize: '16px', fontFamily: 'Georgia, serif' } });
    add({ type: 'textbox', colSpan: 12, rowSpan: 4, content: 'Job Title \u2014 Company Name\nDate \u2013 Present\n\u2022 Key achievement or responsibility\n\u2022 Another accomplishment' });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Education', style: { fontSize: '16px', fontFamily: 'Georgia, serif' } });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Degree \u2014 University Name, Year' });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Skills', style: { fontSize: '16px', fontFamily: 'Georgia, serif' } });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Skill 1 \u2022 Skill 2 \u2022 Skill 3 \u2022 Skill 4' });

  } else if (template === 'notes') {
    add({ type: 'title',   colSpan: 12, rowSpan: 2, content: 'Meeting Notes' });
    add({ type: 'textbox', colSpan: 6,  rowSpan: 2, content: 'Date: ' + new Date().toLocaleDateString(), style: { fontSize: '13px', color: '#666' } });
    add({ type: 'textbox', colSpan: 6,  rowSpan: 2, content: 'Attendees:', style: { fontSize: '13px', color: '#666' } });
    add({ type: 'divider', colSpan: 12, rowSpan: 1 });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Agenda', style: { fontSize: '16px' } });
    add({ type: 'textbox', colSpan: 12, rowSpan: 4, content: '1. \n2. \n3. ' });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Discussion Notes', style: { fontSize: '16px' } });
    add({ type: 'textbox', colSpan: 12, rowSpan: 6, content: '' });
    add({ type: 'textbox', colSpan: 12, rowSpan: 2, content: 'Action Items', style: { fontSize: '16px' } });
    add({ type: 'table',   colSpan: 12, rowSpan: 4, headers: ['Action', 'Owner', 'Due Date', 'Status'], rows: [['', '', '', ''], ['', '', '', '']] });

  } else {
    // blank
    add({ type: 'title',   colSpan: 12, rowSpan: 2, content: ds.doc.meta.title });
    add({ type: 'textbox', colSpan: 12, rowSpan: 4, content: '' });
  }
}

function renderAll() {
  const metrics = G.computeGridMetrics(ds.doc.canvas);
  const resolved = G.resolveFlow(ds.doc.widgets, ds.doc.canvas);
  const canvas = ds.doc.canvas;
  const pagePad = 48; // top+bottom padding on each page
  const contentH = canvas.height - pagePad * 2; // usable height per page

  const el = ds.centerEl;
  el.innerHTML = '';
  el.className = 'gd-center';

  // Group widgets by flowIndex (same flowIndex = side-by-side row)
  const groups = [];
  for (const w of resolved) {
    const last = groups[groups.length - 1];
    if (last && last[0].flowIndex === w.flowIndex) {
      last.push(w);
    } else {
      groups.push([w]);
    }
  }

  // Build all flow-row elements
  const rowEls = groups.map(group => {
    const row = document.createElement('div');
    row.className = 'gd-flow-row';
    row.style.gridTemplateColumns = 'repeat(' + metrics.columns + ', 1fr)';
    row.style.gap = metrics.gutterX + 'px';
    for (const w of group) row.appendChild(renderWidget(w, metrics));
    return row;
  });

  // Stage: render into a hidden measurer to get actual heights
  const measurer = document.createElement('div');
  measurer.className = 'gd-page';
  measurer.style.width = canvas.width + 'px';
  measurer.style.position = 'absolute';
  measurer.style.visibility = 'hidden';
  measurer.style.left = '-9999px';
  rowEls.forEach(r => measurer.appendChild(r));
  el.appendChild(measurer);

  // Measure each row's actual rendered height
  const rowHeights = rowEls.map(r => r.offsetHeight);

  // Remove from measurer (don't destroy — we'll re-attach to real pages)
  rowEls.forEach(r => measurer.removeChild(r));
  measurer.remove();

  // Distribute rows into pages based on actual heights
  const pages = [];
  let currentPage = null;
  let usedHeight = 0;

  for (let i = 0; i < rowEls.length; i++) {
    const h = rowHeights[i];

    // Start a new page if: no current page, or this row won't fit
    if (!currentPage || (usedHeight > 0 && usedHeight + h > contentH)) {
      currentPage = createPageEl(canvas);
      pages.push(currentPage);
      usedHeight = 0;
    }

    currentPage.appendChild(rowEls[i]);
    usedHeight += h + 2; // 2px = flow-row margin-bottom
  }

  // Ensure at least one page
  if (pages.length === 0) pages.push(createPageEl(canvas));

  pages.forEach(p => el.appendChild(p));

  updateStatusText('page', 'Page 1 of ' + pages.length);
  updateStatusText('widgets', ds.doc.widgets.length + ' widgets');
  updateFlowList();
  registerEditorInterface();
  scheduleAutoSave();
}

function createPageEl(canvas) {
  const pageEl = document.createElement('div');
  pageEl.className = 'gd-page';
  pageEl.style.width  = canvas.width  + 'px';
  pageEl.style.minHeight = canvas.height + 'px';
  pageEl.addEventListener('click', (e) => {
    if (e.target === pageEl || e.target.classList.contains('gd-flow-row')) { deselect(); finishEditing(); }
  });
  return pageEl;
}

function renderWidget(w, metrics) {
  const el = document.createElement('div');
  el.className = 'gd-widget gd-wt-' + w.type;
  el.dataset.id = w.id;

  // CSS grid column placement (1-based, span)
  el.style.gridColumn = w.colStart + ' / span ' + w.colSpan;

  // min-height from rowSpan (content can grow past it)
  const minH = w.rowSpan * metrics.cellHeight + (w.rowSpan - 1) * metrics.gutterY;
  el.style.minHeight = minH + 'px';

  // Apply custom style
  if (w.style) {
    if (w.style.bg)        el.style.background   = w.style.bg;
    if (w.style.color)     el.style.color         = w.style.color;
    if (w.style.fontSize)  el.style.fontSize      = w.style.fontSize;
    if (w.style.fontFamily)el.style.fontFamily     = w.style.fontFamily;
    if (w.style.align)     el.style.textAlign      = w.style.align;
    if (w.style.border)    el.style.border         = w.style.border;
    if (w.style.radius)    el.style.borderRadius   = w.style.radius;
    if (w.style.padding)   el.style.padding        = w.style.padding;
  }

  // Drag handle
  const handle = document.createElement('div');
  handle.className = 'gd-drag-handle';
  handle.innerHTML = '<svg width="10" height="16" viewBox="0 0 10 16"><circle cx="3" cy="2" r="1.2" fill="currentColor"/><circle cx="7" cy="2" r="1.2" fill="currentColor"/><circle cx="3" cy="6" r="1.2" fill="currentColor"/><circle cx="7" cy="6" r="1.2" fill="currentColor"/><circle cx="3" cy="10" r="1.2" fill="currentColor"/><circle cx="7" cy="10" r="1.2" fill="currentColor"/><circle cx="3" cy="14" r="1.2" fill="currentColor"/><circle cx="7" cy="14" r="1.2" fill="currentColor"/></svg>';
  handle.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); startDrag(w, el, e); });
  el.appendChild(handle);

  // Render inner content via widget registry
  const reg = W.WIDGETS[w.type];
  const hooks = { wireText: wireTextWidget, wireTable: commitTableFromDom, esc };
  const inner = reg ? reg.render(w, hooks) : null;
  if (inner) el.appendChild(inner);
  else if (!reg) el.innerHTML = '<div class="gd-unknown">[' + w.type + ']</div>';

  // Selection highlight
  if (ds.selected === w.id) el.classList.add('gd-selected');

  // Click to select (for non-text widgets; text widgets handle focus via wireText)
  const isText = w.type === 'title' || w.type === 'textbox';
  if (!isText) {
    el.addEventListener('click', (e) => { e.stopPropagation(); selectWidget(w.id); });
  }

  return el;
}

function commitTableFromDom(w) {
  const tableEl = ds.centerEl.querySelector('[data-id="' + w.id + '"] .gd-table');
  if (!tableEl) return;
  const ths = tableEl.querySelectorAll('thead th');
  if (ths.length) {
    const headers = Array.from(ths).map(th => th.innerText);
    ds.doc = G.updateWidget(ds.doc, w.id, { headers });
  }
  const trs = tableEl.querySelectorAll('tbody tr');
  if (trs.length) {
    const rows = Array.from(trs).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.innerText));
    ds.doc = G.updateWidget(ds.doc, w.id, { rows });
  }
  scheduleAutoSave();
}

// ══════════════════════════════════════════════════════════════════
//  DRAG TO REORDER
// ══════════════════════════════════════════════════════════════════

let _dragState = null;

function startDrag(w, widgetEl, e) {
  selectWidget(w.id);
  const pageEl = widgetEl.closest('.gd-page');
  if (!pageEl) return;

  // Find the flow-row this widget is in, and mark it as dragging
  const rowEl = widgetEl.closest('.gd-flow-row');
  if (rowEl) rowEl.classList.add('gd-dragging');

  // Create drop indicator line
  const dropLine = document.createElement('div');
  dropLine.className = 'gd-drop-line';
  dropLine.style.display = 'none';
  pageEl.appendChild(dropLine);

  // Collect all flow-rows (excluding the one being dragged)
  const rows = Array.from(pageEl.querySelectorAll('.gd-flow-row:not(.gd-dragging)'));

  _dragState = { w, rowEl, pageEl, dropLine, rows, targetIndex: -1 };

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
  if (!_dragState) return;
  const { pageEl, dropLine, rows } = _dragState;
  const pageRect = pageEl.getBoundingClientRect();
  const y = e.clientY - pageRect.top;

  let bestIdx = 0;
  let bestDist = Infinity;

  for (let i = 0; i <= rows.length; i++) {
    let gapY;
    if (i === 0) {
      gapY = rows.length ? rows[0].offsetTop : 32;
    } else if (i === rows.length) {
      const last = rows[i - 1];
      gapY = last.offsetTop + last.offsetHeight + 4;
    } else {
      gapY = (rows[i - 1].offsetTop + rows[i - 1].offsetHeight + rows[i].offsetTop) / 2;
    }
    const dist = Math.abs(y - gapY);
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }

  _dragState.targetIndex = bestIdx;

  let lineY;
  if (rows.length === 0) { lineY = 32; }
  else if (bestIdx === 0) { lineY = rows[0].offsetTop - 2; }
  else if (bestIdx >= rows.length) { const l = rows[rows.length - 1]; lineY = l.offsetTop + l.offsetHeight + 2; }
  else { lineY = (rows[bestIdx - 1].offsetTop + rows[bestIdx - 1].offsetHeight + rows[bestIdx].offsetTop) / 2; }

  dropLine.style.display = 'block';
  dropLine.style.top = lineY + 'px';
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  if (!_dragState) return;

  const { w, rowEl, dropLine, rows, targetIndex } = _dragState;
  if (rowEl) rowEl.classList.remove('gd-dragging');
  dropLine.remove();

  if (targetIndex >= 0 && rows.length > 0) {
    // Get flowIndex of the widget at the target position
    let targetFlowIndex;
    if (targetIndex === 0) {
      const firstId = rows[0].querySelector('.gd-widget')?.dataset.id;
      const firstW = ds.doc.widgets.find(ww => ww.id === firstId);
      targetFlowIndex = firstW ? firstW.flowIndex - 1 : 0;
    } else if (targetIndex >= rows.length) {
      const lastId = rows[rows.length - 1].querySelector('.gd-widget')?.dataset.id;
      const lastW = ds.doc.widgets.find(ww => ww.id === lastId);
      targetFlowIndex = lastW ? lastW.flowIndex + 1 : ds.doc.widgets.length + 1;
    } else {
      const aboveId = rows[targetIndex - 1].querySelector('.gd-widget')?.dataset.id;
      const belowId = rows[targetIndex].querySelector('.gd-widget')?.dataset.id;
      const aboveW = ds.doc.widgets.find(ww => ww.id === aboveId);
      const belowW = ds.doc.widgets.find(ww => ww.id === belowId);
      if (aboveW && belowW) targetFlowIndex = aboveW.flowIndex + 0.5;
    }

    if (targetFlowIndex != null) {
      ds.doc = G.updateWidget(ds.doc, w.id, { flowIndex: targetFlowIndex });
      // Re-index to contiguous integers
      const sorted = [...ds.doc.widgets].sort((a, b) => a.flowIndex - b.flowIndex);
      sorted.forEach((ww, i) => { ww.flowIndex = i + 1; });
      ds.doc = { ...ds.doc, widgets: sorted, meta: { ...ds.doc.meta, updatedAt: new Date().toISOString() } };
      renderAll();
    }
  }

  _dragState = null;
}

// ══════════════════════════════════════════════════════════════════
//  SELECTION & EDITING
// ══════════════════════════════════════════════════════════════════

// ── Wire a text widget for live inline editing ──────────────────
// The element is ALWAYS contentEditable. Changes commit on blur
// or after a typing pause. No double-click required.

function wireTextWidget(contentEl, w) {
  let commitTimer = null;

  // On focus: mark as active editing widget, select it
  contentEl.addEventListener('focus', () => {
    ds.editing = w.id;
    ds.selected = w.id;
    const wrapper = contentEl.closest('.gd-widget');
    if (wrapper) wrapper.classList.add('gd-editing');
    ds.centerEl.querySelectorAll('.gd-widget').forEach(el => {
      el.classList.toggle('gd-selected', el.dataset.id === w.id);
    });
    // Set agent context
    if (_shell) {
      _shell.setContext({
        label: w.type + ' [' + w.id + ']',
        text: contentEl.innerText || '(empty)',
        extra: 'flowIndex:' + w.flowIndex + ' col:' + w.colStart + '-' + (w.colStart + w.colSpan - 1) + ' rowSpan:' + w.rowSpan,
        widgetId: w.id,
      });
    }
  });

  // On blur: commit immediately
  contentEl.addEventListener('blur', () => {
    if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
    commitTextContent(w.id, contentEl);
    const wrapper = contentEl.closest('.gd-widget');
    if (wrapper) wrapper.classList.remove('gd-editing');
    if (ds.editing === w.id) ds.editing = null;
  });

  // On input: debounced commit (saves while typing without losing cursor)
  contentEl.addEventListener('input', () => {
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => commitTextContent(w.id, contentEl), 800);
  });

  // Keyboard: Escape blurs, stop propagation so global shortcuts don't fire
  contentEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { contentEl.blur(); return; }
    e.stopPropagation();
  });

  // Click inside text: don't propagate to the widget click handler
  contentEl.addEventListener('click', (e) => e.stopPropagation());
}

function commitTextContent(id, contentEl) {
  const newText = contentEl.innerText;
  // Find the widget in the doc and check if content actually changed
  const w = ds.doc.widgets.find(ww => ww.id === id);
  if (!w || w.content === newText) return;

  ds.doc = G.updateWidget(ds.doc, id, { content: newText });

  // If it's the title, also update doc meta + header display
  if (w.type === 'title') {
    ds.doc = { ...ds.doc, meta: { ...ds.doc.meta, title: newText } };
    if (_shell && _shell.state) _shell.state.fileName = newText;
    const nameDisplay = document.getElementById('pv-doc-name-display');
    if (nameDisplay) nameDisplay.textContent = newText;
  }

  // Auto-save (no re-render — cursor stays in place)
  scheduleAutoSave();
}

function selectWidget(id) {
  ds.selected = id;
  ds.centerEl.querySelectorAll('.gd-widget').forEach(el => {
    el.classList.toggle('gd-selected', el.dataset.id === id);
  });
  // Notify agent
  const w = ds.doc.widgets.find(ww => ww.id === id);
  if (w && _shell) {
    _shell.setContext({
      label: w.type + ' [' + w.id + ']',
      text: w.content || w.src || '(no content)',
      extra: 'flowIndex:' + w.flowIndex + ' col:' + w.colStart + '-' + (w.colStart + w.colSpan - 1) + ' rowSpan:' + w.rowSpan,
      widgetId: w.id,
    });
  }
}

function deselect() {
  ds.selected = null;
  ds.centerEl.querySelectorAll('.gd-selected').forEach(el => el.classList.remove('gd-selected'));
}

function finishEditing() {
  if (!ds.editing) return;
  const el = ds.centerEl.querySelector('[data-id="' + ds.editing + '"]');
  if (el) {
    const contentEl = el.querySelector('[contenteditable="true"]');
    if (contentEl) contentEl.blur();
  }
  ds.editing = null;
}

// ══════════════════════════════════════════════════════════════════
//  WIDGET OPERATIONS
// ══════════════════════════════════════════════════════════════════

function addNewWidget(type, extra) {
  const def = { ...W.getDefaults(type), ...extra };

  if (ds.selected) {
    ds.doc = G.insertWidgetAfter(ds.doc, ds.selected, def);
  } else {
    ds.doc = G.addWidget(ds.doc, def);
  }
  renderAll();
}

function deleteSelected() {
  if (!ds.selected) return;
  ds.doc = G.removeWidget(ds.doc, ds.selected);
  ds.selected = null;
  renderAll();
}

function moveSelected(dir) {
  if (!ds.selected) return;
  ds.doc = G.moveWidget(ds.doc, ds.selected, dir);
  renderAll();
  // Re-select
  const el = ds.centerEl.querySelector('[data-id="' + ds.selected + '"]');
  if (el) el.classList.add('gd-selected');
}

function resizeSelected(dRows) {
  if (!ds.selected) return;
  const w = ds.doc.widgets.find(ww => ww.id === ds.selected);
  if (!w) return;
  const newSpan = Math.max(1, w.rowSpan + dRows);
  ds.doc = G.updateWidget(ds.doc, ds.selected, { rowSpan: newSpan });
  renderAll();
  const el = ds.centerEl.querySelector('[data-id="' + ds.selected + '"]');
  if (el) el.classList.add('gd-selected');
}

function setSelectedColumns(colStart, colSpan) {
  if (!ds.selected) return;
  ds.doc = G.updateWidget(ds.doc, ds.selected, { colStart, colSpan });
  renderAll();
  const el = ds.centerEl.querySelector('[data-id="' + ds.selected + '"]');
  if (el) el.classList.add('gd-selected');
}

// ══════════════════════════════════════════════════════════════════
//  TOOLBAR
// ══════════════════════════════════════════════════════════════════

function setupToolbar() {
  _shell.setToolbarTabs([]);
  const el = document.createElement('div');
  el.className = 'pvr-gdocs-bar';

  el.innerHTML = `
    <!-- Undo (not implemented yet — placeholder) -->
    <button class="pvr-ib" id="gd-undo" title="Undo" style="opacity:0.35">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 10h10a5 5 0 0 1 0 10H9"/><polyline points="7 14 3 10 7 6"/></svg>
    </button>
    <button class="pvr-ib" id="gd-redo" title="Redo" style="opacity:0.35">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 10H11a5 5 0 0 0 0 10h4"/><polyline points="17 14 21 10 17 6"/></svg>
    </button>
    <button class="pvr-ib" id="gd-print" title="Print">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Add widgets -->
    <button class="pvr-ib" id="gd-add-title" title="Add heading">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 12h16"/><path d="M4 6h16"/></svg>
      <span style="font-size:10px">H</span>
    </button>
    <button class="pvr-ib" id="gd-add-text" title="Add text block">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
    </button>
    <button class="pvr-ib" id="gd-add-image" title="Add image">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    </button>
    <button class="pvr-ib" id="gd-add-table" title="Add table">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
    </button>
    <button class="pvr-ib" id="gd-add-divider" title="Add divider">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/></svg>
    </button>
    <button class="pvr-ib" id="gd-add-spacer" title="Add spacer">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/><polyline points="8 10 12 14 16 10"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Move / resize selected -->
    <button class="pvr-ib" id="gd-move-up" title="Move widget up">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
    </button>
    <button class="pvr-ib" id="gd-move-down" title="Move widget down">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <button class="pvr-ib" id="gd-shrink" title="Shrink (fewer rows)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <button class="pvr-ib" id="gd-grow" title="Grow (more rows)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <button class="pvr-ib" id="gd-delete" title="Delete widget" style="color:#ef4444">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
    </button>

    <span class="pvr-div"></span>

    <!-- Column layout presets -->
    <select class="pvr-select" id="gd-col-preset" title="Column layout" style="min-width:80px">
      <option value="12">Full width</option>
      <option value="6-L">Left half</option>
      <option value="6-R">Right half</option>
      <option value="4-L">Left third</option>
      <option value="4-M">Middle third</option>
      <option value="4-R">Right third</option>
      <option value="8-L">Two thirds left</option>
      <option value="8-R">Two thirds right</option>
    </select>

    <span class="pvr-div"></span>

    <!-- Page size -->
    <select class="pvr-select" id="gd-page-size" title="Page size" style="min-width:85px">
      <option value="Letter">Letter</option>
      <option value="A4">A4</option>
      <option value="Legal">Legal</option>
      <option value="Tabloid">Tabloid</option>
      <option value="A3">A3</option>
      <option value="A5">A5</option>
      <option value="Wide">Wide (16:9)</option>
      <option value="custom">Custom…</option>
    </select>

    <span style="flex:1"></span>

    <!-- Save / Export -->
    <button class="pvr-ib" id="gd-save" title="Save .gdoc">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
    </button>
    <button class="pvr-ib" id="gd-export" title="Export as PDF" style="color:var(--accent)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>

    <span class="pvr-div"></span>

    <span class="pvr-mode-badge">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
      Editing
    </span>
  `;

  _shell.setToolbarBandEl(el);

  // Wire
  el.querySelector('#gd-print').addEventListener('click', () => window.print());
  el.querySelector('#gd-add-title').addEventListener('click',   () => addNewWidget('title'));
  el.querySelector('#gd-add-text').addEventListener('click',    () => addNewWidget('textbox'));
  el.querySelector('#gd-add-image').addEventListener('click',   () => promptInsertImage());
  el.querySelector('#gd-add-table').addEventListener('click',   () => addNewWidget('table'));
  el.querySelector('#gd-add-divider').addEventListener('click', () => addNewWidget('divider'));
  el.querySelector('#gd-add-spacer').addEventListener('click',  () => addNewWidget('spacer'));
  el.querySelector('#gd-move-up').addEventListener('click',   () => moveSelected(-1));
  el.querySelector('#gd-move-down').addEventListener('click', () => moveSelected(1));
  el.querySelector('#gd-shrink').addEventListener('click',    () => resizeSelected(-1));
  el.querySelector('#gd-grow').addEventListener('click',      () => resizeSelected(1));
  el.querySelector('#gd-delete').addEventListener('click',    () => deleteSelected());
  el.querySelector('#gd-save').addEventListener('click',      () => saveGdoc());
  el.querySelector('#gd-export').addEventListener('click',    () => exportPdf());

  // Set current page size in dropdown
  const pageSizeSel = el.querySelector('#gd-page-size');
  const currentPreset = ds.doc.canvas.preset || 'Letter';
  if (pageSizeSel.querySelector('option[value="' + currentPreset + '"]')) {
    pageSizeSel.value = currentPreset;
  } else {
    pageSizeSel.value = 'custom';
  }

  pageSizeSel.addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'custom') {
      const wStr = prompt('Page width in pixels (e.g. 816):', ds.doc.canvas.width);
      if (!wStr) { pageSizeSel.value = ds.doc.canvas.preset || 'Letter'; return; }
      const hStr = prompt('Page height in pixels (e.g. 1056):', ds.doc.canvas.height);
      if (!hStr) { pageSizeSel.value = ds.doc.canvas.preset || 'Letter'; return; }
      const w = parseInt(wStr), h = parseInt(hStr);
      if (w > 0 && h > 0) {
        ds.doc = { ...ds.doc, canvas: { ...ds.doc.canvas, preset: 'Custom', width: w, height: h } };
        renderAll();
      }
    } else {
      const preset = G.CANVAS_PRESETS[v];
      if (preset) {
        ds.doc = { ...ds.doc, canvas: { ...ds.doc.canvas, preset: v, width: preset.width, height: preset.height } };
        renderAll();
      }
    }
  });

  el.querySelector('#gd-col-preset').addEventListener('change', (e) => {
    if (!ds.selected) return;
    const v = e.target.value;
    const map = {
      '12':  { colStart: 1, colSpan: 12 },
      '6-L': { colStart: 1, colSpan: 6 },
      '6-R': { colStart: 7, colSpan: 6 },
      '4-L': { colStart: 1, colSpan: 4 },
      '4-M': { colStart: 5, colSpan: 4 },
      '4-R': { colStart: 9, colSpan: 4 },
      '8-L': { colStart: 1, colSpan: 8 },
      '8-R': { colStart: 5, colSpan: 8 },
    };
    const m = map[v];
    if (m) setSelectedColumns(m.colStart, m.colSpan);
    e.target.value = '12'; // reset dropdown
  });
}

// ══════════════════════════════════════════════════════════════════
//  SIDEBAR
// ══════════════════════════════════════════════════════════════════

function setupSidebar() {
  const sb = document.createElement('div');
  sb.style.cssText = 'display:flex;flex-direction:column;height:100%;';
  sb.innerHTML = `
    <div style="padding:10px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:rgba(255,255,255,0.35);">Flow Order</div>
    <div id="gd-flow-list" class="gd-flow-list"></div>`;
  _shell.setSidebarContent(sb);
  updateFlowList();
}

function updateFlowList() {
  const list = document.getElementById('gd-flow-list');
  if (!list) return;
  list.innerHTML = '';
  const resolved = G.resolveFlow(ds.doc.widgets, ds.doc.canvas);
  resolved.forEach(w => {
    const item = document.createElement('div');
    item.className = 'gd-flow-item' + (ds.selected === w.id ? ' gd-flow-active' : '');
    item.dataset.id = w.id;
    const label = w.type.charAt(0).toUpperCase() + w.type.slice(1);
    const preview = w.content ? ': ' + w.content.slice(0, 30) : '';
    item.innerHTML = '<span class="gd-flow-type">' + label + '</span><span class="gd-flow-preview">' + esc(preview) + '</span><span class="gd-flow-meta">p' + w.page + ' r' + w.row + '</span>';
    item.addEventListener('click', () => {
      selectWidget(w.id);
      updateFlowList();
      // Scroll widget into view
      const wEl = ds.centerEl.querySelector('[data-id="' + w.id + '"]');
      if (wEl) wEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    list.appendChild(item);
  });
}

// ══════════════════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════════════════

let _keyHandler = null;

function setupKeys() {
  if (_keyHandler) document.removeEventListener('keydown', _keyHandler);
  _keyHandler = (e) => {
    if (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); e.preventDefault(); }
    if (e.key === 'ArrowUp'   && e.altKey) { moveSelected(-1); e.preventDefault(); }
    if (e.key === 'ArrowDown' && e.altKey) { moveSelected(1);  e.preventDefault(); }
    if (e.key === 'Escape') { deselect(); finishEditing(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveGdoc(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); window.print(); }
  };
  document.addEventListener('keydown', _keyHandler);
}

// ══════════════════════════════════════════════════════════════════
//  SAVE / EXPORT
// ══════════════════════════════════════════════════════════════════

function saveGdoc() {
  const text = G.serializeDocument(ds.doc);
  const blob = new Blob([text], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = (ds.doc.meta.title || 'document') + '.gdoc';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function exportPdf() {
  // Lazy-load pdf-lib
  const PDFLIB_SRC = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  if (!window.PDFLib) await _shell.loadScript(PDFLIB_SRC);
  const PL = window.PDFLib;

  const { pages, metrics, canvas } = G.renderDocument(ds.doc);
  const doc = await PL.PDFDocument.create();
  const font     = await doc.embedFont(PL.StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(PL.StandardFonts.HelveticaBold);

  for (const pg of pages) {
    const page = doc.addPage([canvas.width, canvas.height]);

    for (const w of pg.widgets) {
      const px = w.px;
      // PDF y is from bottom
      const pdfY = canvas.height - px.y - px.height;

      switch (w.type) {
        case 'title':
          try { page.drawText(w.content || '', { x: px.x + 4, y: pdfY + px.height - 28, size: 24, font: fontBold, color: PL.rgb(0, 0, 0) }); } catch {}
          break;
        case 'textbox': {
          const lines = (w.content || '').split('\n');
          let ty = pdfY + px.height - 16;
          for (const line of lines) {
            if (ty < pdfY + 8) break;
            // Simple word wrap
            const words = line.split(' ');
            let cur = '';
            for (const word of words) {
              const test = cur ? cur + ' ' + word : word;
              let tw; try { tw = font.widthOfTextAtSize(test, 12); } catch { tw = test.length * 6; }
              if (tw > px.width - 12 && cur) {
                try { page.drawText(cur, { x: px.x + 6, y: ty, size: 12, font, color: PL.rgb(0,0,0) }); } catch {}
                ty -= 16;
                cur = word;
              } else { cur = test; }
            }
            if (cur) { try { page.drawText(cur, { x: px.x + 6, y: ty, size: 12, font, color: PL.rgb(0,0,0) }); } catch {} ty -= 16; }
          }
          break;
        }
        case 'table': {
          const headers = w.headers || [];
          const rows = w.rows || [];
          const numCols = headers.length || (rows[0] || []).length || 1;
          const colW = px.width / numCols;
          const rowH = 20;
          let ty = pdfY + px.height;
          // Headers
          for (let ci = 0; ci < numCols; ci++) {
            page.drawRectangle({ x: px.x + ci * colW, y: ty - rowH, width: colW, height: rowH, borderColor: PL.rgb(0.7,0.7,0.7), borderWidth: 0.5, color: PL.rgb(0.95,0.95,0.95) });
            try { page.drawText((headers[ci] || '').slice(0, 50), { x: px.x + ci * colW + 4, y: ty - 14, size: 10, font: fontBold, color: PL.rgb(0,0,0) }); } catch {}
          }
          ty -= rowH;
          for (const row of rows) {
            for (let ci = 0; ci < numCols; ci++) {
              page.drawRectangle({ x: px.x + ci * colW, y: ty - rowH, width: colW, height: rowH, borderColor: PL.rgb(0.7,0.7,0.7), borderWidth: 0.5 });
              try { page.drawText(String(row[ci] || '').slice(0, 50), { x: px.x + ci * colW + 4, y: ty - 14, size: 10, font, color: PL.rgb(0,0,0) }); } catch {}
            }
            ty -= rowH;
          }
          break;
        }
        case 'divider':
          page.drawLine({ start: { x: px.x, y: pdfY + px.height / 2 }, end: { x: px.x + px.width, y: pdfY + px.height / 2 }, thickness: w.thickness || 1, color: PL.rgb(0.85, 0.85, 0.85) });
          break;
      }
    }
  }

  const bytes = await doc.save();
  const blob  = new Blob([bytes], { type: 'application/pdf' });
  const a     = document.createElement('a');
  a.href      = URL.createObjectURL(blob);
  a.download  = (ds.doc.meta.title || 'document') + '.pdf';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ══════════════════════════════════════════════════════════════════
//  AGENT INTERFACE
// ══════════════════════════════════════════════════════════════════

function registerEditorInterface() {
  const proxy = {
    type: 'gdoc',
    getText: () => G.documentSummaryForLLM(ds.doc),
    getDocument: () => ds.doc,
    addWidget: (def) => { ds.doc = G.addWidget(ds.doc, def); renderAll(); },
    updateWidget: (id, changes) => { ds.doc = G.updateWidget(ds.doc, id, changes); renderAll(); },
    removeWidget: (id) => { ds.doc = G.removeWidget(ds.doc, id); renderAll(); },
    moveWidget: (id, dir) => { ds.doc = G.moveWidget(ds.doc, id, dir); renderAll(); },
    serialize: () => G.serializeDocument(ds.doc),
  };
  window.__activeEditor = proxy;
  window.__activeEditorType = 'gdoc';
  if (_shell && _shell.registerEditor) _shell.registerEditor(proxy, 'gdoc');
}

// ══════════════════════════════════════════════════════════════════
//  AUTO-SAVE
// ══════════════════════════════════════════════════════════════════

function scheduleAutoSave() {
  if (ds.saveTimer) clearTimeout(ds.saveTimer);
  ds.dirty = true;
  ds.saveTimer = setTimeout(autoSave, 1200); // 1.2s debounce
  // Show saving indicator
  const status = document.getElementById('pv-save-status');
  if (status) status.textContent = 'Unsaved';
}

async function autoSave() {
  if (!ds.doc || !ds.dirty) return;
  ds.dirty = false;
  const status = document.getElementById('pv-save-status');
  if (status) status.textContent = 'Saving\u2026';

  try {
    const text = G.serializeDocument(ds.doc);
    const fileName = (ds.doc.meta.title || 'Untitled') + '.gdoc';

    // Save to server
    await fetch('/api/files/write-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ds.filePath || fileName, content: text }),
    });

    if (status) status.textContent = 'Saved';
    setTimeout(() => { if (status && status.textContent === 'Saved') status.textContent = ''; }, 2000);
  } catch (err) {
    console.warn('[autoSave] failed:', err);
    if (status) status.textContent = 'Save failed';
    ds.dirty = true; // retry next time
  }
}

// ══════════════════════════════════════════════════════════════════
//  IMAGE PASTE / DROP / INSERT
// ══════════════════════════════════════════════════════════════════

function setupImageHandlers() {
  const el = ds.centerEl;

  // Paste from clipboard
  document.addEventListener('paste', handlePaste);

  // Drag & drop onto pages
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  el.addEventListener('drop', handleDrop);
}

function handlePaste(e) {
  if (!ds.doc) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) uploadAndInsertImage(file);
      return;
    }
  }
}

function handleDrop(e) {
  e.preventDefault();
  if (!ds.doc) return;
  const files = e.dataTransfer?.files;
  if (!files || !files.length) return;
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      uploadAndInsertImage(file);
    }
  }
}

async function uploadAndInsertImage(file) {
  const status = document.getElementById('pv-save-status');
  if (status) status.textContent = 'Uploading image\u2026';

  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/files/upload?target=temp', { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.path && !data.name) throw new Error('Upload failed');

    const src = '/api/files/serve?path=' + encodeURIComponent(data.path || data.name);
    addNewWidget('image', { src, alt: file.name });

    if (status) status.textContent = '';
  } catch (err) {
    console.warn('[uploadImage]', err);
    if (status) status.textContent = 'Upload failed';
    // Fallback: use data URL
    const reader = new FileReader();
    reader.onload = () => {
      addNewWidget('image', { src: reader.result, alt: file.name });
      if (status) status.textContent = '';
    };
    reader.readAsDataURL(file);
  }
}

function promptInsertImage() {
  // Show a choice: URL or file upload
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    if (input.files[0]) uploadAndInsertImage(input.files[0]);
  });
  input.click();
}

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function updateStatusText(key, text) {
  // Use the same status bar approach as PDFViewer if available
  const map = { page: 'pve-page-status', widgets: 'pve-tool-status' };
  const el = document.getElementById(map[key]);
  if (el) el.textContent = text;
}

// ══════════════════════════════════════════════════════════════════
//  CLEANUP
// ══════════════════════════════════════════════════════════════════

function cleanup() {
  if (ds.dirty) autoSave(); // flush pending save
  if (ds.saveTimer) { clearTimeout(ds.saveTimer); ds.saveTimer = null; }
  if (_keyHandler) { document.removeEventListener('keydown', _keyHandler); _keyHandler = null; }
  document.removeEventListener('paste', handlePaste);
  if (_shell && _shell.unregisterEditor) _shell.unregisterEditor();
  window.__activeEditor = null;
  window.__activeEditorType = null;
  ds.doc = null; ds.selected = null; ds.editing = null; ds.dirty = false;
}

// ══════════════════════════════════════════════════════════════════
//  REGISTER
// ══════════════════════════════════════════════════════════════════

if (!window.Viewers) window.Viewers = {};
window.Viewers.gdoc = { mount, cleanup };

})();
