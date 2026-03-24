'use strict';
/* ═══════════════════════════════════════════════════════════════
   DocViewer.js — Markdown, plain text, and DOCX viewer
   ═══════════════════════════════════════════════════════════════ */

(function () {

const MARKED_SRC  = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';
const MAMMOTH_SRC = 'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js';

let _shell = null;
let _centerEl = null;
let _file = null;
let _content = '';
let _htmlContent = '';
let _docType = 'txt';
let _mode = 'preview';  // 'edit' or 'preview' (md only)
let _textarea = null;

// ── Mount ──────────────────────────────────────────────────────
function mount(centerEl, file, shell) {
  _shell = shell;
  _centerEl = centerEl;
  _file = file;
  _content = '';
  _htmlContent = '';
  _textarea = null;
  _mode = 'preview';

  const ext = (file.name || '').split('.').pop().toLowerCase();
  _docType = (ext === 'md') ? 'md' : (ext === 'docx' || ext === 'doc') ? 'docx' : 'txt';

  centerEl.innerHTML = '<div style="color:var(--text-muted);padding:24px">Loading\u2026</div>';

  if (_docType === 'docx') {
    loadDocx(file);
  } else {
    loadText(file);
  }
}

function cleanup() {
  _textarea = null;
  _content = '';
  _htmlContent = '';
  _file = null;
}

// ── Text loading (txt / md) ────────────────────────────────────
async function loadText(file) {
  try {
    let text = '';
    if (file.path) {
      const res = await fetch('/api/files/read?path=' + encodeURIComponent(file.path));
      const data = await res.json();
      text = data.content || '';
    } else if (file.url) {
      const res = await fetch(file.url);
      text = await res.text();
    }
    _content = text;

    if (_docType === 'md') {
      await _shell.loadScript(MARKED_SRC);
      _mode = 'preview';
      renderMdPreview();
    } else {
      renderTextarea(text);
    }

    setupToolbar();
    setupSidebar();
    setAgentContext();
  } catch (err) {
    _centerEl.innerHTML = '<div style="color:#f88;padding:24px">Failed to load: ' + _shell.escHtml(err.message) + '</div>';
  }
}

// ── DOCX loading ───────────────────────────────────────────────
async function loadDocx(file) {
  try {
    await _shell.loadScript(MAMMOTH_SRC);
    const url = file.url || (file.path ? '/api/files/serve?path=' + encodeURIComponent(file.path) : null);
    if (!url) throw new Error('No file URL');

    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    _htmlContent = result.value || '';
    _content = stripHtml(_htmlContent);

    _centerEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow-y:auto;height:100%;padding:32px;color:var(--text);font-size:14px;line-height:1.7;';
    wrap.innerHTML = _htmlContent;
    _centerEl.appendChild(wrap);

    setupToolbar();
    setupSidebar();
    setAgentContext();
  } catch (err) {
    _centerEl.innerHTML = '<div style="color:#f88;padding:24px">Failed to load DOCX: ' + _shell.escHtml(err.message) + '</div>';
  }
}

// ── Renderers ──────────────────────────────────────────────────
function renderTextarea(text) {
  _centerEl.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.spellcheck = false;
  ta.style.cssText = 'width:100%;height:100%;box-sizing:border-box;resize:none;' +
    'background:var(--surface);color:var(--text);border:none;padding:32px;' +
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.7;outline:none;';
  ta.addEventListener('input', () => { _content = ta.value; });
  _centerEl.appendChild(ta);
  _textarea = ta;
}

function renderMdPreview() {
  _centerEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'pv-bubble';
  wrap.style.cssText = 'overflow-y:auto;height:100%;padding:32px;color:var(--text);font-size:14px;line-height:1.7;';
  if (window.marked) {
    wrap.innerHTML = window.marked.parse(_content);
  } else {
    wrap.textContent = _content;
  }
  _centerEl.appendChild(wrap);
  _textarea = null;
}

function renderMdEdit() {
  renderTextarea(_content);
}

// ── Toolbar ────────────────────────────────────────────────────
function setupToolbar() {
  const tabs = [];
  if (_docType === 'md') {
    tabs.push({ name: 'Preview', id: 'preview', onActivate: () => switchMode('preview') });
    tabs.push({ name: 'Edit', id: 'edit', onActivate: () => switchMode('edit') });
  } else {
    tabs.push({ name: 'Document', id: 'doc', onActivate: () => showBand() });
  }
  _shell.setToolbarTabs(tabs);
  showBand();
}

function showBand() {
  const el = document.createElement('div');
  el.className = 'pvr-group';
  el.style.cssText = 'display:flex;align-items:center;gap:8px;';

  // Type label
  const lbl = document.createElement('span');
  lbl.style.cssText = 'font-size:11px;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;';
  lbl.textContent = _docType;
  el.appendChild(lbl);

  const sep = document.createElement('div');
  sep.className = 'pvr-sep';
  el.appendChild(sep);

  // Copy All button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'pvr-tool-btn';
  copyBtn.textContent = 'Copy All';
  copyBtn.style.cssText = 'padding:3px 10px;font-size:11px;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:var(--surface);color:var(--text-sec);';
  copyBtn.addEventListener('click', () => {
    const text = _content || '';
    (navigator.clipboard ? navigator.clipboard.writeText(text) : fallbackCopy(text));
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy All'; }, 1400);
  });
  el.appendChild(copyBtn);

  _shell.setToolbarBandEl(el);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta);
  ta.select(); document.execCommand('copy'); ta.remove();
}

function switchMode(mode) {
  _mode = mode;
  if (mode === 'preview') {
    if (_textarea) _content = _textarea.value;
    renderMdPreview();
  } else {
    renderMdEdit();
  }
  showBand();
  setupSidebar();
}

// ── Sidebar ────────────────────────────────────────────────────
function setupSidebar() {
  const sb = document.createElement('div');
  sb.style.cssText = 'padding:8px;overflow-y:auto;height:100%;';

  // Heading label
  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);margin-bottom:6px;';
  hdr.textContent = 'Outline';
  sb.appendChild(hdr);

  const headings = extractHeadings();
  if (!headings.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-muted);padding:4px 6px;';
    empty.textContent = 'No headings found'; sb.appendChild(empty);
  }
  headings.forEach(h => {
    const item = document.createElement('div');
    item.style.cssText = 'font-size:11px;padding:2px 6px 2px ' + (6 + (h.level - 1) * 10) + 'px;cursor:pointer;color:var(--text-sec);border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    item.textContent = h.text; item.title = h.text;
    item.addEventListener('mouseenter', () => { item.style.background = 'var(--surface2)'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
    item.addEventListener('click', () => scrollToHeading(h));
    sb.appendChild(item);
  });

  const div = document.createElement('div');
  div.style.cssText = 'border-top:1px solid var(--border);margin:10px 0;'; sb.appendChild(div);
  const words = _content.trim() ? _content.trim().split(/\s+/).length : 0;
  const stats = document.createElement('div');
  stats.style.cssText = 'font-size:11px;color:var(--text-muted);padding:0 6px;line-height:1.7;';
  stats.innerHTML = '<div>Words: ' + words + '</div><div>Characters: ' + _content.length + '</div>';
  sb.appendChild(stats);

  _shell.setSidebarContent(sb);
}

function extractHeadings() {
  const out = [];
  if (_docType === 'md') {
    _content.split('\n').forEach((ln, i) => {
      const m = ln.match(/^(#{1,6})\s+(.+)/);
      if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i });
    });
  } else if (_docType === 'docx' && _htmlContent) {
    const tmp = document.createElement('div'); tmp.innerHTML = _htmlContent;
    tmp.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(el => {
      out.push({ level: parseInt(el.tagName[1], 10), text: el.textContent.trim() });
    });
  }
  return out;
}

function scrollToHeading(h) {
  if (_docType === 'md' && _mode === 'edit' && _textarea) {
    const lines = _content.split('\n');
    let pos = 0;
    for (let i = 0; i < h.line && i < lines.length; i++) pos += lines[i].length + 1;
    _textarea.setSelectionRange(pos, pos); _textarea.focus();
    _textarea.scrollTop = Math.max(0, h.line * 13 * 1.7 - 60);
    return;
  }
  const container = (_docType === 'md') ? (_centerEl.querySelector('.pv-bubble') || _centerEl) : _centerEl.querySelector('div');
  if (!container) return;
  for (const tag of container.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (tag.textContent.trim() === h.text) { tag.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
  }
}

// ── Agent context ──────────────────────────────────────────────
function setAgentContext() {
  const words = _content.trim() ? _content.trim().split(/\s+/).length : 0;
  const headings = extractHeadings().map(h => h.text);
  const headingList = headings.length ? headings.join(', ') : 'none';
  _shell.setContext({
    label: _file.name,
    text: 'File: ' + _file.name + '\nType: ' + _docType + '\nWords: ' + words +
          '\nHeadings: ' + headingList + '\n\n' + _content.slice(0, 300),
  });
}

// ── Helpers ────────────────────────────────────────────────────
function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

// ── Register ───────────────────────────────────────────────────
window.Viewers = window.Viewers || {};
window.Viewers.doc = { mount, cleanup };

})();
