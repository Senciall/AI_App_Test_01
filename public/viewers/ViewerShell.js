'use strict';
/* ═══════════════════════════════════════════════════════════════
   ViewerShell.js — Shared outer shell for all file viewers
   Handles: toolbar, left sidebar, agent panel, home screen,
            file sidebar, navigation, state management
   ═══════════════════════════════════════════════════════════════ */

(function () {

// ── State ───────────────────────────────────────────────────────
const pv = {
  screen:    'home',
  fileName:  '',
  filePath:  '',
  fileType:  '',
  messages:  [],
  streaming: false,
  context:   null,   // { label, text, extra? } set by active viewer
  viewer:    null,   // { cleanup() } from active viewer
};

// ── Lazy loader ─────────────────────────────────────────────────
const _loaded = {};
function loadScript(src) {
  if (_loaded[src]) return _loaded[src];
  _loaded[src] = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = fail;
    document.head.appendChild(s);
  });
  return _loaded[src];
}
function loadCSS(href) {
  if (_loaded[href]) return;
  _loaded[href] = true;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}

// ── Init ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initHome();
  initFileSidebar();
  initAgentInput();
  initModels();
  initKeyboard();
  initBackBtn();
  initUpload();

  // Drag-drop on center
  const center = document.getElementById('pv-center');
  if (center) {
    center.addEventListener('dragover', e => e.preventDefault());
    center.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) openFile(f); });
  }
});

// ══════════════════════════════════════════════════════════════════
//  SCREEN NAVIGATION
// ══════════════════════════════════════════════════════════════════

function showHome() {
  pv.screen = 'home';
  document.getElementById('pv-home').style.display = '';
  document.getElementById('pv-editor-screen').style.display = 'none';
  renderRecentGrid();
  loadFileTree();
  // Cleanup active viewer
  if (pv.viewer && pv.viewer.cleanup) { try { pv.viewer.cleanup(); } catch {} }
  pv.viewer = null;
  pv.context = null;
  window.__activeEditor = null;
  window.__activeEditorType = null;
}

function showEditor(name, type) {
  pv.screen   = 'editor';
  pv.fileName = name;
  pv.fileType = type;
  document.getElementById('pv-home').style.display = 'none';
  document.getElementById('pv-editor-screen').style.display = '';

  // Top toolbar info
  document.getElementById('pv-doc-name-display').textContent = name;
  const badge = document.getElementById('pv-file-badge');
  badge.textContent = type.toUpperCase();
  badge.className = 'pv-file-badge pvh-badge-' + badgeClass(type);

  // Clear viewer-specific areas
  document.getElementById('pvr-tabs').innerHTML = '';
  document.getElementById('pvr-band').innerHTML = '';
  document.getElementById('pv-sidebar').innerHTML = '';
  document.getElementById('pv-center').innerHTML = '';
  document.getElementById('pv-sidebar').style.display = '';

  // Proactive agent message
  sendProactiveMessage(name, type);
}

function initBackBtn() {
  document.getElementById('pv-back-home').addEventListener('click', showHome);
}

// ══════════════════════════════════════════════════════════════════
//  HOME SCREEN
// ══════════════════════════════════════════════════════════════════

async function initHome() {
  const settings = await fetch('/api/settings').then(r => r.json()).catch(() => ({}));
  const name = settings.userName || 'there';
  const h = new Date().getHours();
  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('pvh-greeting').textContent = `${greeting}, ${name}`;

  document.querySelectorAll('.pvh-tpl').forEach(tpl => {
    tpl.addEventListener('click', () => createFromTemplate(tpl.dataset.type, tpl.dataset.template));
  });
  renderRecentGrid();
}

// ── Create from template ──────────────────────────────────────────
function createFromTemplate(type, template) {
  if (type === 'gdoc') {
    const tplNames = { blank: 'Untitled Document', report: 'Report', resume: 'Resume', notes: 'Meeting Notes' };
    const name = (tplNames[template] || 'Untitled Document') + '.gdoc';
    pv.fileName = name; pv.filePath = name; pv.fileType = 'gdoc';
    addRecent({ name, path: name, type: 'gdoc', openedAt: Date.now() });
    showEditor(name, 'gdoc');
    if (window.ViewerRouter) {
      window.ViewerRouter.route('gdoc', { name, path: name, type: 'gdoc', blank: true, template: template || 'blank' });
    }
  } else if (type === 'pdf') {
    const name = 'Untitled Document.pdf';
    pv.fileName = name; pv.filePath = name; pv.fileType = 'pdf';
    addRecent({ name, path: name, type: 'pdf', openedAt: Date.now() });
    showEditor(name, 'pdf');
    if (window.ViewerRouter) {
      window.ViewerRouter.route('pdf', { name, path: name, type: 'pdf', blank: true });
    }
  } else {
    // Other types: open file picker for now
    document.getElementById('pv-file-input').click();
  }
}

// ── Recent files (localStorage) ──────────────────────────────────
const RECENT_KEY = 'pvRecentFiles';

function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
  catch { return []; }
}

