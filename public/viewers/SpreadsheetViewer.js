'use strict';
/* ═══════════════════════════════════════════════════════════════
   SpreadsheetViewer.js — CSV / XLSX / XLS table viewer
   Registers as window.Viewers.xlsx
   ═══════════════════════════════════════════════════════════════ */

(function () {

let _shell = null;

var st = {
  centerEl:    null,
  rows:        [],
  selectedR:   -1,
  selectedC:   -1,
  formulaBar:  true,
  fileName:    '',
  filePath:    '',
};

// ── Mount ──────────────────────────────────────────────────────
function mount(centerEl, file, shell) {
  _shell = shell;
  st.centerEl = centerEl;
  st.rows = []; st.selectedR = -1; st.selectedC = -1;
  st.formulaBar = true;
  st.fileName = file.name || '';
  st.filePath = file.path || '';

  centerEl.innerHTML = '<div style="padding:24px;color:var(--text-muted);">Loading spreadsheet\u2026</div>';

  setupToolbar();
  setupSidebar();

  var url = '/api/files/read?path=' + encodeURIComponent(st.filePath);
  fetch(url).then(function (r) { return r.json(); }).then(function (data) {
    var csv = data.content || '';
    st.rows = parseCSV(csv);
    renderTable();
    updateSidebar();
    var cols = st.rows.length > 0 ? st.rows[0] : [];
    _shell.setContext({
      label: st.fileName,
      text: 'Spreadsheet: ' + st.fileName + ', ' + st.rows.length + ' rows, ' + cols.length + ' cols. Columns: ' + cols.join(', '),
    });
  }).catch(function (err) {
    centerEl.innerHTML = '<div style="padding:24px;color:#f66;">Failed to load file: ' + _shell.escHtml(err.message) + '</div>';
  });
}

function cleanup() {
  st.centerEl = null; st.rows = []; st.selectedR = -1; st.selectedC = -1;
}

// ── CSV Parser ─────────────────────────────────────────────────
function parseCSV(text) {
  var rows = []; var row = []; var cell = ''; var inQuote = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { cell += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
      else if (ch === '\r') { /* skip */ }
      else { cell += ch; }
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  // Normalize column count
  var maxCols = 0;
  for (var r = 0; r < rows.length; r++) { if (rows[r].length > maxCols) maxCols = rows[r].length; }
  for (var r2 = 0; r2 < rows.length; r2++) {
    while (rows[r2].length < maxCols) rows[r2].push('');
  }
  return rows;
}

// ── Table Rendering ────────────────────────────────────────────
function renderTable() {
  if (!st.centerEl) return;
  st.centerEl.innerHTML = '';
  st.centerEl.style.cssText = 'overflow:auto;position:relative;display:flex;flex-direction:column;width:100%;height:100%;background:var(--bg);';

  // Formula bar
  var fb = document.createElement('div');
  fb.id = 'sv-formula-bar';
  fb.style.cssText = 'display:' + (st.formulaBar ? 'flex' : 'none') + ';align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid var(--border);background:var(--surface);min-height:30px;flex-shrink:0;';
  var cellLabel = document.createElement('span');
  cellLabel.id = 'sv-cell-label';
  cellLabel.style.cssText = 'font-size:11px;color:var(--text-muted);min-width:36px;';
  cellLabel.textContent = '--';
  var fInput = document.createElement('input');
  fInput.id = 'sv-formula-input';
  fInput.type = 'text';
  fInput.style.cssText = 'flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-size:12px;padding:2px 6px;border-radius:3px;outline:none;';
  fInput.addEventListener('change', function () {
    if (st.selectedR >= 0 && st.selectedC >= 0) {
      st.rows[st.selectedR][st.selectedC] = fInput.value;
      var td = getCell(st.selectedR, st.selectedC);
      if (td) td.textContent = fInput.value;
      updateSidebar();
    }
  });
  fb.appendChild(cellLabel);
  fb.appendChild(fInput);
  st.centerEl.appendChild(fb);

  // Table wrapper
  var tw = document.createElement('div');
  tw.style.cssText = 'flex:1;overflow:auto;';

  var table = document.createElement('table');
  table.id = 'sv-table';
  table.style.cssText = 'border-collapse:separate;border-spacing:0;font-size:12px;color:var(--text);min-width:100%;';

  for (var r = 0; r < st.rows.length; r++) {
    var tr = document.createElement('tr');
    // Row number column
    var rn = document.createElement(r === 0 ? 'th' : 'td');
    rn.textContent = r === 0 ? '' : r;
    rn.style.cssText = 'position:sticky;left:0;z-index:2;min-width:40px;text-align:center;padding:4px 6px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);background:rgba(255,255,255,0.06);color:var(--text-muted);font-size:10px;';
    if (r === 0) rn.style.cssText += 'position:sticky;top:0;z-index:3;';
    tr.appendChild(rn);

    for (var c = 0; c < st.rows[r].length; c++) {
      var isHeader = r === 0;
      var td = document.createElement(isHeader ? 'th' : 'td');
      td.textContent = st.rows[r][c];
      td.dataset.r = r;
      td.dataset.c = c;
      td.style.cssText = 'padding:4px 8px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis;cursor:cell;';
      if (isHeader) {
        td.style.cssText += 'position:sticky;top:0;z-index:1;background:rgba(255,255,255,0.06);font-weight:600;';
      }
      td.addEventListener('click', cellClick);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  tw.appendChild(table);
  st.centerEl.appendChild(tw);
}

function cellClick(e) {
  var td = e.currentTarget;
  var r = parseInt(td.dataset.r, 10);
  var c = parseInt(td.dataset.c, 10);
  selectCell(r, c);
}

function selectCell(r, c) {
  // Clear previous
  var prev = getCell(st.selectedR, st.selectedC);
  if (prev) prev.style.border = '';

  st.selectedR = r; st.selectedC = c;
  var td = getCell(r, c);
  if (td) {
    td.style.border = '2px solid var(--accent)';
    td.style.borderRight = '2px solid var(--accent)';
    td.style.borderBottom = '2px solid var(--accent)';
  }
  // Update formula bar
  var label = document.getElementById('sv-cell-label');
  var input = document.getElementById('sv-formula-input');
  if (label) label.textContent = colLetter(c) + (r + 1);
  if (input) input.value = (st.rows[r] && st.rows[r][c] != null) ? st.rows[r][c] : '';
}

function getCell(r, c) {
  if (r < 0 || c < 0) return null;
  var table = document.getElementById('sv-table');
  if (!table) return null;
  var row = table.rows[r];
  if (!row) return null;
  return row.cells[c + 1] || null; // +1 for row-number column
}

function colLetter(c) {
  var s = '';
  c++;
  while (c > 0) { c--; s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26); }
  return s;
}

// ── Toolbar ────────────────────────────────────────────────────
function setupToolbar() {
  _shell.setToolbarTabs([
    { name: 'Data', id: 'data', onActivate: function () { showBand(); } },
  ]);
  showBand();
}

function showBand() {
  var el = document.createElement('div');
  el.className = 'pvr-group';
  el.style.cssText = 'display:flex;align-items:center;gap:6px;';
  el.innerHTML =
    '<button id="sv-toggle-fb" title="Toggle formula bar">Formula Bar</button>' +
    '<div class="pvr-sep" style="width:1px;height:18px;background:var(--border);margin:0 6px;"></div>' +
    '<button id="sv-add-row" title="Add row">Add Row</button>' +
    '<button id="sv-add-col" title="Add column">Add Col</button>' +
    '<div class="pvr-sep" style="width:1px;height:18px;background:var(--border);margin:0 6px;"></div>' +
    '<button id="sv-export" title="Export as CSV">Export CSV</button>';
  _shell.setToolbarBandEl(el);
  el.querySelector('#sv-toggle-fb').addEventListener('click', toggleFormulaBar);
  el.querySelector('#sv-add-row').addEventListener('click', addRow);
  el.querySelector('#sv-add-col').addEventListener('click', addCol);
  el.querySelector('#sv-export').addEventListener('click', exportCSV);
}

function toggleFormulaBar() {
  st.formulaBar = !st.formulaBar;
  var fb = document.getElementById('sv-formula-bar');
  if (fb) fb.style.display = st.formulaBar ? 'flex' : 'none';
}

function addRow() {
  var cols = st.rows.length > 0 ? st.rows[0].length : 1;
  var row = [];
  for (var i = 0; i < cols; i++) row.push('');
  st.rows.push(row);
  renderTable();
  updateSidebar();
}

function addCol() {
  for (var r = 0; r < st.rows.length; r++) st.rows[r].push('');
  renderTable();
  updateSidebar();
}

function exportCSV() {
  var lines = st.rows.map(function (row) {
    return row.map(function (cell) {
      if (cell.indexOf(',') !== -1 || cell.indexOf('"') !== -1 || cell.indexOf('\n') !== -1) {
        return '"' + cell.replace(/"/g, '""') + '"';
      }
      return cell;
    }).join(',');
  });
  var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = st.fileName.replace(/\.[^.]+$/, '') + '_export.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ── Sidebar ────────────────────────────────────────────────────
function setupSidebar() {
  var sb = document.createElement('div');
  sb.id = 'sv-sidebar';
  sb.style.cssText = 'font-size:11px;padding:12px;display:flex;flex-direction:column;gap:8px;';
  sb.innerHTML = '<div style="color:var(--text-muted);margin-bottom:4px;font-weight:600;">Sheet Info</div>' +
    '<div id="sv-meta"></div>' +
    '<div style="color:var(--text-muted);margin-top:8px;margin-bottom:4px;font-weight:600;">Columns</div>' +
    '<div id="sv-cols"></div>';
  _shell.setSidebarContent(sb);
}

function updateSidebar() {
  var meta = document.getElementById('sv-meta');
  var colsEl = document.getElementById('sv-cols');
  if (!meta) return;
  var rowCount = st.rows.length;
  var colCount = rowCount > 0 ? st.rows[0].length : 0;
  var cellCount = rowCount * colCount;
  var pairs = [
    ['Filename', st.fileName],
    ['Rows', String(rowCount)],
    ['Columns', String(colCount)],
    ['Cells', String(cellCount)],
  ];
  meta.innerHTML = pairs.map(function (p) {
    return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);">' +
      '<span style="color:var(--text-muted);">' + p[0] + '</span>' +
      '<span style="color:var(--text);">' + _shell.escHtml(p[1]) + '</span></div>';
  }).join('');

  if (colsEl && rowCount > 0) {
    colsEl.innerHTML = st.rows[0].map(function (name, i) {
      return '<div style="display:flex;justify-content:space-between;padding:2px 0;">' +
        '<span style="color:var(--text-muted);">' + colLetter(i) + '</span>' +
        '<span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;max-width:120px;white-space:nowrap;">' + _shell.escHtml(name || '(empty)') + '</span></div>';
    }).join('');
  }
}

// ── Register ───────────────────────────────────────────────────
window.Viewers = window.Viewers || {};
window.Viewers.xlsx = { mount: mount, cleanup: cleanup };

})();
