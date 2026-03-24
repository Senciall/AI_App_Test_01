/**
 * gdoc-engine.js
 * ─────────────────────────────────────────────────────────────
 * A self-contained document layout engine.
 * Drop this file into any project and import what you need.
 *
 * USAGE:
 *   import { parseDocument, renderDocument, createDocument } from './gdoc-engine.js'
 *
 * ─────────────────────────────────────────────────────────────
 */

// ─── CONSTANTS ───────────────────────────────────────────────

export const CANVAS_PRESETS = {
  A4:     { width: 794,  height: 1123 },
  Letter: { width: 816,  height: 1056 },
  Legal:  { width: 816,  height: 1344 },
  Wide:   { width: 1280, height: 720  },
};

export const WIDGET_TYPES = {
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
  grid: {
    columns: 12,
    rows:    24,
    gutterX: 8,
    gutterY: 8,
  },
};

// ─── GRID MATH ───────────────────────────────────────────────

/**
 * Derives all grid measurements from a canvas config.
 * This is the single source of truth for all sizing.
 *
 * @param {object} canvas
 * @returns {object} gridMetrics
 */
export function computeGridMetrics(canvas) {
  const { width, height, margin, grid } = canvas;
  const { columns, rows, gutterX, gutterY } = grid;

  const usableWidth  = width  - margin * 2;
  const usableHeight = height - margin * 2;

  const cellWidth  = (usableWidth  - gutterX * (columns - 1)) / columns;
  const cellHeight = (usableHeight - gutterY * (rows    - 1)) / rows;

  return {
    usableWidth,
    usableHeight,
    cellWidth,
    cellHeight,
    columns,
    rows,
    gutterX,
    gutterY,
    margin,
    canvasWidth:  width,
    canvasHeight: height,
  };
}

/**
 * Converts grid coordinates to absolute pixel position on canvas.
 *
 * @param {object} widget  - must have colStart, colSpan, rowSpan; row is injected by flow
 * @param {object} metrics - from computeGridMetrics()
 * @returns {{ x, y, width, height }}
 */
export function gridToPixels(widget, metrics) {
  const { colStart, colSpan, rowSpan, row } = widget;
  const { cellWidth, cellHeight, gutterX, gutterY, margin } = metrics;

  const x      = margin + (colStart - 1) * (cellWidth  + gutterX);
  const y      = margin + (row      - 1) * (cellHeight + gutterY);
  const width  = colSpan * cellWidth  + (colSpan - 1) * gutterX;
  const height = rowSpan * cellHeight + (rowSpan - 1) * gutterY;

  return { x, y, width, height };
}

// ─── FLOW ENGINE ─────────────────────────────────────────────

/**
 * Resolves absolute row positions for all widgets across all pages.
 * Widgets only store flowIndex + rowSpan. Row is always computed here.
 *
 * Rules:
 *  - Widgets sorted by flowIndex
 *  - Same flowIndex = side-by-side (group). Flow advances by tallest in group.
 *  - When currentRow + rowSpan > totalRows → overflow to next page
 *
 * @param {object[]} widgets  - raw widget declarations
 * @param {object}   canvas
 * @returns {object[]} resolvedWidgets - widgets with { row, page } injected
 */
export function resolveFlow(widgets, canvas) {
  const metrics    = computeGridMetrics(canvas);
  const totalRows  = metrics.rows;
  const rowGap     = 1; // 1 row gap between widgets in flow

  // Sort by flowIndex
  const sorted = [...widgets].sort((a, b) => a.flowIndex - b.flowIndex);

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

    // Check if group fits on current page
    if (currentRow + tallest - 1 > totalRows) {
      currentPage += 1;
      currentRow   = 1;
    }

    for (const widget of group) {
      resolved.push({
        ...widget,
        row:  currentRow,
        page: currentPage,
      });
    }

    currentRow += tallest + rowGap;
  }

  return resolved;
}

// ─── DOCUMENT OPERATIONS ─────────────────────────────────────

/**
 * Creates a new empty document.
 *
 * @param {string} preset - key from CANVAS_PRESETS
 * @returns {object} document
 */
export function createDocument(preset = 'A4') {
  const dimensions = CANVAS_PRESETS[preset] || CANVAS_PRESETS.A4;
  return {
    meta: {
      version:   '1.0',
      title:     'Untitled Document',
      author:    '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    canvas: {
      ...DEFAULT_CANVAS,
      preset,
      ...dimensions,
    },
    widgets: [],
  };
}