function addRecent(entry) {
  let list = getRecent().filter(r => r.path !== entry.path);
  list.unshift(entry);
  if (list.length > 12) list = list.slice(0, 12);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

function renderRecentGrid() {
  const grid = document.getElementById('pvh-recent-grid');
  const recent = getRecent();
  if (!recent.length) {
    grid.innerHTML = '<div class="pvh-empty-recent">No recent files yet — open or create one above</div>';
    return;
  }
  grid.innerHTML = '';
  recent.forEach((file, idx) => {
    const card = document.createElement('div');
    card.className = 'pvh-card';
    card.style.animationDelay = (idx * 30) + 'ms';
    const type = file.type || detectType(file.name);
    const bdg  = badgeClass(type);
    const ago  = timeAgo(file.openedAt);
    const preview = document.createElement('div');
    preview.className = 'pvh-card-preview';
    if (file.thumbnail) {
      const img = document.createElement('img');
      img.className = 'pvh-thumb-img'; img.src = file.thumbnail; img.draggable = false;
      preview.appendChild(img);
    } else if (type === 'pdf') {
      preview.innerHTML = '<div class="pvh-thumb-loading"></div>';
      generatePdfThumb(file.path, preview);
    } else if (type === 'img') {
      const img = document.createElement('img');
      img.className = 'pvh-thumb-img';
      img.src = '/api/files/serve?path=' + encodeURIComponent(file.path);
      img.onerror = () => { preview.innerHTML = '<span class="pvh-card-preview-icon">IMG</span>'; };
      preview.appendChild(img);
    } else if (type === 'xlsx') {
      preview.innerHTML = '<div class="pvh-thumb-loading"></div>';
      generateXlsxThumb(file.path, preview);
    } else if (type === 'code' || type === 'doc') {
      preview.innerHTML = '<div class="pvh-thumb-loading"></div>';
      generateTextThumb(file.path, preview);
    } else {
      preview.innerHTML = '<span class="pvh-card-preview-icon">' + typeIcon(type) + '</span>';
    }
    const info = document.createElement('div');
    info.className = 'pvh-card-info';
    info.innerHTML = `<div class="pvh-card-name">${escHtml(file.name)}</div>
      <div class="pvh-card-meta"><span class="pvh-card-badge pvh-badge-${bdg}">${type.toUpperCase()}</span>
      <span class="pvh-card-date">${ago}</span></div>`;
    const menuBtn = document.createElement('button');
    menuBtn.className = 'pvh-card-menu'; menuBtn.title = 'More'; menuBtn.innerHTML = '&#8942;';
    card.appendChild(preview); card.appendChild(info); card.appendChild(menuBtn);
    card.addEventListener('click', e => { if (!e.target.closest('.pvh-card-menu')) openPath(file.path, file.name); });
    menuBtn.addEventListener('click', e => { e.stopPropagation(); showCardMenu(menuBtn, file); });
    grid.appendChild(card);
  });
}

function showCardMenu(btn, file) {
  if (confirm(`Remove "${file.name}" from recent files?`)) {
    localStorage.setItem(RECENT_KEY, JSON.stringify(getRecent().filter(r => r.path !== file.path)));
    renderRecentGrid();
  }
}

// ── Thumbnail helpers ─────────────────────────────────────────────
async function generatePdfThumb(filePath, container) {
  try {
    await loadScript(typeof PDFJS_SRC !== 'undefined' ? PDFJS_SRC : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
    const pdfjs = window.pdfjsLib;
    if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = typeof PDFJS_WORKER !== 'undefined' ? PDFJS_WORKER : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    const url = '/api/files/serve?path=' + encodeURIComponent(filePath);
    const pdf = await pdfjs.getDocument(url).promise;
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 0.5 });
    const canvas = document.createElement('canvas');
    canvas.className = 'pvh-thumb-canvas'; canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    container.innerHTML = ''; container.appendChild(canvas);
    try { updateRecentThumbnail(filePath, canvas.toDataURL('image/jpeg', 0.55)); } catch {}
    pdf.destroy();
  } catch { container.innerHTML = '<span class="pvh-card-preview-icon">PDF</span>'; }
}
async function generateTextThumb(filePath, container) {
  try {
    const data = await fetch('/api/files/read?path=' + encodeURIComponent(filePath)).then(r => r.json());
    const text = (data.content || '').slice(0, 600);
    if (!text.trim()) throw 0;
    const pre = document.createElement('div');
    pre.className = 'pvh-card-preview-text'; pre.textContent = text;
    container.innerHTML = ''; container.appendChild(pre);
  } catch { container.innerHTML = '<span class="pvh-card-preview-icon">DOC</span>'; }
}
async function generateXlsxThumb(filePath, container) {
  try {
    const data = await fetch('/api/files/read?path=' + encodeURIComponent(filePath)).then(r => r.json());
    const lines = (data.content || '').split('\n').filter(l => l.trim()).slice(0, 8);
    if (!lines.length) throw 0;
    const grid = document.createElement('div'); grid.className = 'pvh-xlsx-grid';
    lines.forEach(line => {
      const row = document.createElement('div'); row.className = 'pvh-xlsx-row';
      line.split(',').slice(0, 5).forEach(cell => {
        const c = document.createElement('div'); c.className = 'pvh-xlsx-cell';
        c.textContent = cell.trim().slice(0, 20); row.appendChild(c);
      });
      grid.appendChild(row);
    });
    container.innerHTML = ''; container.appendChild(grid);
  } catch { container.innerHTML = '<span class="pvh-card-preview-icon">XLS</span>'; }
}
function updateRecentThumbnail(filePath, dataUrl) {
  try {
    let list = getRecent();
    const idx = list.findIndex(r => r.path === filePath);
    if (idx !== -1) { list[idx].thumbnail = dataUrl; localStorage.setItem(RECENT_KEY, JSON.stringify(list)); }
  } catch {}
}

// ══════════════════════════════════════════════════════════════════
//  FILE SIDEBAR
// ══════════════════════════════════════════════════════════════════

function initFileSidebar() {
  const sidebar = document.getElementById('pv-file-sidebar');
  const colBtn  = document.getElementById('pvfs-collapse-btn');
  const openBtn = document.getElementById('pvfs-open-btn');
  const search  = document.getElementById('pvfs-search');
  if (localStorage.getItem('pvfs-collapsed') === '1') {
    sidebar.classList.add('pvfs-collapsed'); openBtn.style.display = 'flex';
  }
  colBtn.addEventListener('click', () => { sidebar.classList.add('pvfs-collapsed'); openBtn.style.display = 'flex'; localStorage.setItem('pvfs-collapsed', '1'); });
  openBtn.addEventListener('click', () => { sidebar.classList.remove('pvfs-collapsed'); openBtn.style.display = 'none'; localStorage.setItem('pvfs-collapsed', '0'); });
  let t = null;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => filterTree(search.value.trim().toLowerCase()), 150); });
  loadFileTree();
}

async function loadFileTree() {
  const tree = document.getElementById('pvfs-tree');
  try {
    const files = await fetch('/api/files').then(r => r.json());
    tree.innerHTML = '';
    if (!files.length) { tree.innerHTML = '<div class="pvfs-empty">No files yet</div>'; return; }
    renderTreeLevel(files, tree, 0);
  } catch { tree.innerHTML = '<div class="pvfs-empty">Could not load files</div>'; }
}

