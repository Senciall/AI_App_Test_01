'use strict';
/* ═══════════════════════════════════════════════════════════════
   CodeViewer.js — Monaco-powered code editor with symbol outline
   ═══════════════════════════════════════════════════════════════ */

(function () {

const MONACO_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs';
const LANG_MAP = { js:'javascript', ts:'typescript', py:'python', html:'html', css:'css', json:'json', xml:'xml', yaml:'yaml', sh:'shell' };

let _shell = null;
let _editor = null;
let _centerEl = null;
let _content = '';
let _file = null;
let _wordWrap = false;

// ── Mount ──────────────────────────────────────────────────────
function mount(centerEl, file, shell) {
  _shell = shell;
  _centerEl = centerEl;
  _file = file;
  _content = '';
  _editor = null;
  _wordWrap = false;

  centerEl.style.overflow = 'hidden';
  centerEl.innerHTML = '<div style="color:var(--text-muted);padding:24px">Loading editor\u2026</div>';

  const ext = (file.name || '').split('.').pop().toLowerCase();
  const lang = LANG_MAP[ext] || 'plaintext';

  loadContent(file).then(text => {
    _content = text;
    setupMonaco(centerEl, text, lang);
    setupToolbar(lang);
    setupSidebar(text, lang, file.name);
    setAgentContext(file.name, lang, text);
  }).catch(err => {
    centerEl.innerHTML = '<div style="color:#f88;padding:24px">Failed to load: ' + _shell.escHtml(err.message) + '</div>';
  });
}

function cleanup() {
  if (_editor) { _editor.dispose(); _editor = null; }
  _content = '';
  _file = null;
}

// ── Content fetch ──────────────────────────────────────────────
async function loadContent(file) {
  if (file.path) {
    const res = await fetch('/api/files/read?path=' + encodeURIComponent(file.path));
    const data = await res.json();
    return data.content || '';
  }
  if (file.url) {
    const res = await fetch(file.url);
    return await res.text();
  }
  return '';
}

// ── Monaco setup ───────────────────────────────────────────────
async function setupMonaco(el, text, lang) {
  if (!window.monaco) {
    await new Promise((ok, fail) => {
      if (!window.require) {
        const loaderScript = document.createElement('script');
        loaderScript.src = MONACO_BASE + '/loader.js';
        loaderScript.onload = ok;
        loaderScript.onerror = fail;
        document.head.appendChild(loaderScript);
      } else { ok(); }
    });
    await new Promise((ok, fail) => {
      window.require.config({ paths: { vs: MONACO_BASE } });
      window.require(['vs/editor/editor.main'], ok, fail);
    });
  }

  el.innerHTML = '';
  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;';
  el.appendChild(container);

  _editor = window.monaco.editor.create(container, {
    value: text,
    language: lang,
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: true },
    fontSize: 13,
    lineNumbers: 'on',
    wordWrap: 'off',
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    padding: { top: 8 },
  });
}

// ── Toolbar ────────────────────────────────────────────────────
function setupToolbar(lang) {
  _shell.setToolbarTabs([
    { name: 'Code', id: 'code', onActivate: () => showBand(lang) }
  ]);
  showBand(lang);
}

function showBand(lang) {
  const el = document.createElement('div');
  el.className = 'pvr-group';
  el.style.cssText = 'display:flex;align-items:center;gap:8px;';

  // Language label
  const lbl = document.createElement('span');
  lbl.style.cssText = 'font-size:11px;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;';
  lbl.textContent = lang;
  el.appendChild(lbl);

  // Separator
  const sep1 = document.createElement('div');
  sep1.className = 'pvr-sep';
  el.appendChild(sep1);

  // Word Wrap toggle
  const wrapBtn = document.createElement('button');
  wrapBtn.className = 'pvr-tool-btn';
  wrapBtn.textContent = 'Word Wrap';
  wrapBtn.style.cssText = btnStyle(false);
  wrapBtn.addEventListener('click', () => {
    _wordWrap = !_wordWrap;
    wrapBtn.style.cssText = btnStyle(_wordWrap);
    if (_editor) _editor.updateOptions({ wordWrap: _wordWrap ? 'on' : 'off' });
  });
  el.appendChild(wrapBtn);

  // Find button
  const findBtn = document.createElement('button');
  findBtn.className = 'pvr-tool-btn';
  findBtn.textContent = 'Find';
  findBtn.style.cssText = btnStyle(false);
  findBtn.addEventListener('click', () => {
    if (_editor) _editor.getAction('actions.find').run();
  });
  el.appendChild(findBtn);

  // Format button
  const fmtBtn = document.createElement('button');
  fmtBtn.className = 'pvr-tool-btn';
  fmtBtn.textContent = 'Format';
  fmtBtn.style.cssText = btnStyle(false);
  fmtBtn.addEventListener('click', () => {
    if (_editor) _editor.getAction('editor.action.formatDocument').run();
  });
  el.appendChild(fmtBtn);

  _shell.setToolbarBandEl(el);
}

function btnStyle(active) {
  return 'padding:3px 10px;font-size:11px;border-radius:4px;border:1px solid var(--border);cursor:pointer;' +
    (active ? 'background:var(--accent);color:#fff;' : 'background:var(--surface);color:var(--text-sec);');
}

// ── Sidebar ────────────────────────────────────────────────────
function setupSidebar(text, lang, fileName) {
  const sb = document.createElement('div');
  sb.style.cssText = 'padding:8px;overflow-y:auto;height:100%;';

  // Symbol heading
  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);margin-bottom:6px;';
  hdr.textContent = 'Symbols';
  sb.appendChild(hdr);

  // Extract symbols
  const symbols = extractSymbols(text);
  if (symbols.length) {
    symbols.forEach(sym => {
      const item = document.createElement('div');
      item.style.cssText = 'font-size:11px;padding:2px 6px;cursor:pointer;color:var(--text-sec);border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      item.textContent = sym.label;
      item.title = sym.label + ' (line ' + sym.line + ')';
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--surface2)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
      item.addEventListener('click', () => {
        if (_editor) {
          _editor.revealLineInCenter(sym.line);
          _editor.setPosition({ lineNumber: sym.line, column: 1 });
          _editor.focus();
        }
      });
      sb.appendChild(item);
    });
  } else {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:var(--text-muted);padding:4px 6px;';
    empty.textContent = 'No symbols found';
    sb.appendChild(empty);
  }

  // Divider
  const div = document.createElement('div');
  div.style.cssText = 'border-top:1px solid var(--border);margin:10px 0;';
  sb.appendChild(div);

  // Stats
  const lines = text.split('\n');
  const stats = document.createElement('div');
  stats.style.cssText = 'font-size:11px;color:var(--text-muted);padding:0 6px;line-height:1.7;';
  stats.innerHTML =
    '<div>Lines: ' + lines.length + '</div>' +
    '<div>Characters: ' + text.length + '</div>' +
    '<div>Language: ' + lang + '</div>';
  sb.appendChild(stats);

  _shell.setSidebarContent(sb);
}