/**
 * Adds a widget to the document at the end of the flow.
 *
 * @param {object} doc
 * @param {object} widgetDef - partial widget, flowIndex auto-assigned if omitted
 * @returns {object} updated document (immutable — returns new object)
 */
export function addWidget(doc, widgetDef) {
  const maxFlow = doc.widgets.reduce((max, w) => Math.max(max, w.flowIndex), 0);
  const widget  = {
    colStart:  1,
    colSpan:   12,
    rowSpan:   3,
    style:     {},
    ...widgetDef,
    id:        widgetDef.id || `w${Date.now()}`,
    flowIndex: widgetDef.flowIndex ?? maxFlow + 1,
  };
  return {
    ...doc,
    widgets:    [...doc.widgets, widget],
    meta: { ...doc.meta, updatedAt: new Date().toISOString() },
  };
}

/**
 * Updates a widget by id. Only the provided fields are changed.
 *
 * @param {object} doc
 * @param {string} id
 * @param {object} changes - any widget fields to update
 * @returns {object} updated document
 */
export function updateWidget(doc, id, changes) {
  return {
    ...doc,
    widgets: doc.widgets.map(w =>
      w.id === id ? { ...w, ...changes } : w
    ),
    meta: { ...doc.meta, updatedAt: new Date().toISOString() },
  };
}

/**
 * Removes a widget by id and re-indexes flowIndex values to stay contiguous.
 *
 * @param {object} doc
 * @param {string} id
 * @returns {object} updated document
 */
export function removeWidget(doc, id) {
  const filtered = doc.widgets.filter(w => w.id !== id);
  // Re-index to keep flow contiguous
  const reindexed = reindexFlow(filtered);
  return {
    ...doc,
    widgets: reindexed,
    meta: { ...doc.meta, updatedAt: new Date().toISOString() },
  };
}

/**
 * Moves a widget up or down in the flow by swapping flowIndex values.
 *
 * @param {object} doc
 * @param {string} id
 * @param {number} direction - positive = down, negative = up
 * @returns {object} updated document
 */
export function moveWidget(doc, id, direction) {
  const widget    = doc.widgets.find(w => w.id === id);
  if (!widget) return doc;

  const targetFlow = widget.flowIndex + direction;
  const swapTarget = doc.widgets.find(w => w.flowIndex === targetFlow && w.id !== id);

  let updated = doc.widgets.map(w => {
    if (w.id === id)                     return { ...w, flowIndex: targetFlow };
    if (swapTarget && w.id === swapTarget.id) return { ...w, flowIndex: widget.flowIndex };
    return w;
  });

  return {
    ...doc,
    widgets: updated,
    meta: { ...doc.meta, updatedAt: new Date().toISOString() },
  };
}

/**
 * Inserts a widget after a given widget id, shifting all widgets below it down.
 *
 * @param {object} doc
 * @param {string} afterId
 * @param {object} widgetDef
 * @returns {object} updated document
 */
export function insertWidgetAfter(doc, afterId, widgetDef) {
  const after     = doc.widgets.find(w => w.id === afterId);
  const insertAt  = after ? after.flowIndex + 1 : 1;

  const shifted = doc.widgets.map(w =>
    w.flowIndex >= insertAt ? { ...w, flowIndex: w.flowIndex + 1 } : w
  );

  const newWidget = {
    colStart:  1,
    colSpan:   12,
    rowSpan:   3,
    style:     {},
    ...widgetDef,
    id:        widgetDef.id || `w${Date.now()}`,
    flowIndex: insertAt,
  };

  return {
    ...doc,
    widgets: [...shifted, newWidget],
    meta: { ...doc.meta, updatedAt: new Date().toISOString() },
  };
}

// ─── SERIALIZATION ───────────────────────────────────────────

/**
 * Serializes a document to the .gdoc plain-text format.
 * The output is human and AI readable.
 *
 * @param {object} doc
 * @returns {string} gdoc text
 */