function renderTreeLevel(items, container, depth) {
  items.sort((a, b) => a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name));
  items.forEach(item => {
    if (item.isDirectory) {
      const folder = document.createElement('div'); folder.className = 'pvfs-folder'; folder.dataset.name = item.name.toLowerCase();
      const row = document.createElement('div'); row.className = 'pvfs-item'; row.style.paddingLeft = (8 + depth * 12) + 'px';
      const arrow = document.createElement('span'); arrow.className = 'pvfs-folder-arrow'; arrow.textContent = '\u25B6';
      const icon = document.createElement('span'); icon.className = 'pvfs-item-icon'; icon.textContent = '\uD83D\uDCC1';
      const nm = document.createElement('span'); nm.className = 'pvfs-item-name'; nm.textContent = item.name;
      row.append(arrow, icon, nm); folder.appendChild(row);
      const children = document.createElement('div'); children.className = 'pvfs-children pvfs-hidden';
      if (item.children?.length) renderTreeLevel(item.children, children, depth + 1);
      folder.appendChild(children);
      row.addEventListener('click', () => {
        const open = !children.classList.contains('pvfs-hidden');
        children.classList.toggle('pvfs-hidden', !open ? false : true);
        arrow.classList.toggle('pvfs-open', !open);
      });
      container.appendChild(folder);
    } else {
      const row = document.createElement('div'); row.className = 'pvfs-item pvfs-file';
      row.style.paddingLeft = (8 + depth * 12) + 'px';
      row.dataset.name = item.name.toLowerCase(); row.dataset.path = item.path;
      const icon = document.createElement('span'); icon.className = 'pvfs-item-icon'; icon.textContent = fileTreeIcon(item.name);
      const nm = document.createElement('span'); nm.className = 'pvfs-item-name'; nm.textContent = item.name;
      row.append(icon, nm);
      row.addEventListener('click', () => openPath(item.path, item.name));
      container.appendChild(row);
    }
  });
}

function fileTreeIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return { pdf:'\uD83D\uDCC4', xlsx:'\uD83D\uDCCA', xls:'\uD83D\uDCCA', csv:'\uD83D\uDCCA',
    png:'\uD83D\uDDBC', jpg:'\uD83D\uDDBC', jpeg:'\uD83D\uDDBC',
    py:'\uD83D\uDC0D', js:'\u26A1', ts:'\u26A1', json:'{ }',
    md:'\uD83D\uDCDD', txt:'\uD83D\uDCDD', html:'\uD83C\uDF10', css:'\uD83C\uDFA8',
    mp3:'\uD83C\uDFB5', wav:'\uD83C\uDFB5', mp4:'\uD83C\uDFAC', webm:'\uD83C\uDFAC',
  }[ext] || '\uD83D\uDCC4';
}

function filterTree(q) {
  const tree = document.getElementById('pvfs-tree');
  if (!q) {
    tree.querySelectorAll('.pvfs-folder,.pvfs-file').forEach(el => el.style.display = '');
    tree.querySelectorAll('.pvfs-children').forEach(el => el.classList.add('pvfs-hidden'));
    tree.querySelectorAll('.pvfs-folder-arrow').forEach(el => el.classList.remove('pvfs-open'));
    return;
  }
  tree.querySelectorAll('.pvfs-file').forEach(el => {
    el.style.display = (el.dataset.name.includes(q) || (el.dataset.path || '').toLowerCase().includes(q)) ? '' : 'none';
  });
  tree.querySelectorAll('.pvfs-folder').forEach(folder => {
    const ch = folder.querySelector('.pvfs-children');
    const has = ch && ch.querySelector('.pvfs-file:not([style*="display: none"])');
    folder.style.display = has ? '' : 'none';
    if (has) { ch.classList.remove('pvfs-hidden'); const a = folder.querySelector('.pvfs-folder-arrow'); if (a) a.classList.add('pvfs-open'); }
  });
}

// ══════════════════════════════════════════════════════════════════
//  FILE OPEN + UPLOAD
// ══════════════════════════════════════════════════════════════════

function initUpload() {
  document.getElementById('pv-file-input').addEventListener('change', e => {
    const f = e.target.files[0]; if (f) openFile(f); e.target.value = '';
  });
}

async function openFile(file) {
  const type = detectType(file.name);
  pv.fileName = file.name; pv.filePath = file.name; pv.fileType = type;

  // Upload to temp_uploads so the file can be re-opened from recent files
  let serverPath = file.name;
  try {
    const fd = new FormData(); fd.append('file', file);
    const uploadRes = await fetch('/api/files/upload?target=temp', { method: 'POST', body: fd });
    const uploadData = await uploadRes.json();
    if (uploadData.path) serverPath = uploadData.path;
  } catch (err) { console.warn('[OpenFile] Temp upload failed:', err); }

  pv.filePath = serverPath;
  addRecent({ name: file.name, path: serverPath, type, openedAt: Date.now() });
  showEditor(file.name, type);
  // Route to correct viewer — use blob URL for immediate display
  if (window.ViewerRouter) {
    const routeData = { name: file.name, path: serverPath, type, url: URL.createObjectURL(file), file };
    // For .gdoc files, pass the text content directly
    if (type === 'gdoc') {
      try { routeData.gdocText = await file.text(); } catch {}
    }
    window.ViewerRouter.route(type, routeData);
  }
}

async function openPath(filePath, name) {
  const type = detectType(name);
  pv.fileName = name; pv.filePath = filePath; pv.fileType = type;
  addRecent({ name, path: filePath, type, openedAt: Date.now() });
  showEditor(name, type);
  if (window.ViewerRouter) {
    window.ViewerRouter.route(type, {
      name, path: filePath, type,
      url: '/api/files/serve?path=' + encodeURIComponent(filePath),
    });
  }
}

// ══════════════════════════════════════════════════════════════════
//  AGENT PANEL
// ══════════════════════════════════════════════════════════════════

function initAgentInput() {
  const inp = document.getElementById('pv-input');
  inp.addEventListener('input', autoResize);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  document.getElementById('pv-send').addEventListener('click', send);

  // ── Model selector dropdown ──
  const modelBtn = document.getElementById('pv-agent-model-btn');
  const dropdown = document.getElementById('pv-agent-model-dropdown');
  if (modelBtn && dropdown) {
    modelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => dropdown.classList.remove('open'));
  }

  // ── Quick action chips ──
  renderChips();
}

function renderChips() {
  const row = document.getElementById('pv-chip-row');
  if (!row) return;
  const chips = [
    { label: '+ Add section', cmd: 'Add a new section to this document with a heading and body text' },
    { label: '+ Introduction', cmd: 'Write an introduction section for this document' },
    { label: 'Improve writing', cmd: 'Improve the writing quality, clarity, and flow of this document' },
    { label: 'Fix grammar', cmd: 'Fix all grammar, spelling, and punctuation in this document' },
  ];
  row.innerHTML = '';
  chips.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'pv-chip';
    btn.textContent = c.label;
    btn.addEventListener('click', () => {
      document.getElementById('pv-input').value = c.cmd;
      send();
    });
    row.appendChild(btn);
  });
}

