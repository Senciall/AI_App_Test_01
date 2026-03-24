'use strict';
/* ═══════════════════════════════════════════════════════════════
   VideoViewer.js — HTML5 video player with custom controls & notes
   ═══════════════════════════════════════════════════════════════ */

(function () {

let _shell = null, _file = null, _video = null;

// ── Mount ──────────────────────────────────────────────────────
function mount(centerEl, file, shell) {
  _shell = shell; _file = file; _video = null; centerEl.innerHTML = '';

  // --- Video element ---
  const video = document.createElement('video');
  video.id = 'vv-video';
  video.src = file.url;
  video.style.cssText = 'width:100%;max-height:calc(100vh - 160px);object-fit:contain;background:#000;border-radius:4px;display:block;';
  centerEl.appendChild(video);
  _video = video;

  // --- Custom controls bar ---
  const bar = document.createElement('div');
  bar.id = 'vv-controls';
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface);border-radius:0 0 4px 4px;margin-top:-4px;';

  // Play/pause
  const playBtn = document.createElement('button');
  playBtn.id = 'vv-play';
  playBtn.style.cssText = 'background:none;border:none;color:var(--text);font-size:18px;cursor:pointer;padding:0 4px;';
  playBtn.innerHTML = '&#9654;';
  playBtn.addEventListener('click', togglePlay);
  bar.appendChild(playBtn);

  // Progress bar
  const prog = document.createElement('input');
  prog.id = 'vv-progress'; prog.type = 'range'; prog.min = 0; prog.max = 1000; prog.value = 0;
  prog.style.cssText = 'flex:1;height:4px;cursor:pointer;accent-color:var(--accent);';
  prog.addEventListener('input', () => { if (_video.duration) _video.currentTime = (prog.value / 1000) * _video.duration; });
  bar.appendChild(prog);

  // Time label
  const timeLbl = document.createElement('span');
  timeLbl.id = 'vv-time';
  timeLbl.style.cssText = 'font-size:12px;color:var(--text-sec);font-variant-numeric:tabular-nums;min-width:90px;text-align:center;';
  timeLbl.textContent = '0:00 / 0:00';
  bar.appendChild(timeLbl);

  // Speed dropdown
  const sel = document.createElement('select'); sel.id = 'vv-speed';
  sel.style.cssText = 'background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:4px;font-size:11px;padding:2px 4px;cursor:pointer;';
  [0.5, 1, 1.5, 2].forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s + 'x'; if (s === 1) o.selected = true; sel.appendChild(o); });
  sel.addEventListener('change', () => { _video.playbackRate = parseFloat(sel.value); updateTbSpeed(); }); bar.appendChild(sel);

  // Fullscreen
  const fsBtn = document.createElement('button');
  fsBtn.style.cssText = 'background:none;border:none;color:var(--text);font-size:16px;cursor:pointer;padding:0 4px;';
  fsBtn.innerHTML = '&#x26F6;'; fsBtn.title = 'Fullscreen';
  fsBtn.addEventListener('click', toggleFullscreen); bar.appendChild(fsBtn);

  centerEl.appendChild(bar);

  // --- Video events ---
  video.addEventListener('play', updatePlayState);
  video.addEventListener('pause', updatePlayState);
  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('loadedmetadata', () => { updateProgress(); updateSidebar(); updateContext(); updateTbSpeed(); });
  video.addEventListener('click', togglePlay);

  setupToolbar();
  setupSidebar();
}

function cleanup() {
  if (_video) { _video.pause(); _video.removeAttribute('src'); _video.load(); _video = null; }
}

// ── Playback ───────────────────────────────────────────────────
function togglePlay() { if (!_video) return; _video.paused ? _video.play() : _video.pause(); }

function updatePlayState() {
  const playing = _video && !_video.paused;
  const btn = document.getElementById('vv-play');
  if (btn) btn.innerHTML = playing ? '&#9208;' : '&#9654;';
}

function updateProgress() {
  if (!_video) return;
  const prog = document.getElementById('vv-progress');
  const lbl = document.getElementById('vv-time');
  const cur = _video.currentTime; const dur = _video.duration || 0;
  if (prog && dur) prog.value = Math.round((cur / dur) * 1000);
  if (lbl) lbl.textContent = fmtTime(cur) + ' / ' + fmtTime(dur);
}

function toggleFullscreen() {
  if (!_video) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else _video.requestFullscreen().catch(() => {});
}