export function serializeDocument(doc) {
  const { meta, canvas, widgets } = doc;
  const resolved = resolveFlow(widgets, canvas);
  const gridMap  = buildGridMap(resolved, canvas);

  const lines = [];

  // ── Header ──
  lines.push(`GDOC v${meta.version}`);
  lines.push(`title:     ${meta.title}`);
  lines.push(`author:    ${meta.author || '(none)'}`);
  lines.push(`createdAt: ${meta.createdAt}`);
  lines.push(`updatedAt: ${meta.updatedAt}`);
  lines.push('');

  // ── Canvas ──
  lines.push('CANVAS');
  lines.push(`  preset:  ${canvas.preset}`);
  lines.push(`  width:   ${canvas.width}`);
  lines.push(`  height:  ${canvas.height}`);
  lines.push(`  margin:  ${canvas.margin}`);
  lines.push('  GRID');
  lines.push(`    columns: ${canvas.grid.columns}`);
  lines.push(`    rows:    ${canvas.grid.rows}`);
  lines.push(`    gutterX: ${canvas.grid.gutterX}`);
  lines.push(`    gutterY: ${canvas.grid.gutterY}`);
  lines.push('  END GRID');
  lines.push('END CANVAS');
  lines.push('');

  // ── Grid Map ──
  lines.push('// GRID MAP (auto-generated, do not edit)');
  lines.push(...gridMap);
  lines.push('');

  // ── Widgets ──
  const sorted = [...widgets].sort((a, b) => a.flowIndex - b.flowIndex);
  for (const w of sorted) {
    lines.push(`WIDGET ${w.id}`);
    lines.push(`  type:      ${w.type}`);
    lines.push(`  flowIndex: ${w.flowIndex}`);
    lines.push(`  colStart:  ${w.colStart}`);
    lines.push(`  colSpan:   ${w.colSpan}`);
    lines.push(`  rowSpan:   ${w.rowSpan}`);
    if (w.group) lines.push(`  group:     ${w.group}`);

    // Type-specific fields
    switch (w.type) {
      case WIDGET_TYPES.TITLE:
      case WIDGET_TYPES.TEXTBOX:
        if (w.content !== undefined) {
          const multiline = String(w.content).includes('\n');
          if (multiline) {
            lines.push(`  content: |`);
            String(w.content).split('\n').forEach(l => lines.push(`    ${l}`));
          } else {
            lines.push(`  content:   "${w.content}"`);
          }
        }
        break;
      case WIDGET_TYPES.IMAGE:
        lines.push(`  src:       ${w.src || ''}`);
        lines.push(`  alt:       "${w.alt || ''}"`);
        lines.push(`  fit:       ${w.fit || 'cover'}`);
        break;
      case WIDGET_TYPES.TABLE:
        if (w.headers) lines.push(`  headers:   ${JSON.stringify(w.headers)}`);
        if (w.rows) {
          lines.push(`  rows:`);
          w.rows.forEach(r => lines.push(`    - ${JSON.stringify(r)}`));
        }
        break;
      case WIDGET_TYPES.CHART:
        lines.push(`  chartType: ${w.chartType || 'bar'}`);
        if (w.labels) lines.push(`  labels:    ${JSON.stringify(w.labels)}`);
        if (w.data)   lines.push(`  data:      ${JSON.stringify(w.data)}`);
        if (w.title)  lines.push(`  title:     "${w.title}"`);
        break;
      case WIDGET_TYPES.DIVIDER:
        lines.push(`  thickness: ${w.thickness || 1}`);
        lines.push(`  color:     ${w.color || '#e0e0e0'}`);
        break;
      case WIDGET_TYPES.SPACER:
        // rowSpan already encodes the space
        break;
    }

    // Style block
    if (w.style && Object.keys(w.style).length > 0) {
      lines.push(`  style:`);
      for (const [k, v] of Object.entries(w.style)) {
        lines.push(`    ${k}: ${v}`);
      }
    }

    lines.push(`END ${w.id}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parses a .gdoc text string back into a document object.
 *
 * @param {string} text
 * @returns {object} document
 */
export function parseDocument(text) {
  const lines = text.split('\n');
  const doc   = { meta: {}, canvas: { ...DEFAULT_CANVAS, grid: { ...DEFAULT_CANVAS.grid } }, widgets: [] };

  let i = 0;

  const peek  = () => lines[i]?.trim();
  const next  = () => lines[i++]?.trim();
  const skip  = () => { while (i < lines.length && peek() === '') i++; };

  // Header
  const header = next(); // GDOC v1.0
  doc.meta.version = header.split('v')[1] || '1.0';

  while (i < lines.length && !peek().startsWith('CANVAS')) {
    const line = next();
    if (!line || line.startsWith('//')) continue;
    const [key, ...rest] = line.split(':');
    const val = rest.join(':').trim();
    if (key === 'title')     doc.meta.title     = val;
    if (key === 'author')    doc.meta.author    = val;
    if (key === 'createdAt') doc.meta.createdAt = val;
    if (key === 'updatedAt') doc.meta.updatedAt = val;
  }

  // Canvas block
  if (peek() === 'CANVAS') {
    next(); // consume CANVAS
    while (!peek().startsWith('END CANVAS')) {
      const line = next();
      if (!line || line.startsWith('//')) continue;
      if (line === 'GRID') {
        while (!peek().startsWith('END GRID')) {
          const gl = next();
          if (!gl) continue;
          const [k, v] = gl.split(':').map(s => s.trim());
          if (k === 'columns') doc.canvas.grid.columns = Number(v);
          if (k === 'rows')    doc.canvas.grid.rows    = Number(v);
          if (k === 'gutterX') doc.canvas.grid.gutterX = Number(v);
          if (k === 'gutterY') doc.canvas.grid.gutterY = Number(v);
        }
        next(); // END GRID
        continue;
      }
      const [k, v] = line.split(':').map(s => s.trim());
      if (k === 'preset') doc.canvas.preset  = v;
      if (k === 'width')  doc.canvas.width   = Number(v);
      if (k === 'height') doc.canvas.height  = Number(v);
      if (k === 'margin') doc.canvas.margin  = Number(v);
    }
    next(); // END CANVAS
  }

  // Skip grid map comments and blank lines
  while (i < lines.length && (peek() === '' || peek().startsWith('//'))) i++;

  // Widgets
  while (i < lines.length) {
    const line = peek();
    if (!line || line.startsWith('//')) { i++; continue; }

    if (line.startsWith('WIDGET ')) {
      const id     = line.split(' ')[1];
      next(); // consume WIDGET line
      const widget = { id, style: {} };
      let inStyle   = false;
      let inRows    = false;
      let inContent = false;
      let contentLines = [];

      while (!peek()?.startsWith(`END ${id}`)) {
        const wl = lines[i++];
        if (wl === undefined) break;
        const trimmed = wl.trim();
        if (!trimmed) continue;

        // Multiline content
        if (inContent) {
          if (trimmed.startsWith('style:') || trimmed.startsWith('END')) {
            widget.content = contentLines.join('\n');
            inContent = false;
            contentLines = [];
            // re-process this line
            i--;
            continue;
          }
          contentLines.push(wl.replace(/^    /, ''));
          continue;
        }

        // Table rows
        if (inRows) {
          if (trimmed.startsWith('-')) {
            try { widget.rows.push(JSON.parse(trimmed.slice(1).trim())); } catch {}
            continue;
          } else {
            inRows = false;
          }
        }

        // Style block
        if (inStyle) {
          if (!trimmed.match(/^\w/) || trimmed.startsWith('END')) { inStyle = false; i--; continue; }
          const [sk, sv] = trimmed.split(':').map(s => s.trim());
          widget.style[sk] = sv;
          continue;
        }

        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;
        const k = trimmed.slice(0, colonIdx).trim();
        const v = trimmed.slice(colonIdx + 1).trim();

        if (k === 'style')     { inStyle = true; continue; }
        if (k === 'rows')      { widget.rows = []; inRows = true; continue; }
        if (k === 'content' && v === '|') { inContent = true; contentLines = []; continue; }

        if (k === 'type')      widget.type      = v;
        if (k === 'flowIndex') widget.flowIndex = Number(v);
        if (k === 'colStart')  widget.colStart  = Number(v);
        if (k === 'colSpan')   widget.colSpan   = Number(v);
        if (k === 'rowSpan')   widget.rowSpan   = Number(v);
        if (k === 'group')     widget.group     = v;
        if (k === 'content')   widget.content   = v.replace(/^"|"$/g, '');
        if (k === 'src')       widget.src       = v;
        if (k === 'alt')       widget.alt       = v.replace(/^"|"$/g, '');
        if (k === 'fit')       widget.fit       = v;
        if (k === 'headers')   { try { widget.headers = JSON.parse(v); } catch {} }
        if (k === 'chartType') widget.chartType = v;
        if (k === 'labels')    { try { widget.labels = JSON.parse(v); } catch {} }
        if (k === 'data')      { try { widget.data   = JSON.parse(v); } catch {} }
        if (k === 'title')     widget.title     = v.replace(/^"|"$/g, '');
        if (k === 'thickness') widget.thickness = Number(v);
        if (k === 'color')     widget.color     = v;
      }

      next(); // END widget
      doc.widgets.push(widget);
    } else {
      i++;
    }
  }

  return doc;
}

// ─── RENDER ──────────────────────────────────────────────────

/**
 * Resolves all widgets to their final renderable state:
 * grid coords → pixel positions, grouped by page.
 *
 * @param {object} doc
 * @returns {{ pages: Array<{ pageNumber, widgets: Array }>, metrics }}
 */
export function renderDocument(doc) {
  const metrics  = computeGridMetrics(doc.canvas);
  const resolved = resolveFlow(doc.widgets, doc.canvas);

  // Group by page
  const pageMap = {};
  for (const widget of resolved) {
    if (!pageMap[widget.page]) pageMap[widget.page] = [];
    const px = gridToPixels(widget, metrics);
    pageMap[widget.page].push({ ...widget, px });
  }

  const pages = Object.keys(pageMap)
    .map(Number)
    .sort((a, b) => a - b)
    .map(pageNumber => ({ pageNumber, widgets: pageMap[pageNumber] }));

  return { pages, metrics, canvas: doc.canvas };
}

// ─── GRID MAP BUILDER ────────────────────────────────────────

/**
 * Generates an ASCII grid map for human/AI readability.
 * This is embedded in the serialized file as a comment.
 *
 * @param {object[]} resolvedWidgets
 * @param {object}   canvas
 * @returns {string[]} lines
 */
function buildGridMap(resolvedWidgets, canvas) {
  const { grid, width, height, margin } = canvas;
  const lines = [];
  lines.push(`// CANVAS: ${canvas.preset} | ${width}×${height}px | ${grid.columns}col × ${grid.rows}row | margin:${margin} gutter:${grid.gutterX}`);

  // Group by page
  const byPage = {};
  for (const w of resolvedWidgets) {
    if (!byPage[w.page]) byPage[w.page] = [];
    byPage[w.page].push(w);
  }

  for (const [page, widgets] of Object.entries(byPage)) {
    lines.push(`// PAGE ${page}`);
    // Build a row-by-row summary
    const rowMap = {};
    for (const w of widgets) {
      for (let r = w.row; r < w.row + w.rowSpan; r++) {
        if (!rowMap[r]) rowMap[r] = [];
        rowMap[r].push(w);
      }
    }
    const maxRow = Math.max(...widgets.map(w => w.row + w.rowSpan - 1));
    for (let r = 1; r <= maxRow; r++) {
      const occupants = [...new Set(rowMap[r] || [])];
      const label = occupants.map(w =>
        `[${w.type.toUpperCase()}:${w.id} col${w.colStart}-${w.colStart + w.colSpan - 1}]`
      ).join(' ');
      lines.push(`// r${String(r).padStart(2, '0')}  ${label || '(empty)'}`);
    }
  }

  return lines;
}

// ─── HELPERS ─────────────────────────────────────────────────

/**
 * Re-indexes widget flowIndex values to be contiguous integers starting from 1.
 * Called after removal to keep the flow clean.
 */
function reindexFlow(widgets) {
  const sorted = [...widgets].sort((a, b) => a.flowIndex - b.flowIndex);
  let counter  = 1;
  let prev     = null;
  return sorted.map(w => {
    if (prev !== null && w.flowIndex !== prev) counter++;
    prev = w.flowIndex;
    return { ...w, flowIndex: counter };
  });
}

/**
 * Returns a plain summary of the document suitable for passing to an LLM.
 * Tells the LLM exactly what widgets exist and where they are in the flow.
 *
 * @param {object} doc
 * @returns {string}
 */
export function documentSummaryForLLM(doc) {
  const resolved = resolveFlow(doc.widgets, doc.canvas);
  const lines    = [];

  lines.push(`Document: "${doc.meta.title}"`);
  lines.push(`Canvas: ${doc.canvas.preset} (${doc.canvas.width}×${doc.canvas.height}px), ${doc.canvas.grid.columns} columns, ${doc.canvas.grid.rows} rows per page`);
  lines.push('');
  lines.push('Widgets in flow order:');

  for (const w of resolved) {
    lines.push(
      `  [${w.id}] flowIndex:${w.flowIndex} type:${w.type} ` +
      `page:${w.page} row:${w.row} ` +
      `col:${w.colStart} colSpan:${w.colSpan} rowSpan:${w.rowSpan}` +
      (w.content ? ` content:"${String(w.content).slice(0, 60)}${w.content.length > 60 ? '...' : ''}"` : '') +
      (w.src     ? ` src:${w.src}` : '')
    );
  }

  lines.push('');
  lines.push('To move a widget down: increment its flowIndex and decrement the widget below.');
  lines.push('To resize a widget: change its rowSpan or colSpan.');
  lines.push('To insert between widgets: shift flowIndex values of subsequent widgets up by 1.');

  return lines.join('\n');
}