function autoResize() {
  const inp = document.getElementById('pv-input');
  inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
}

async function send() {
  if (pv.streaming) return;
  const inp = document.getElementById('pv-input');
  const text = inp.value.trim(); if (!text) return;
  const ctx = pv.context;
  const ctxLabel = ctx ? ctx.label : null;
  inp.value = ''; autoResize();
  pv.context = null;
  document.getElementById('pv-pill-row').innerHTML = '';
  pv.streaming = true;
  document.getElementById('pv-send').disabled = true;
  appendUser(text, ctxLabel);

  // Build document-aware system prompt
  const hasEditor = !!window.__activeEditor;
  let docContent = '';
  if (hasEditor) {
    try {
      const editor = window.__activeEditor;
      docContent = (typeof editor.getText === 'function' ? editor.getText() : (typeof editor.getHTML === 'function' ? editor.getHTML() : '')) || '';
    } catch {}
  }

  const editorType = window.__activeEditorType || '';
  const isPdf = editorType === 'pdf';
  const isGdoc = editorType === 'gdoc';

  let DOC_SYSTEM;
  if (isGdoc) {
    const cmdCard = (window.GDocWidgets && window.GDocWidgets.COMMAND_CARD) || '';
    DOC_SYSTEM = `You are a document editor for "${pv.fileName || 'unknown'}". You edit by emitting <doc_op> tags — never just describe changes.

${cmdCard}

The current document widgets (with IDs) are listed below. To write into an existing widget, use its id:
  <doc_op type="update" id="THE_ID">new content</doc_op>
For math use $...$ (inline) or $$...$$ (display).`;
  } else if (isPdf) {
    DOC_SYSTEM = `You are a PDF editing agent with direct write access to the user's PDF document titled "${pv.fileName || 'unknown'}".
You can read every text block extracted from the PDF. Each block has an ID, page number, text content, font size, and position.
When the user asks you to edit, rewrite, fix, improve, or change any text in the PDF, respond with <doc_op> tags to perform those edits directly on the document, followed by a brief plain-text confirmation.
Available doc_op types for PDF editing:
- <doc_op type="replace_text" old="original text">new replacement text</doc_op> — finds text in the PDF and replaces it
- <doc_op type="edit_block" id="block_id">new full block text</doc_op> — replaces an entire text block by its ID
- <doc_op type="rewrite_block" find="text to find">new rewritten text</doc_op> — finds a block containing the text and replaces it
When the user selects a text block and asks you about it, you can see the block content in the context. If they ask you to edit it, use the appropriate doc_op.
Never just describe what you would do — always emit the doc_op tags to actually perform the edit.
For any math, use $...$ (inline) or $$...$$ (display).`;
  } else if (hasEditor) {
    DOC_SYSTEM = `You are a document editing agent with direct write access to the user's document titled "${pv.fileName || 'unknown'}".
When the user asks you to create, add, write, insert, restructure, or format anything, respond with the appropriate <doc_op> tags to perform those actions, followed by a brief plain-text confirmation of what you did. Never just describe what you would do — always emit the doc_op tags to actually do it. You can read the current document content which is provided below in full on each message.
Available doc_op types: insert_heading (level attr), insert_paragraph, insert_section (heading attr), replace_selection, insert_table (rows, cols attrs), format_selection (format attr: bold/italic/underline).
For any math, use $...$ (inline) or $$...$$ (display).`;
  } else {
    DOC_SYSTEM = `You are a helpful assistant analyzing a file titled "${pv.fileName || 'unknown'}". Answer clearly and concisely. For any math, use $...$ (inline) or $$...$$ (display).`;
  }

  let systemContent = DOC_SYSTEM;
  if (docContent) {
    systemContent += `\n\nCurrent document content:\n${docContent.slice(0, 8000)}`;
  }

  let userContent = text;
  if (ctx) {
    userContent = `[Context — ${ctxLabel}]:\n"${(ctx.text || '').slice(0, 1200)}"`;
    if (ctx.extra) userContent += '\n\n[Related]:\n' + ctx.extra;
    userContent += `\n\nQuestion: ${text}`;
  }
  const model = document.getElementById('pv-model-select')?.value
    || document.getElementById('pv-agent-model-btn')?.textContent.replace(/\s*▾\s*/, '').trim()
    || 'gemma3:latest';
  const msgs = [{ role: 'system', content: systemContent }, ...pv.messages.slice(-12), { role: 'user', content: userContent }];

  // Show typing indicator
  const thread = document.getElementById('pv-thread');
  const typingEl = document.createElement('div');
  typingEl.className = 'pv-typing';
  typingEl.innerHTML = '<span>\u00B7</span><span>\u00B7</span><span>\u00B7</span>';
  thread.appendChild(typingEl);
  thread.scrollTop = thread.scrollHeight;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: msgs, stream: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Remove typing indicator, show agent bubble
    typingEl.remove();
    const { bubble, content: contentEl } = appendAgent(ctxLabel);
    const reader = res.body.getReader(); const decoder = new TextDecoder();
    let raw = '', buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { const d = JSON.parse(line); if (d.message?.content) { raw += d.message.content; contentEl.innerHTML = markdown(raw); thread.scrollTop = thread.scrollHeight; } } catch {}
      }
    }

    // Parse doc_ops from raw response
    const docOps = parseDocOps(raw);
    const cleanText = raw.replace(/<doc_op[^>]*>[\s\S]*?<\/doc_op>/g, '').trim();
    if (cleanText) contentEl.innerHTML = markdown(cleanText);

    // Execute doc_ops on the active editor
    if (docOps.length > 0) {
      executeDocOps(docOps);
      // Render action pills below the agent message
      const pillsDiv = document.createElement('div');
      pillsDiv.className = 'pv-doc-pills';
      docOps.forEach(op => {
        const pill = document.createElement('span');
        pill.className = 'pv-doc-pill';
        pill.textContent = formatDocOpPill(op);
        pillsDiv.appendChild(pill);
      });
      bubble.parentElement.appendChild(pillsDiv);
    }

    pv.messages.push({ role: 'user', content: userContent });
    pv.messages.push({ role: 'assistant', content: raw });
  } catch (err) {
    typingEl.remove();
    const { content: contentEl } = appendAgent(ctxLabel);
    contentEl.textContent = `Error: ${err.message}`;
  }
  finally {
    pv.streaming = false;
    document.getElementById('pv-send').disabled = false;
    thread.scrollTop = thread.scrollHeight;
  }
}