function fmtTime(sec) {
  if (!sec || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// ── Notes (localStorage) ───────────────────────────────────────
function notesKey() { return 'video-notes-' + (_file.path || _file.name); }
function getNotes() { try { return JSON.parse(localStorage.getItem(notesKey())) || []; } catch { return []; } }
function saveNotes(notes) { localStorage.setItem(notesKey(), JSON.stringify(notes)); }

function addNote() {
  if (!_video) return;
  const ts = _video.currentTime;
  const text = prompt('Add note at ' + fmtTime(ts) + ':');
  if (!text || !text.trim()) return;
  const notes = getNotes();
  notes.push({ time: ts, text: text.trim() });
  notes.sort((a, b) => a.time - b.time);
  saveNotes(notes);
  renderNotes();
}

function renderNotes() {
  const list = document.getElementById('vv-notes');
  if (!list) return;
  const notes = getNotes();
  if (!notes.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:4px 0;">No notes yet</div>'; return; }
  list.innerHTML = '';
  notes.forEach((n, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:6px;padding:4px 0;border-bottom:1px solid var(--border);cursor:pointer;font-size:11px;';
    const ts = document.createElement('span');
    ts.style.cssText = 'color:var(--accent);white-space:nowrap;font-variant-numeric:tabular-nums;';
    ts.textContent = '[' + fmtTime(n.time) + ']';
    const txt = document.createElement('span');
    txt.style.cssText = 'color:var(--text);flex:1;';
    txt.textContent = n.text;
    const del = document.createElement('button');
    del.style.cssText = 'background:none;border:none;color:var(--text-muted);font-size:10px;cursor:pointer;padding:0 2px;';
    del.textContent = '\u00D7'; del.title = 'Delete';
    del.addEventListener('click', e => { e.stopPropagation(); const ns = getNotes(); ns.splice(i, 1); saveNotes(ns); renderNotes(); });
    row.appendChild(ts); row.appendChild(txt); row.appendChild(del);
    row.addEventListener('click', () => { if (_video) { _video.currentTime = n.time; } });
    list.appendChild(row);
  });
}

// ── Toolbar ────────────────────────────────────────────────────
function setupToolbar() {
  _shell.setToolbarTabs([
    { name: 'Player', id: 'player', onActivate: showBand },
  ]);
  showBand();
}

function showBand() {
  const el = document.createElement('div');
  el.className = 'pvr-group';
  el.style.cssText = 'display:flex;align-items:center;gap:8px;';
  const rate = _video ? _video.playbackRate : 1;
  el.innerHTML = '<span id="vv-tb-speed" style="font-size:11px;color:var(--text-sec);">Speed: ' + rate + 'x</span>'
    + '<div class="pvr-sep"></div>'
    + '<button id="vv-tb-fs" style="padding:4px 10px;border-radius:4px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-size:12px;cursor:pointer;">Fullscreen</button>'
    + '<div class="pvr-sep"></div>'
    + '<button id="vv-tb-note" style="padding:4px 10px;border-radius:4px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-size:12px;cursor:pointer;">Add Note</button>';
  _shell.setToolbarBandEl(el);
  el.querySelector('#vv-tb-fs').addEventListener('click', toggleFullscreen);
  el.querySelector('#vv-tb-note').addEventListener('click', addNote);
}

function updateTbSpeed() {
  const lbl = document.getElementById('vv-tb-speed');
  if (lbl && _video) lbl.textContent = 'Speed: ' + _video.playbackRate + 'x';
}

// ── Sidebar ────────────────────────────────────────────────────
function setupSidebar() {
  const sb = document.createElement('div');
  sb.id = 'vv-sidebar';
  sb.style.cssText = 'padding:12px;font-size:11px;color:var(--text-sec);display:flex;flex-direction:column;gap:8px;';

  // Add note button
  const addBtn = document.createElement('button');
  addBtn.style.cssText = 'padding:5px 10px;border-radius:4px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-size:11px;cursor:pointer;align-self:flex-start;';
  addBtn.textContent = '+ Add note';
  addBtn.addEventListener('click', addNote);
  sb.appendChild(addBtn);

  // Notes list
  const list = document.createElement('div');
  list.id = 'vv-notes';
  sb.appendChild(list);

  // Divider
  const div = document.createElement('div');
  div.style.cssText = 'border-top:1px solid var(--border);margin:6px 0;';
  sb.appendChild(div);

  // Metadata
  const meta = document.createElement('div');
  meta.id = 'vv-meta';
  meta.innerHTML = buildMeta();
  sb.appendChild(meta);

  _shell.setSidebarContent(sb);
  renderNotes();
}

function updateSidebar() {
  const meta = document.getElementById('vv-meta');
  if (meta) meta.innerHTML = buildMeta();
}

function buildMeta() {
  const ext = (_file.name || '').split('.').pop().toUpperCase();
  const dur = _video && _video.duration ? fmtTime(_video.duration) : '\u2014';
  return metaRow('File', _shell.escHtml(_file.name))
    + metaRow('Format', ext)
    + metaRow('Duration', dur);
}

function metaRow(key, val) {
  return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-muted);">' + key + '</span><span style="color:var(--text);">' + val + '</span></div>';
}

// ── Agent context ──────────────────────────────────────────────
function updateContext() {
  const ext = (_file.name || '').split('.').pop().toUpperCase();
  const dur = _video && _video.duration ? fmtTime(_video.duration) : 'unknown';
  _shell.setContext({
    label: _file.name,
    text: 'Video file: ' + _file.name + ' | Format: ' + ext + ' | Duration: ' + dur,
  });
}

// ── Register ───────────────────────────────────────────────────
window.Viewers = window.Viewers || {};
window.Viewers.video = { mount, cleanup };

})();
