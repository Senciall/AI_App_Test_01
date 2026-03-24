'use strict';
/* ═══════════════════════════════════════════════════════════════
   gdoc-engine.js  (browser build — IIFE)
   Grid-based flow document engine.
   ═══════════════════════════════════════════════════════════════ */

(function () {

// ─── CONSTANTS ───────────────────────────────────────────────

const CANVAS_PRESETS = {
  Letter:  { width: 816,  height: 1056 },
  A4:      { width: 794,  height: 1123 },
  Legal:   { width: 816,  height: 1344 },
  Tabloid: { width: 1056, height: 1632 },
  A3:      { width: 1123, height: 1587 },
  A5:      { width: 559,  height: 794  },
  Wide:    { width: 1280, height: 720  },
};

const WIDGET_TYPES = {
  TITLE:   'title',
  TEXTBOX: 'textbox',
  IMAGE:   'image',
  TABLE:   'table',
  CHART:   'chart',
  DIVIDER: 'divider',
  SPACER:  'spacer',
};

const DEFAULT_CANVAS = {
  preset:  'A4',
  width:   794,
  height:  1123,
  margin:  32,
  grid: { columns: 12, rows: 24, gutterX: 8, gutterY: 8 },
};

// ─── GRID MATH ───────────────────────────────────────────────

function computeGridMetrics(canvas) {
  const { width, height, margin, grid } = canvas;
  const { columns, rows, gutterX, gutterY } = grid;
  const usableWidth  = width  - margin * 2;
  const usableHeight = height - margin * 2;
  const cellWidth  = (usableWidth  - gutterX * (columns - 1)) / columns;
  const cellHeight = (usableHeight - gutterY * (rows    - 1)) / rows;
  return { usableWidth, usableHeight, cellWidth, cellHeight, columns, rows, gutterX, gutterY, margin, canvasWidth: width, canvasHeight: height };
}

function gridToPixels(widget, metrics) {
  const { colStart, colSpan, rowSpan, row } = widget;
  const { cellWidth, cellHeight, gutterX, gutterY, margin } = metrics;
  const x      = margin + (colStart - 1) * (cellWidth  + gutterX);
  const y      = margin + (row      - 1) * (cellHeight + gutterY);
  const w      = colSpan * cellWidth  + (colSpan - 1) * gutterX;
  const h      = rowSpan * cellHeight + (rowSpan - 1) * gutterY;
  return { x, y, width: w, height: h };
}

// ─── FLOW ENGINE ─────────────────────────────────────────────

function resolveFlow(widgets, canvas) {
  const metrics   = computeGridMetrics(canvas);
  const totalRows = metrics.rows;
  const rowGap    = 1;
  const sorted    = [...widgets].sort((a, b) => a.flowIndex - b.flowIndex);

  // Group by flowIndex (same flowIndex = side by side)
  const groups = [];
  for (const widget of sorted) {
    const last = groups[groups.length - 1];
    if (last && last[0].flowIndex === widget.flowIndex) {
      last.push(widget);
    } else {
      groups.push([widget]);
    }
  }

  const resolved = [];
  let currentRow  = 1;
  let currentPage = 1;

  for (const group of groups) {
    const tallest = Math.max(...group.map(w => w.rowSpan));
    if (currentRow + tallest - 1 > totalRows) {
      currentPage += 1;
      currentRow   = 1;
    }
    for (const widget of group) {
      resolved.push({ ...widget, row: currentRow, page: currentPage });
    }
    currentRow += tallest + rowGap;
  }

  return resolved;
}

// ─── DOCUMENT OPERATIONS ─────────────────────────────────────

function createDocument(preset) {
  preset = preset || 'A4';
  const dimensions = CANVAS_PRESETS[preset] || CANVAS_PRESETS.A4;
  return {
    meta: { version: '1.0', title: 'Untitled Document', author: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    canvas: { ...DEFAULT_CANVAS, preset, ...dimensions, grid: { ...DEFAULT_CANVAS.grid } },
    widgets: [],
  };
}

function addWidget(doc, widgetDef) {
  const maxFlow = doc.widgets.reduce((max, w) => Math.max(max, w.flowIndex), 0);
  const widget  = {
    colStart: 1, colSpan: 12, rowSpan: 3, style: {},
    ...widgetDef,
    id:        widgetDef.id || ('w' + Date.now() + Math.random().toString(36).slice(2, 6)),
    flowIndex: widgetDef.flowIndex != null ? widgetDef.flowIndex : maxFlow + 1,
  };
  return { ...doc, widgets: [...doc.widgets, widget], meta: { ...doc.meta, updatedAt: new Date().toISOString() } };
}

function updateWidget(doc, id, changes) {
  return { ...doc, widgets: doc.widgets.map(w => w.id === id ? { ...w, ...changes } : w), meta: { ...doc.meta, updatedAt: new Date().toISOString() } };
}

function removeWidget(doc, id) {
  return { ...doc, widgets: reindexFlow(doc.widgets.filter(w => w.id !== id)), meta: { ...doc.meta, updatedAt: new Date().toISOString() } };
}

function moveWidget(doc, id, direction) {
  const widget = doc.widgets.find(w => w.id === id);
  if (!widget) return doc;
  const targetFlow = widget.flowIndex + direction;
  const swapTarget = doc.widgets.find(w => w.flowIndex === targetFlow && w.id !== id);
  const updated = doc.widgets.map(w => {
    if (w.id === id) return { ...w, flowIndex: targetFlow };
    if (swapTarget && w.id === swapTarget.id) return { ...w, flowIndex: widget.flowIndex };
    return w;
  });
  return { ...doc, widgets: updated, meta: { ...doc.meta, updatedAt: new Date().toISOString() } };
}

function insertWidgetAfter(doc, afterId, widgetDef) {
  const after    = doc.widgets.find(w => w.id === afterId);
  const insertAt = after ? after.flowIndex + 1 : 1;
  const shifted  = doc.widgets.map(w => w.flowIndex >= insertAt ? { ...w, flowIndex: w.flowIndex + 1 } : w);
  const newWidget = {
    colStart: 1, colSpan: 12, rowSpan: 3, style: {},
    ...widgetDef,
    id: widgetDef.id || ('w' + Date.now() + Math.random().toString(36).slice(2, 6)),
    flowIndex: insertAt,
  };
  return { ...doc, widgets: [...shifted, newWidget], meta: { ...doc.meta, updatedAt: new Date().toISOString() } };
}

// ─── RENDER ──────────────────────────────────────────────────

function renderDocument(doc) {
  const metrics  = computeGridMetrics(doc.canvas);
  const resolved = resolveFlow(doc.widgets, doc.canvas);
  const pageMap  = {};
  for (const widget of resolved) {
    if (!pageMap[widget.page]) pageMap[widget.page] = [];
    pageMap[widget.page].push({ ...widget, px: gridToPixels(widget, metrics) });
  }
  const pages = Object.keys(pageMap).map(Number).sort((a, b) => a - b).map(pn => ({ pageNumber: pn, widgets: pageMap[pn] }));
  return { pages, metrics, canvas: doc.canvas };
}

// ─── SERIALIZATION ───────────────────────────────────────────

function serializeDocument(doc) {
  const { meta, canvas, widgets } = doc;
  const lines = [];
  lines.push('GDOC v' + meta.version);
  lines.push('title:     ' + meta.title);
  lines.push('author:    ' + (meta.author || '(none)'));
  lines.push('createdAt: ' + meta.createdAt);
  lines.push('updatedAt: ' + meta.updatedAt);
  lines.push('');
  lines.push('CANVAS');
  lines.push('  preset:  ' + canvas.preset);
  lines.push('  width:   ' + canvas.width);
  lines.push('  height:  ' + canvas.height);
  lines.push('  margin:  ' + canvas.margin);
  lines.push('  GRID');
  lines.push('    columns: ' + canvas.grid.columns);
  lines.push('    rows:    ' + canvas.grid.rows);
  lines.push('    gutterX: ' + canvas.grid.gutterX);
  lines.push('    gutterY: ' + canvas.grid.gutterY);
  lines.push('  END GRID');
  lines.push('END CANVAS');
  lines.push('');

  const sorted = [...widgets].sort((a, b) => a.flowIndex - b.flowIndex);
  for (const w of sorted) {
    lines.push('WIDGET ' + w.id);
    lines.push('  type:      ' + w.type);
    lines.push('  flowIndex: ' + w.flowIndex);
    lines.push('  colStart:  ' + w.colStart);
    lines.push('  colSpan:   ' + w.colSpan);
    lines.push('  rowSpan:   ' + w.rowSpan);
    if (w.group) lines.push('  group:     ' + w.group);
    if (w.type === 'title' || w.type === 'textbox') {
      if (w.content !== undefined) {
        if (String(w.content).includes('\n')) {
          lines.push('  content: |');
          String(w.content).split('\n').forEach(function (l) { lines.push('    ' + l); });
        } else {
          lines.push('  content:   "' + w.content + '"');
        }
      }
    }
    if (w.type === 'image') { lines.push('  src:       ' + (w.src || '')); lines.push('  alt:       "' + (w.alt || '') + '"'); lines.push('  fit:       ' + (w.fit || 'cover')); }
    if (w.type === 'table') { if (w.headers) lines.push('  headers:   ' + JSON.stringify(w.headers)); if (w.rows) { lines.push('  rows:'); w.rows.forEach(function (r) { lines.push('    - ' + JSON.stringify(r)); }); } }
    if (w.type === 'chart') { lines.push('  chartType: ' + (w.chartType || 'bar')); if (w.labels) lines.push('  labels:    ' + JSON.stringify(w.labels)); if (w.data) lines.push('  data:      ' + JSON.stringify(w.data)); }
    if (w.type === 'divider') { lines.push('  thickness: ' + (w.thickness || 1)); lines.push('  color:     ' + (w.color || '#e0e0e0')); }
    if (w.style && Object.keys(w.style).length > 0) { lines.push('  style:'); for (var k in w.style) { lines.push('    ' + k + ': ' + w.style[k]); } }
    lines.push('END ' + w.id);
    lines.push('');
  }
  return lines.join('\n');
}

function parseDocument(text) {
  var lines = text.split('\n');
  var doc = { meta: {}, canvas: { ...DEFAULT_CANVAS, grid: { ...DEFAULT_CANVAS.grid } }, widgets: [] };
  var i = 0;
  function peek() { return lines[i] ? lines[i].trim() : undefined; }
  function next() { return lines[i++] ? lines[i - 1].trim() : undefined; }

  // Header
  var header = next();
  doc.meta.version = (header || '').split('v')[1] || '1.0';
  while (i < lines.length && !(peek() || '').startsWith('CANVAS')) {
    var line = next(); if (!line || line.startsWith('//')) continue;
    var parts = line.split(':'); var key = parts[0].trim(); var val = parts.slice(1).join(':').trim();
    if (key === 'title') doc.meta.title = val;
    if (key === 'author') doc.meta.author = val;
    if (key === 'createdAt') doc.meta.createdAt = val;
    if (key === 'updatedAt') doc.meta.updatedAt = val;
  }
  // Canvas
  if (peek() === 'CANVAS') {
    next();
    while (!(peek() || '').startsWith('END CANVAS')) {
      var cl = next(); if (!cl || cl.startsWith('//')) continue;
      if (cl === 'GRID') { while (!(peek() || '').startsWith('END GRID')) { var gl = next(); if (!gl) continue; var gp = gl.split(':').map(function(s){return s.trim();}); if(gp[0]==='columns')doc.canvas.grid.columns=+gp[1]; if(gp[0]==='rows')doc.canvas.grid.rows=+gp[1]; if(gp[0]==='gutterX')doc.canvas.grid.gutterX=+gp[1]; if(gp[0]==='gutterY')doc.canvas.grid.gutterY=+gp[1]; } next(); continue; }
      var cp = cl.split(':').map(function(s){return s.trim();}); if(cp[0]==='preset')doc.canvas.preset=cp[1]; if(cp[0]==='width')doc.canvas.width=+cp[1]; if(cp[0]==='height')doc.canvas.height=+cp[1]; if(cp[0]==='margin')doc.canvas.margin=+cp[1];
    }
    next();
  }
  while (i < lines.length && (peek() === '' || (peek() || '').startsWith('//'))) i++;

  // Widgets
  while (i < lines.length) {
    var wl = peek();
    if (!wl || wl.startsWith('//')) { i++; continue; }
    if (wl.startsWith('WIDGET ')) {
      var wid = wl.split(' ')[1]; next();
      var w = { id: wid, style: {} };
      var inStyle = false, inRows = false, inContent = false, contentLines = [];
      while (!(peek() || '').startsWith('END ' + wid)) {
        var raw = lines[i++]; if (raw === undefined) break;
        var t = raw.trim(); if (!t) continue;
        if (inContent) { if (t.startsWith('style:') || t.startsWith('END')) { w.content = contentLines.join('\n'); inContent = false; contentLines = []; i--; continue; } contentLines.push(raw.replace(/^    /, '')); continue; }
        if (inRows) { if (t.startsWith('-')) { try { w.rows.push(JSON.parse(t.slice(1).trim())); } catch(e){} continue; } else { inRows = false; } }
        if (inStyle) { if (!t.match(/^\w/) || t.startsWith('END')) { inStyle = false; i--; continue; } var sp = t.split(':'); w.style[sp[0].trim()] = sp.slice(1).join(':').trim(); continue; }
        var ci = t.indexOf(':'); if (ci === -1) continue;
        var wk = t.slice(0, ci).trim(), wv = t.slice(ci+1).trim();
        if(wk==='style'){inStyle=true;continue;} if(wk==='rows'){w.rows=[];inRows=true;continue;} if(wk==='content'&&wv==='|'){inContent=true;contentLines=[];continue;}
        if(wk==='type')w.type=wv; if(wk==='flowIndex')w.flowIndex=+wv; if(wk==='colStart')w.colStart=+wv; if(wk==='colSpan')w.colSpan=+wv; if(wk==='rowSpan')w.rowSpan=+wv; if(wk==='group')w.group=wv;
        if(wk==='content')w.content=wv.replace(/^"|"$/g,''); if(wk==='src')w.src=wv; if(wk==='alt')w.alt=wv.replace(/^"|"$/g,''); if(wk==='fit')w.fit=wv;
        if(wk==='headers'){try{w.headers=JSON.parse(wv);}catch(e){}} if(wk==='chartType')w.chartType=wv; if(wk==='labels'){try{w.labels=JSON.parse(wv);}catch(e){}} if(wk==='data'){try{w.data=JSON.parse(wv);}catch(e){}}
        if(wk==='thickness')w.thickness=+wv; if(wk==='color')w.color=wv; if(wk==='title')w.title=wv.replace(/^"|"$/g,'');
      }
      if (inContent) w.content = contentLines.join('\n');
      next();
      doc.widgets.push(w);
    } else { i++; }
  }
  return doc;
}

// ─── HELPERS ─────────────────────────────────────────────────

function reindexFlow(widgets) {
  var sorted = [...widgets].sort((a, b) => a.flowIndex - b.flowIndex);
  var counter = 1, prev = null;
  return sorted.map(w => {
    if (prev !== null && w.flowIndex !== prev) counter++;
    prev = w.flowIndex;
    return { ...w, flowIndex: counter };
  });
}

function documentSummaryForLLM(doc) {
  var resolved = resolveFlow(doc.widgets, doc.canvas);
  var lines = [];
  lines.push('Document: "' + doc.meta.title + '"');
  lines.push('Canvas: ' + doc.canvas.preset + ' (' + doc.canvas.width + '\u00d7' + doc.canvas.height + 'px), ' + doc.canvas.grid.columns + ' columns, ' + doc.canvas.grid.rows + ' rows per page');
  lines.push('');
  lines.push('Widgets in flow order:');
  for (var ri = 0; ri < resolved.length; ri++) {
    var w = resolved[ri];
    lines.push('  [' + w.id + '] flow:' + w.flowIndex + ' type:' + w.type + ' page:' + w.page + ' row:' + w.row + ' col:' + w.colStart + ' colSpan:' + w.colSpan + ' rowSpan:' + w.rowSpan + (w.content ? ' content:"' + String(w.content).slice(0, 60) + '"' : '') + (w.src ? ' src:' + w.src : ''));
  }
  return lines.join('\n');
}

// ─── EXPORTS ─────────────────────────────────────────────────

window.GDocEngine = {
  CANVAS_PRESETS, WIDGET_TYPES, DEFAULT_CANVAS,
  computeGridMetrics, gridToPixels, resolveFlow,
  createDocument, addWidget, updateWidget, removeWidget, moveWidget, insertWidgetAfter,
  renderDocument, serializeDocument, parseDocument,
  documentSummaryForLLM,
};

})();