// ── Symbol extraction ──────────────────────────────────────────
function extractSymbols(text) {
  const symbols = [];
  const lines = text.split('\n');
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^\s*(?:export\s+)?class\s+(\w+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/,
    /^\s*def\s+(\w+)/,
    /^\s*(?:export\s+)?interface\s+(\w+)/,
    /^\s*(?:export\s+)?type\s+(\w+)\s*=/,
    /^\s*(?:export\s+)?enum\s+(\w+)/,
  ];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const pat of patterns) {
      const m = ln.match(pat);
      if (m) {
        const kind = /function/.test(pat.source) ? 'fn' :
                     /class/.test(pat.source) ? 'cls' :
                     /def\s/.test(pat.source) ? 'def' :
                     /const|let|var/.test(pat.source) ? 'const' :
                     /interface/.test(pat.source) ? 'iface' :
                     /type\s/.test(pat.source) ? 'type' :
                     /enum/.test(pat.source) ? 'enum' : '?';
        symbols.push({ label: kind + '  ' + m[1], line: i + 1 });
        break;
      }
    }
  }
  return symbols;
}

// ── Agent context ──────────────────────────────────────────────
function setAgentContext(name, lang, text) {
  const lineCount = text.split('\n').length;
  const preview = text.slice(0, 200);
  _shell.setContext({
    label: name,
    text: 'File: ' + name + '\nLanguage: ' + lang + '\nLines: ' + lineCount + '\n\n' + preview,
  });
}

// ── Register ───────────────────────────────────────────────────
window.Viewers = window.Viewers || {};
window.Viewers.code = { mount, cleanup };

})();