// ── Doc Op parsing ─────────────────────────────────────────────────
function parseDocOps(text) {
  const ops = [];
  const re = /<doc_op\s+([^>]*)>([\s\S]*?)<\/doc_op>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const attrStr = m[1];
    const content = m[2].trim();
    const attrs = {};
    const attrRe = /(\w+)=["']([^"']*)["']/g;
    let am;
    while ((am = attrRe.exec(attrStr)) !== null) attrs[am[1]] = am[2];
    ops.push({ type: attrs.type || 'unknown', attrs, content });
  }
  return ops;
}

function executeDocOps(ops) {
  const editor = window.__activeEditor;
  if (!editor) return;
  const editorType = window.__activeEditorType || 'tiptap';

  for (const op of ops) {
    try {
      if (editorType === 'gdoc') {
        executeGdocOp(editor, op);
      } else if (editorType === 'pdf') {
        executePdfOp(editor, op);
      } else if (editorType === 'tiptap') {
        executeTiptapOp(editor, op);
      } else if (editorType === 'monaco') {
        executeMonacoOp(editor, op);
      } else {
        executeTiptapOp(editor, op);
      }
    } catch (err) {
      console.warn('[DocOp] Failed:', op.type, err);
    }
  }
}

function executePdfOp(editor, op) {
  switch (op.type) {
    case 'replace_text': {
      // Replace specific text in the PDF
      const oldText = op.attrs.old || op.attrs.find || '';
      const newText = op.content;
      if (oldText && newText) {
        editor.replaceText(oldText, newText);
      }
      break;
    }
    case 'edit_block': {
      // Edit a specific block by ID
      const blockId = op.attrs.block_id || op.attrs.id;
      if (blockId) {
        editor.editBlock(blockId, op.content);
      } else {
        // Try to find by text content
        const searchText = op.attrs.find || op.attrs.original || '';
        if (searchText) {
          editor.replaceText(searchText, op.content);
        }
      }
      break;
    }
    case 'rewrite_block': {
      // Find block containing text and replace entirely
      const find = op.attrs.find || '';
      const block = editor.findBlock(find);
      if (block) {
        editor.editBlock(block.id, op.content);
      }
      break;
    }
    default:
      console.warn('[PdfOp] Unknown type:', op.type);
  }
}

function executeGdocOp(editor, op) {
  const a = op.attrs;

  // Normalize: "add" or "add_widget" both work
  const t = op.type.replace('_widget', '');

  switch (t) {
    case 'add': {
      const kind = a.kind || a.widget_type || 'textbox';
      const defs = (window.GDocWidgets && window.GDocWidgets.getDefaults(kind)) || { type: kind };
      const def  = { ...defs };
      if (a.colSpan)  def.colSpan  = parseInt(a.colSpan);
      if (a.colStart) def.colStart = parseInt(a.colStart);
      if (a.rowSpan)  def.rowSpan  = parseInt(a.rowSpan);
      if (op.content) def.content  = op.content;
      if (a.src)      def.src      = a.src;
      if (a.alt)      def.alt      = op.content || '';
      if (a.headers)  { try { def.headers = JSON.parse(a.headers); } catch {} }
      if (a.rows)     { try { def.rows    = JSON.parse(a.rows); }    catch {} }
      editor.addWidget(def);
      break;
    }
    case 'update': {
      if (!a.id) break;
      const changes = {};
      if (op.content) changes.content  = op.content;
      if (a.colSpan)  changes.colSpan  = parseInt(a.colSpan);
      if (a.colStart) changes.colStart = parseInt(a.colStart);
      if (a.rowSpan)  changes.rowSpan  = parseInt(a.rowSpan);
      if (a.src)      changes.src      = a.src;
      if (a.headers)  { try { changes.headers = JSON.parse(a.headers); } catch {} }
      if (a.rows)     { try { changes.rows    = JSON.parse(a.rows); }    catch {} }
      editor.updateWidget(a.id, changes);
      break;
    }
    case 'remove':
      if (a.id) editor.removeWidget(a.id);
      break;
    case 'move':
      if (a.id) editor.moveWidget(a.id, parseInt(a.dir || a.direction) || 1);
      break;
    // Fallback: tiptap-style ops → convert to add
    case 'insert_heading':
      editor.addWidget({ type: 'title', colSpan: 12, rowSpan: 2, content: op.content });
      break;
    case 'insert_paragraph':
      editor.addWidget({ type: 'textbox', colSpan: 12, rowSpan: 3, content: op.content });
      break;
    case 'insert_section':
      editor.addWidget({ type: 'title', colSpan: 12, rowSpan: 2, content: a.heading || 'Section' });
      editor.addWidget({ type: 'textbox', colSpan: 12, rowSpan: 4, content: op.content });
      break;
    case 'insert_table': {
      const r = parseInt(a.rows) || 3, c = parseInt(a.cols) || 3;
      editor.addWidget({ type: 'table', colSpan: 12, rowSpan: Math.max(3, r + 2),
        headers: Array.from({length: c}, (_, i) => 'Col ' + (i+1)),
        rows: Array.from({length: r}, () => Array(c).fill('')) });
      break;
    }
    default:
      console.warn('[GdocOp] Unknown type:', op.type);
  }
}

function executeTiptapOp(editor, op) {
  const chain = editor.chain().focus();
  switch (op.type) {
    case 'insert_heading': {
      const level = parseInt(op.attrs.level) || 1;
      chain.insertContent({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: op.content }] }).run();
      break;
    }
    case 'insert_paragraph':
      chain.insertContent({ type: 'paragraph', content: [{ type: 'text', text: op.content }] }).run();
      break;
    case 'insert_section': {
      const heading = op.attrs.heading || 'Section';
      chain.insertContent([
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: heading }] },
        { type: 'paragraph', content: [{ type: 'text', text: op.content }] },
      ]).run();
      break;
    }
    case 'replace_selection':
      chain.insertContent(op.content).run();
      break;
    case 'insert_table': {
      const rows = parseInt(op.attrs.rows) || 3;
      const cols = parseInt(op.attrs.cols) || 3;
      if (typeof chain.insertTable === 'function') {
        chain.insertTable({ rows, cols, withHeaderRow: true }).run();
      }
      break;
    }
    case 'format_selection': {
      const fmt = op.attrs.format;
      if (fmt === 'bold') chain.toggleBold().run();
      else if (fmt === 'italic') chain.toggleItalic().run();
      else if (fmt === 'underline') chain.toggleUnderline().run();
      break;
    }
    default:
      console.warn('[DocOp] Unknown type:', op.type);
  }
}

