'use strict';
/* ═══════════════════════════════════════════════════════════════
   gdoc-widgets.js — Widget type renderers + LLM command card

   Each widget type has a render() function that returns a DOM
   element for the widget's inner content.

   This file is also the single source of truth for what widget
   types exist. The LLM reads COMMAND_CARD to know how to drive
   the document.
   ═══════════════════════════════════════════════════════════════ */

(function () {

// ─── LLM COMMAND CARD ────────────────────────────────────────
// Kept here next to the widget definitions so they never drift.

const COMMAND_CARD = `\
COMMANDS (emit as <doc_op> XML tags):

  WRITE into a widget:
    <doc_op type="update" id="ID">new content</doc_op>

  ADD a new widget at the end:
    <doc_op type="add" kind="textbox" rowSpan="4">content</doc_op>
    <doc_op type="add" kind="title" rowSpan="2">heading</doc_op>
    <doc_op type="add" kind="table" rowSpan="5" headers='["A","B"]' rows='[["1","2"]]'></doc_op>
    <doc_op type="add" kind="image" rowSpan="6" src="url"></doc_op>
    <doc_op type="add" kind="divider" rowSpan="1"></doc_op>

  RESIZE / REPOSITION:
    <doc_op type="update" id="ID" rowSpan="8"></doc_op>
    <doc_op type="update" id="ID" colSpan="6" colStart="1"></doc_op>

  REORDER:
    <doc_op type="move" id="ID" dir="1"></doc_op>   (1=down, -1=up)

  DELETE:
    <doc_op type="remove" id="ID"></doc_op>

WIDGET TYPES: title, textbox, image, table, divider, spacer
GRID: 12 columns, 24 rows per page. colStart 1-12, colSpan 1-12.
Side-by-side widgets share the same flowIndex.
Always emit <doc_op> tags — never just describe edits.

CONTENT RULES — READ CAREFULLY:
  Widget content is PLAIN TEXT. Not markdown. Not HTML.
  NEVER use: ** (bold), * (bullets), # (headings), \\ (backslashes), _ (underline)
  NEVER use markdown lists like "* item" or "- item"
  NEVER put headings inside textbox content — use a title widget instead.
  NEVER cram multiple sections into one textbox.

  For bullet points, use a line per point with a dash or unicode bullet:
    WRONG:  * **Respiratory System:** Highly efficient...
    RIGHT:  Respiratory System — Highly efficient...

  For lists, use one textbox per logical group (3-5 items max):
    WRONG:  One giant textbox with 20 lines and \\ between them
    RIGHT:  Separate textboxes for each topic, sized by content

  Each textbox should hold ONE idea or ONE short paragraph (2-5 sentences).
  If you need to cover a sub-topic, make it its own textbox widget.
  Headings are ALWAYS title widgets, never bold text in a textbox.

SPACING:
  The engine inserts 1 row of automatic gap between every widget.
  You do NOT need spacer widgets for normal paragraph spacing — it's built in.
  Example: a title (rowSpan 2) followed by a textbox (rowSpan 4) uses 2+1+4 = 7 rows.

  When to use explicit spacing:
    spacer rowSpan=1  — small extra breathing room (e.g. before a new section)
    spacer rowSpan=2  — medium break between major topics
    spacer rowSpan=3+ — large visual gap, rare
    divider rowSpan=1 — horizontal line, use for topic changes or header/body separation

  When NOT to add spacing:
    Between a title and its body textbox — the auto-gap is enough
    Between consecutive paragraphs — auto-gap handles it
    Before the first widget on a page — margin already handles it

SIZING GUIDE:
  rowSpan 1   — one-liner, metadata, divider, or small spacer
  rowSpan 2   — heading, short subtitle, or small breathing gap
  rowSpan 3   — short paragraph (1-3 sentences)
  rowSpan 4-5 — medium paragraph (3-6 sentences)
  rowSpan 6-8 — long paragraph or small table (3-5 rows)
  rowSpan 9-12— full section body or large table
  rowSpan 13+ — very long content; will push later widgets to next page

  Title widgets: almost always rowSpan=2. Only use rowSpan=3 for very prominent headings.
  Tables: rowSpan = header row + data rows + 2 (for padding).

PAGE PLANNING:
  24 rows per page. With auto-gaps, a typical page fits:
    title(2) + gap(1) + body(6) + gap(1) + title(2) + gap(1) + body(6) + gap(1) + table(4) = 24 rows
  Budget ~20 usable rows per page (gaps eat the rest).
  If a widget won't fit on the current page, it flows to the next page automatically.

LAYOUT RECIPES:

  Report front page:
    title   rowSpan=2  — "Annual Report"
    textbox rowSpan=1  — "Author • Date • Department"
    divider rowSpan=1
    textbox rowSpan=5  — executive summary (one paragraph, 3-5 sentences)
    title   rowSpan=2  — "Key Metrics"
    table   rowSpan=5  — data table
    (total with gaps: 2+1+1+1+1+1+5+1+2+1+5 = 21 rows — fits one page)

  Topic with sub-points (e.g. "Anatomy"):
    title   rowSpan=2  — "Anatomy and Physiology"
    textbox rowSpan=3  — intro paragraph (2-3 sentences)
    textbox rowSpan=2  — "Respiratory System — Highly efficient, with air sacs..."
    textbox rowSpan=2  — "Digestive System — Adapted for a variety of foods..."
    textbox rowSpan=2  — "Circulatory System — Four-chambered heart ensures..."
    (each sub-point is its own small textbox — NOT one big blob)

  Two-column layout (same flowIndex):
    textbox flowIndex=N colStart=1 colSpan=6  rowSpan=6
    image   flowIndex=N colStart=7 colSpan=6  rowSpan=6

  Section break:
    divider rowSpan=1
    (just a divider — the auto-gaps before and after give enough breathing room)`;

// ─── WIDGET REGISTRY ─────────────────────────────────────────
// Each entry: { render(w, hooks) → HTMLElement }
// hooks = { wireText, wireTable, esc, selectWidget }

const WIDGETS = {};

// ── title ────────────────────────────────────────────────────
WIDGETS.title = {
  defaults: { colSpan: 12, rowSpan: 2, content: 'Untitled' },
  render(w, h) {
    const el = document.createElement('div');
    el.className = 'gd-title-text';
    el.contentEditable = 'true';
    el.spellcheck = true;
    el.textContent = w.content || '';
    el.dataset.placeholder = 'Type a heading\u2026';
    h.wireText(el, w);
    return el;
  },
};

// ── textbox ──────────────────────────────────────────────────
WIDGETS.textbox = {
  defaults: { colSpan: 12, rowSpan: 4, content: '' },
  render(w, h) {
    const el = document.createElement('div');
    el.className = 'gd-text-content';
    el.contentEditable = 'true';
    el.spellcheck = true;
    el.innerText = w.content || '';
    el.dataset.placeholder = 'Start typing\u2026';
    h.wireText(el, w);
    return el;
  },
};

// ── image ────────────────────────────────────────────────────
WIDGETS.image = {
  defaults: { colSpan: 12, rowSpan: 6, src: '', alt: '', fit: 'cover' },
  render(w, h) {
    if (w.src) {
      const img = document.createElement('img');
      img.className = 'gd-img';
      img.src = w.src;
      img.alt = w.alt || '';
      img.style.objectFit = w.fit || 'cover';
      img.draggable = false;
      return img;
    }
    const ph = document.createElement('div');
    ph.className = 'gd-img-placeholder';
    ph.textContent = 'Click to add image';
    return ph;
  },
};

// ── table ────────────────────────────────────────────────────
WIDGETS.table = {
  defaults: { colSpan: 12, rowSpan: 5, headers: ['Col A', 'Col B', 'Col C'], rows: [['','',''],['','','']] },
  render(w, h) {
    const table = document.createElement('table');
    table.className = 'gd-table';

    function editable(cell) {
      cell.contentEditable = 'true';
      cell.addEventListener('click', e => e.stopPropagation());
      cell.addEventListener('keydown', e => e.stopPropagation());
      cell.addEventListener('blur', () => h.wireTable(w));
      cell.addEventListener('input', () => {
        if (w._ct) clearTimeout(w._ct);
        w._ct = setTimeout(() => h.wireTable(w), 800);
      });
    }

    if (w.headers && w.headers.length) {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      w.headers.forEach((txt, i) => {
        const th = document.createElement('th');
        th.textContent = txt;
        th.dataset.col = i;
        editable(th);
        tr.appendChild(th);
      });
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    if (w.rows && w.rows.length) {
      const tbody = document.createElement('tbody');
      w.rows.forEach((row, ri) => {
        const tr = document.createElement('tr');
        row.forEach((txt, ci) => {
          const td = document.createElement('td');
          td.textContent = txt;
          td.dataset.row = ri;
          td.dataset.col = ci;
          editable(td);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
    }

    return table;
  },
};

// ── chart (placeholder) ──────────────────────────────────────
WIDGETS.chart = {
  defaults: { colSpan: 12, rowSpan: 6, chartType: 'bar' },
  render(w) {
    const el = document.createElement('div');
    el.className = 'gd-chart-placeholder';
    el.textContent = '[Chart: ' + (w.chartType || 'bar') + ']';
    return el;
  },
};

// ── divider ──────────────────────────────────────────────────
WIDGETS.divider = {
  defaults: { colSpan: 12, rowSpan: 1, thickness: 1, color: '#e0e0e0' },
  render(w) {
    const hr = document.createElement('hr');
    hr.className = 'gd-divider';
    hr.style.borderWidth = (w.thickness || 1) + 'px';
    hr.style.borderColor = w.color || '#e0e0e0';
    return hr;
  },
};

// ── spacer ───────────────────────────────────────────────────
WIDGETS.spacer = {
  defaults: { colSpan: 12, rowSpan: 2 },
  render() { return null; }, // empty on purpose
};

// ─── EXPORTS ─────────────────────────────────────────────────

window.GDocWidgets = {
  WIDGETS,
  COMMAND_CARD,
  getDefaults(type) {
    return WIDGETS[type] ? { type, ...WIDGETS[type].defaults } : { type: 'textbox', ...WIDGETS.textbox.defaults };
  },
};

})();
