'use strict';
/* ═══════════════════════════════════════════════════════════════
   AudioViewer.js — Waveform playback with WaveSurfer.js
   ═══════════════════════════════════════════════════════════════ */

(function () {

const WS_SRC = 'https://unpkg.com/wavesurfer.js@7.8.6/dist/wavesurfer.min.js';

let _shell = null;
let _ws    = null;   // WaveSurfer instance
let _file  = null;
let _speed = 1;
let _loop  = false;
let _ready = false;

// ── Mount ──────────────────────────────────────────────────────
function mount(centerEl, file, shell) {
  _shell = shell; _file = file; _ws = null; _speed = 1; _loop = false; _ready = false;
  centerEl.innerHTML = '';

  // --- Layout ---
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;padding:32px 0;width:100%;';

  // Waveform
  const waveDiv = document.createElement('div');
  waveDiv.id = 'av-wave';
  waveDiv.style.cssText = 'width:100%;max-width:90%;height:128px;margin:0 auto;border-radius:6px;overflow:hidden;background:var(--surface2);';
  wrap.appendChild(waveDiv);

  // Controls row
  const ctrlRow = document.createElement('div');
  ctrlRow.style.cssText = 'display:flex;align-items:center;gap:14px;';
  const playBtn = document.createElement('button');
  playBtn.id = 'av-play';
  playBtn.style.cssText = 'width:40px;height:40px;border-radius:50%;border:none;background:var(--accent);color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
  playBtn.innerHTML = '&#9654;';
  playBtn.addEventListener('click', togglePlay);
  const timeLabel = document.createElement('span');
  timeLabel.id = 'av-time';
  timeLabel.style.cssText = 'font-size:13px;color:var(--text-sec);font-variant-numeric:tabular-nums;min-width:100px;text-align:center;';
  timeLabel.textContent = '0:00 / 0:00';
  ctrlRow.appendChild(playBtn); ctrlRow.appendChild(timeLabel);
  wrap.appendChild(ctrlRow);

  // Speed row
  const speedRow = document.createElement('div');
  speedRow.id = 'av-speeds';
  speedRow.style.cssText = 'display:flex;gap:6px;';
  [0.5, 1, 1.5, 2].forEach(s => {
    const btn = document.createElement('button');
    btn.textContent = s + 'x';
    btn.dataset.speed = s;
    btn.style.cssText = 'padding:4px 10px;border-radius:4px;border:1px solid var(--border2);background:' + (s === 1 ? 'var(--accent)' : 'var(--surface2)') + ';color:var(--text);font-size:11px;cursor:pointer;';
    btn.addEventListener('click', () => setSpeed(s));
    speedRow.appendChild(btn);
  });
  wrap.appendChild(speedRow);

  centerEl.appendChild(wrap);

  setupToolbar();
  setupSidebar();
  loadWaveSurfer(waveDiv, file.url);
}

function cleanup() {
  if (_ws) { try { _ws.destroy(); } catch {} _ws = null; }
  _ready = false;
}

// ── WaveSurfer ─────────────────────────────────────────────────
async function loadWaveSurfer(container, url) {
  await _shell.loadScript(WS_SRC);
  _ws = WaveSurfer.create({
    container: container,
    waveColor: 'rgba(255,255,255,0.5)',
    progressColor: '#4A90D9',
    cursorColor: '#4A90D9',
    height: 128,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    backend: 'WebAudio',
  });
  _ws.load(url);
  _ws.on('ready', () => { _ready = true; updateTime(); updateSidebar(); updateContext(); });
  _ws.on('audioprocess', updateTime);
  _ws.on('seeking', updateTime);
  _ws.on('play', updatePlayState);
  _ws.on('pause', updatePlayState);
  _ws.on('finish', () => { if (_loop) _ws.play(); else updatePlayState(); });
}

// ── Playback helpers ───────────────────────────────────────────
function togglePlay() { if (!_ws) return; _ws.playPause(); }

function updatePlayState() {
  const playing = _ws && _ws.isPlaying();
  const btn = document.getElementById('av-play');
  if (btn) btn.innerHTML = playing ? '&#9208;' : '&#9654;';
  // Toolbar mirror
  const tbBtn = document.getElementById('av-tb-play');
  if (tbBtn) tbBtn.textContent = playing ? 'Pause \u23F8' : 'Play \u25B6';
}

function updateTime() {
  if (!_ws) return;
  const cur = _ws.getCurrentTime();
  const dur = _ws.getDuration();
  const lbl = document.getElementById('av-time');
  if (lbl) lbl.textContent = fmtTime(cur) + ' / ' + fmtTime(dur);
}

function setSpeed(s) {
  _speed = s;
  if (_ws) _ws.setPlaybackRate(s);
  const row = document.getElementById('av-speeds');
  if (row) row.querySelectorAll('button').forEach(b => {
    b.style.background = parseFloat(b.dataset.speed) === s ? 'var(--accent)' : 'var(--surface2)';
  });
  const tbLbl = document.getElementById('av-tb-speed');
  if (tbLbl) tbLbl.textContent = 'Speed: ' + s + 'x';
}

function fmtTime(sec) {
  if (!sec || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// ── Toolbar ────────────────────────────────────────────────────
function setupToolbar() {
  _shell.setToolbarTabs([
    { name: 'Playback', id: 'playback', onActivate: showBand },
  ]);
  showBand();
}

function showBand() {
  const el = document.createElement('div');
  el.className = 'pvr-group';
  el.style.cssText = 'display:flex;align-items:center;gap:8px;';
  el.innerHTML = '<button id="av-tb-play" style="padding:4px 10px;border-radius:4px;border:1px solid var(--border2);background:var(--surface2);color:var(--text);font-size:12px;cursor:pointer;">Play \u25B6</button>'
    + '<div class="pvr-sep"></div>'
    + '<span id="av-tb-speed" style="font-size:11px;color:var(--text-sec);">Speed: ' + _speed + 'x</span>'
    + '<div class="pvr-sep"></div>'
    + '<button id="av-tb-loop" style="padding:4px 10px;border-radius:4px;border:1px solid var(--border2);background:' + (_loop ? 'var(--accent)' : 'var(--surface2)') + ';color:var(--text);font-size:12px;cursor:pointer;">Loop</button>';
  _shell.setToolbarBandEl(el);
  el.querySelector('#av-tb-play').addEventListener('click', togglePlay);
  el.querySelector('#av-tb-loop').addEventListener('click', () => {
    _loop = !_loop;
    const btn = document.getElementById('av-tb-loop');
    if (btn) btn.style.background = _loop ? 'var(--accent)' : 'var(--surface2)';
  });
}

// ── Sidebar ────────────────────────────────────────────────────
function setupSidebar() {
  const sb = document.createElement('div');
  sb.id = 'av-sidebar';
  sb.style.cssText = 'padding:12px;font-size:11px;color:var(--text-sec);display:flex;flex-direction:column;gap:6px;';
  sb.innerHTML = buildMeta();
  _shell.setSidebarContent(sb);
}

function updateSidebar() {
  const sb = document.getElementById('av-sidebar');
  if (sb) sb.innerHTML = buildMeta();
}

function buildMeta() {
  const ext = (_file.name || '').split('.').pop().toUpperCase();
  const dur = _ws && _ready ? fmtTime(_ws.getDuration()) : '\u2014';
  const status = _ready ? 'Ready' : 'Loading\u2026';
  return metaRow('File', _shell.escHtml(_file.name))
    + metaRow('Format', ext)
    + metaRow('Duration', dur)
    + metaRow('Status', status);
}

function metaRow(key, val) {
  return '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);"><span style="color:var(--text-muted);">' + key + '</span><span style="color:var(--text);">' + val + '</span></div>';
}

// ── Agent context ──────────────────────────────────────────────
function updateContext() {
  const ext = (_file.name || '').split('.').pop().toUpperCase();
  const dur = _ws && _ready ? fmtTime(_ws.getDuration()) : 'unknown';
  _shell.setContext({
    label: _file.name,
    text: 'Audio file: ' + _file.name + ' | Format: ' + ext + ' | Duration: ' + dur,
  });
}

// ── Register ───────────────────────────────────────────────────
window.Viewers = window.Viewers || {};
window.Viewers.audio = { mount, cleanup };

})();