function executeMonacoOp(editor, op) {
  const model = editor.getModel();
  if (!model) return;
  const lastLine = model.getLineCount();
  const lastCol = model.getLineMaxColumn(lastLine);
  const endPos = { lineNumber: lastLine, column: lastCol };

  switch (op.type) {
    case 'insert_heading': {
      const level = parseInt(op.attrs.level) || 1;
      const prefix = '#'.repeat(level) + ' ';
      editor.executeEdits('agent', [{ range: { startLineNumber: lastLine, startColumn: lastCol, endLineNumber: lastLine, endColumn: lastCol }, text: '\n' + prefix + op.content + '\n' }]);
      break;
    }
    case 'insert_paragraph':
      editor.executeEdits('agent', [{ range: { startLineNumber: lastLine, startColumn: lastCol, endLineNumber: lastLine, endColumn: lastCol }, text: '\n' + op.content + '\n' }]);
      break;
    case 'insert_section': {
      const heading = op.attrs.heading || 'Section';
      editor.executeEdits('agent', [{ range: { startLineNumber: lastLine, startColumn: lastCol, endLineNumber: lastLine, endColumn: lastCol }, text: '\n## ' + heading + '\n' + op.content + '\n' }]);
      break;
    }
    case 'replace_selection': {
      const sel = editor.getSelection();
      if (sel) editor.executeEdits('agent', [{ range: sel, text: op.content }]);
      break;
    }
  }
}

function formatDocOpPill(op) {
  switch (op.type) {
    case 'insert_heading': return `\u2713 Inserted H${op.attrs.level || 1} \u2014 "${op.content.slice(0, 30)}"`;
    case 'insert_paragraph': {
      const sentences = op.content.split(/[.!?]+/).filter(s => s.trim()).length;
      return `\u2713 Added paragraph \u2014 ${sentences} sentence${sentences !== 1 ? 's' : ''}`;
    }
    case 'insert_section': return `\u2713 Created section \u2014 "${op.attrs.heading || 'Section'}"`;
    case 'replace_selection': return '\u2713 Replaced selection';
    case 'insert_table': return `\u2713 Inserted ${op.attrs.rows}\u00D7${op.attrs.cols} table`;
    case 'format_selection': return `\u2713 Applied ${op.attrs.format}`;
    case 'replace_text': return `\u2713 Replaced text \u2014 "${(op.attrs.old || '').slice(0, 25)}\u2026"`;
    case 'edit_block': return `\u2713 Edited block \u2014 "${op.content.slice(0, 30)}\u2026"`;
    case 'rewrite_block': return `\u2713 Rewrote block \u2014 "${(op.attrs.find || '').slice(0, 25)}\u2026"`;
    case 'add': case 'add_widget': return `\u2713 Added ${op.attrs.kind || op.attrs.widget_type || 'widget'} \u2014 "${(op.content || '').slice(0, 30)}"`;
    case 'update': case 'update_widget': return `\u2713 Updated ${(op.attrs.id || '').slice(0, 12)} \u2014 "${(op.content || '').slice(0, 30)}"`;
    case 'remove': case 'remove_widget': return `\u2713 Removed ${op.attrs.id || ''}`;
    case 'move': case 'move_widget': return `\u2713 Moved ${op.attrs.id || ''} ${parseInt(op.attrs.dir || op.attrs.direction) > 0 ? 'down' : 'up'}`;
    default: return `\u2713 ${op.type}`;
  }
}

function appendUser(text, label) {
  const thread = document.getElementById('pv-thread');
  const msg = document.createElement('div'); msg.className = 'pv-msg pv-msg-user';
  if (label) { const ref = document.createElement('div'); ref.className = 'pv-block-ref'; ref.textContent = label; msg.appendChild(ref); }
  const bubble = document.createElement('div'); bubble.className = 'pv-bubble'; bubble.textContent = text;
  msg.appendChild(bubble); thread.appendChild(msg); thread.scrollTop = thread.scrollHeight;
}

function appendAgent(label) {
  const thread = document.getElementById('pv-thread');
  const msg = document.createElement('div'); msg.className = 'pv-msg pv-msg-agent';
  if (label) { const ref = document.createElement('div'); ref.className = 'pv-block-ref'; ref.textContent = `re: ${label}`; msg.appendChild(ref); }
  const bubble = document.createElement('div'); bubble.className = 'pv-bubble';
  msg.appendChild(bubble); thread.appendChild(msg); thread.scrollTop = thread.scrollHeight;
  return { bubble, content: bubble };
}

// ── Proactive message — suggestion cards ──────────────────────────
function sendProactiveMessage(name, type) {
  const thread = document.getElementById('pv-thread');
  if (thread.dataset.lastFile !== name) { thread.innerHTML = ''; pv.messages = []; thread.dataset.lastFile = name; }

  const suggestions = {
    pdf: [
      { title: 'Fix grammar and spelling', desc: "I'll find and fix all errors directly in the PDF", cmd: 'Read through the entire document and fix all grammar, spelling, and punctuation errors. Edit the text blocks directly.' },
      { title: 'Improve the writing', desc: 'Rewrite sections for better clarity and flow', cmd: 'Read the document and improve the writing quality, clarity, and professional tone. Edit each text block that needs improvement.' },
      { title: 'Summarize this document', desc: 'Key points, structure, and takeaways', cmd: 'Summarize this PDF document — what is it about, what are the key sections and main points?' },
    ],
    doc: [
      { title: 'Add a title and introduction', desc: "I'll write an opening based on your document's content", cmd: 'Add a title and an introduction section to this document based on its content' },
      { title: 'Generate a full document structure', desc: 'Headings, sections, and outline based on what you\'re working on', cmd: 'Generate a complete document structure with headings and sections for this document' },
      { title: 'Improve what\'s written so far', desc: 'Fix grammar, tone, and flow', cmd: 'Improve the writing quality, grammar, tone, and flow of this entire document' },
    ],
    xlsx: [
      { title: 'Summarize this spreadsheet', desc: 'Key stats, patterns, and insights', cmd: 'Summarize the key data, patterns, and insights in this spreadsheet' },
      { title: 'Write formulas', desc: 'I\'ll suggest formulas based on your data', cmd: 'Suggest useful formulas for this spreadsheet based on its data' },
      { title: 'Clean and format data', desc: 'Fix inconsistencies and improve layout', cmd: 'Clean and format the data in this spreadsheet' },
    ],
    code: [
      { title: 'Review this code', desc: 'Find bugs, suggest improvements', cmd: 'Review this code for bugs, performance issues, and improvements' },
      { title: 'Explain how it works', desc: 'Step-by-step walkthrough', cmd: 'Explain how this code works step by step' },
      { title: 'Refactor for clarity', desc: 'Improve readability and structure', cmd: 'Refactor this code for better readability and structure' },
    ],
    img: [
      { title: 'Describe this image', desc: 'Detailed visual description', cmd: 'Describe everything visible in this image in detail' },
      { title: 'Generate alt text', desc: 'Accessibility-friendly description', cmd: 'Generate concise alt text for this image' },
      { title: 'Suggest edits', desc: 'Composition and improvements', cmd: 'Suggest editing improvements for this image' },
    ],
  };

  const cards = suggestions[type] || [
    { title: 'Summarize this file', desc: 'Key takeaways and structure', cmd: 'Summarize the content of this file' },
    { title: 'Answer questions', desc: 'Ask me anything about this file', cmd: '' },
    { title: 'Improve content', desc: 'Fix grammar, tone, and clarity', cmd: 'Improve the content quality of this file' },
  ];

  const container = document.createElement('div');
  container.className = 'pv-suggestions';
  cards.forEach(card => {
    if (!card.cmd) return; // skip placeholder cards
    const el = document.createElement('div');
    el.className = 'pv-suggestion-card';
    el.innerHTML = `<div class="pv-suggestion-title">${escHtml(card.title)}</div><div class="pv-suggestion-desc">${escHtml(card.desc)}</div>`;
    el.addEventListener('click', () => {
      document.getElementById('pv-input').value = card.cmd;
      send();
    });
    container.appendChild(el);
  });
  thread.appendChild(container);

  // Update chips based on document type
  updateChipsForType(type);
}

function updateChipsForType(type) {
  const row = document.getElementById('pv-chip-row');
  if (!row) return;
  const chipSets = {
    pdf: [
      { label: 'Fix grammar', cmd: 'Fix all grammar, spelling, and punctuation errors in this document. Edit the text blocks directly.' },
      { label: 'Improve writing', cmd: 'Improve the writing quality and clarity of this document. Edit the text blocks directly.' },
      { label: 'Summarize', cmd: 'Summarize the key points of this document.' },
      { label: 'Proofread', cmd: 'Proofread this entire document and fix any issues you find. Edit the text blocks directly.' },
    ],
    doc: [
      { label: '+ Add section', cmd: 'Add a new section to this document with a heading and body text' },
      { label: '+ Introduction', cmd: 'Write an introduction section for this document' },
      { label: 'Improve writing', cmd: 'Improve the writing quality, clarity, and flow of this document' },
      { label: 'Fix grammar', cmd: 'Fix all grammar, spelling, and punctuation in this document' },
    ],
    code: [
      { label: 'Review', cmd: 'Review this code for bugs and improvements' },
      { label: 'Explain', cmd: 'Explain how this code works' },
      { label: 'Refactor', cmd: 'Refactor this code for clarity' },
      { label: 'Add comments', cmd: 'Add helpful comments to this code' },
    ],
    xlsx: [
      { label: 'Summarize', cmd: 'Summarize the data in this spreadsheet' },
      { label: 'Formulas', cmd: 'Suggest useful formulas for this data' },
      { label: 'Clean data', cmd: 'Clean and format this data' },
      { label: 'Chart ideas', cmd: 'Suggest charts to visualize this data' },
    ],
  };
  const chips = chipSets[type] || chipSets.doc;
  row.innerHTML = '';
  chips.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'pv-chip';
    btn.textContent = c.label;
    btn.addEventListener('click', () => { document.getElementById('pv-input').value = c.cmd; send(); });
    row.appendChild(btn);
  });
}

// ── Context pill ──────────────────────────────────────────────────
function renderPill(label) {
  const row = document.getElementById('pv-pill-row'); row.innerHTML = '';
  const pill = document.createElement('div'); pill.className = 'pv-context-pill';
  const lbl = document.createElement('span'); lbl.className = 'pv-pill-label'; lbl.textContent = label;
  const x = document.createElement('button'); x.className = 'pv-pill-x'; x.textContent = '\u00D7'; x.title = 'Dismiss';
  x.addEventListener('click', () => { pv.context = null; row.innerHTML = ''; });
  pill.append(lbl, x); row.appendChild(pill);
}

// ── Markdown renderer ─────────────────────────────────────────────
function markdown(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cb = [], ic = [], mb = [], mi = [];
  let t = text.replace(/```[\s\S]*?```/g, m => { cb.push(m); return `\x00C${cb.length-1}\x00`; });
  t = t.replace(/`[^`]+`/g, m => { ic.push(m); return `\x00I${ic.length-1}\x00`; });
  t = t.replace(/\$\$[\s\S]+?\$\$/g, m => { mb.push(m); return `\x00M${mb.length-1}\x00`; });
  t = t.replace(/\$[^$\n]+\$/g, m => { mi.push(m); return `\x00N${mi.length-1}\x00`; });
  t = esc(t);
  t = t.replace(/\x00M(\d+)\x00/g, (_, i) => mb[i]);
  t = t.replace(/\x00N(\d+)\x00/g, (_, i) => mi[i]);
  t = t.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
  t = t.replace(/__(.+?)__/g, '<strong>$1</strong>');
  t = t.replace(/_(.+?)_/g, '<em>$1</em>');
  t = t.replace(/\x00C(\d+)\x00/g, (_, i) => {
    const raw = cb[i]; const m2 = raw.match(/^```(\w*)\n?([\s\S]*?)```$/);
    const lang = m2?.[1] ? `<span style="font-size:10px;color:#888">${m2[1]}</span><br>` : '';
    return `<pre>${lang}<code>${esc(m2?.[2] || raw)}</code></pre>`;
  });
  t = t.replace(/\x00I(\d+)\x00/g, (_, i) => `<code>${esc(ic[i].slice(1, -1))}</code>`);
  t = t.replace(/^(\s*)[*\-] (.+)$/gm, '$1<li>$2</li>');
  t = t.replace(/^(\s*)\d+\. (.+)$/gm, '$1<li>$2</li>');
  t = t.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  t = t.replace(/^### (.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:13px;color:#c0c0c0">$1</h4>');
  t = t.replace(/^## (.+)$/gm, '<h3 style="margin:10px 0 5px;font-size:14px;color:#d0d0d0">$1</h3>');
  t = t.replace(/^# (.+)$/gm, '<h2 style="margin:10px 0 5px;font-size:15px;color:#e0e0e0">$1</h2>');
  t = t.split(/\n{2,}/).map(p => /^<(h[2-4]|ul|pre|li)/.test(p.trim()) ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
  return t;
}

// ── Model selector ────────────────────────────────────────────────
let _agentModels = [];
async function initModels() {
  const sel = document.getElementById('pv-model-select');
  try {
    const data = await fetch('/api/chat-models').then(r => r.json());
    const models = data.models || [];
    _agentModels = models;
    if (!models.length) { sel.innerHTML = '<option>gemma3:latest</option>'; return; }
    sel.innerHTML = '';
    models.forEach(m => { const o = document.createElement('option'); o.value = o.textContent = m.name; sel.appendChild(o); });
    // Populate agent model dropdown
    populateAgentModelDropdown(models);
  } catch { sel.innerHTML = '<option value="gemma3:latest">gemma3:latest</option>'; }
}

function populateAgentModelDropdown(models) {
  const dropdown = document.getElementById('pv-agent-model-dropdown');
  const btn = document.getElementById('pv-agent-model-btn');
  const sel = document.getElementById('pv-model-select');
  if (!dropdown || !btn) return;
  dropdown.innerHTML = '';
  models.forEach(m => {
    const opt = document.createElement('button');
    opt.className = 'pv-agent-model-opt';
    opt.textContent = m.name;
    if (m.name === (sel?.value || 'gemma3:latest')) opt.classList.add('active');
    opt.addEventListener('click', () => {
      // Update both selectors
      if (sel) sel.value = m.name;
      btn.innerHTML = escHtml(m.name) + ' &#9662;';
      dropdown.querySelectorAll('.pv-agent-model-opt').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      dropdown.classList.remove('open');
    });
    dropdown.appendChild(opt);
  });
  // Set initial button text
  btn.innerHTML = escHtml(sel?.value || models[0]?.name || 'gemma3:latest') + ' &#9662;';
}

// ── Keyboard ──────────────────────────────────────────────────────
function initKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (pv.screen === 'editor') showHome(); }
  });
}

// ── Status dot ────────────────────────────────────────────────────
function showDot(state) {
  let dot = document.getElementById('pv-status-dot');
  if (!dot) { dot = document.createElement('span'); dot.id = 'pv-status-dot'; const n = document.getElementById('pv-doc-name-display'); if (n) n.insertAdjacentElement('afterbegin', dot); }
  dot.className = 'pv-dot pv-dot-' + state;
  dot.title = { analyzing: 'Analyzing...', ready: 'Ready', error: 'Failed' }[state] || state;
}
function hideDot() { const d = document.getElementById('pv-status-dot'); if (d) d.remove(); }

// ══════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════

function detectType(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'gdoc') return 'gdoc';
  if (['xlsx','xls','csv'].includes(ext)) return 'xlsx';
  if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) return 'img';
  if (['py','js','ts','json','html','css','java','cpp','c','go','rs','rb','xml','yaml','sh'].includes(ext)) return 'code';
  if (['md','txt','docx','doc'].includes(ext)) return 'doc';
  if (['mp3','wav','ogg','flac'].includes(ext)) return 'audio';
  if (['mp4','webm','mov'].includes(ext)) return 'video';
  return 'default';
}

function badgeClass(type) {
  return { pdf:'pdf', gdoc:'doc', xlsx:'xlsx', img:'img', code:'code', doc:'doc', audio:'doc', video:'img' }[type] || 'default';
}

function typeIcon(type) {
  return { pdf:'PDF', gdoc:'DOC', xlsx:'XLS', img:'IMG', code:'< >', doc:'DOC', audio:'\u266B', video:'\u25B6' }[type] || 'FILE';
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts, min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const d = Math.floor(hr / 24);
  if (d < 7) return d + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ══════════════════════════════════════════════════════════════════
//  SHELL API — used by all viewers
// ══════════════════════════════════════════════════════════════════

window.ViewerShell = {
  state: pv,
  showHome,
  showEditor,
  openPath,
  openFile,
  addRecent,

  // Toolbar
  setToolbarTabs(tabs) {
    const el = document.getElementById('pvr-tabs'); el.innerHTML = '';
    tabs.forEach((tab, i) => {
      const btn = document.createElement('button');
      btn.className = 'pvr-tab' + (i === 0 ? ' pvr-tab-active' : '');
      btn.dataset.tabId = tab.id; btn.textContent = tab.name;
      btn.addEventListener('click', () => {
        el.querySelectorAll('.pvr-tab').forEach(t => t.classList.remove('pvr-tab-active'));
        btn.classList.add('pvr-tab-active');
        if (tab.onActivate) tab.onActivate();
      });
      el.appendChild(btn);
    });
  },
  setToolbarBand(html) { document.getElementById('pvr-band').innerHTML = typeof html === 'string' ? html : ''; },
  setToolbarBandEl(el)  { const band = document.getElementById('pvr-band'); band.innerHTML = ''; if (el) band.appendChild(el); },

  // Sidebar
  setSidebarContent(el) {
    const sb = document.getElementById('pv-sidebar'); sb.innerHTML = '';
    if (typeof el === 'string') sb.innerHTML = el;
    else if (el) sb.appendChild(el);
  },
  setSidebarVisible(v) { document.getElementById('pv-sidebar').style.display = v ? '' : 'none'; },

  // Agent
  setContext(ctx)     { pv.context = ctx; if (ctx) renderPill(ctx.label); },
  clearContext()      { pv.context = null; document.getElementById('pv-pill-row').innerHTML = ''; },
  getCenterEl()       { return document.getElementById('pv-center'); },
  registerViewer(v)   { pv.viewer = v; },
  registerEditor(editorInstance, editorType) {
    window.__activeEditor = editorInstance;
    window.__activeEditorType = editorType || 'tiptap';
  },
  unregisterEditor() {
    window.__activeEditor = null;
    window.__activeEditorType = null;
  },

  // Status
  showDot, hideDot,

  // Utilities
  escHtml, detectType, loadScript, loadCSS, markdown,
  updateRecentThumbnail,
};

})();
