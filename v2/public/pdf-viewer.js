'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
const pv = {
  pdfDoc:      null,
  pdfName:     '',
  scale:       1.5,
  blockMode:   true,
  blocks:      {},      // pageNum → Block[]
  selected:    null,    // { block, el } | null
  contextBlock: null,   // Block set via "Ask agent" pill
  messages:    [],      // Ollama message history
  streaming:   false,
};

// ── pdfjsLib loaded lazily ─────────────────────────────────────────────────────
let _pdfjs = null;

async function pvEnsurePdfjs() {
  if (_pdfjs) return;
  await new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = PDFJS_SRC;
    s.onload = ok; s.onerror = fail;
    document.head.appendChild(s);
  });
  _pdfjs = window.pdfjsLib;
  _pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
}

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  pvInitSidebar();
  pvInitZoom();
  pvInitModeToggle();
  pvInitUpload();
  pvInitAgentInput();
  pvInitModels();
  pvInitKeyboard();

  // Reposition floating action bar on scroll
  document.getElementById('pv-pages').addEventListener('scroll', () => {
    const bar = document.getElementById('pv-action-bar');
    if (bar && pv.selected) pvPositionActionBar(bar, pv.selected.el);
  }, { passive: true });
});

// ══════════════════════════════════════════════════════════════════════════════
//  LEFT SIDEBAR
// ══════════════════════════════════════════════════════════════════════════════

async function pvInitSidebar() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    const dir = cfg.dir || cfg.filesDir;
    if (!dir) return;
    const tree = await fetch('/api/files?dir=' + encodeURIComponent(dir)).then(r => r.json());
    const pdfs = pvCollectPdfs(Array.isArray(tree) ? tree : [tree]);
    pvRenderDocList(pdfs);
  } catch { /* no files dir configured yet */ }
}

function pvCollectPdfs(nodes, out = []) {
  for (const n of nodes) {
    if (!n.isDirectory && n.name?.toLowerCase().endsWith('.pdf')) out.push(n);
    if (n.isDirectory && n.children) pvCollectPdfs(n.children, out);
  }
  return out;
}

function pvRenderDocList(pdfs) {
  const list = document.getElementById('pv-doc-list');
  list.innerHTML = '';
  if (!pdfs.length) {
    list.innerHTML = '<div class="pv-doc-empty">No PDFs found in your files directory</div>';
    return;
  }
  pdfs.forEach(pdf => {
    const item = document.createElement('div');
    item.className = 'pv-doc-item';
    item.textContent = pdf.name;
    item.title = pdf.path;
    item.addEventListener('click', () => {
      document.querySelectorAll('.pv-doc-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      pvOpenPath(pdf.path, pdf.name);
    });
    list.appendChild(item);
  });
}

// ── File upload ──────────────────────────────────────────────────────────────

function pvInitUpload() {
  document.getElementById('pv-file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) pvOpenFile(file);
    e.target.value = '';
  });
}

function pvHandleDrop(e) {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.pdf')) pvOpenFile(file);
}

async function pvOpenFile(file) {
  pv.pdfName = file.name;
  const url = URL.createObjectURL(file);
  await pvLoad(url);
}

async function pvOpenPath(path, name) {
  pv.pdfName = name;
  const url = '/api/files/serve?path=' + encodeURIComponent(path);
  await pvLoad(url);
}

// ══════════════════════════════════════════════════════════════════════════════
//  PDF LOADING & RENDERING
// ══════════════════════════════════════════════════════════════════════════════

async function pvLoad(url) {
  pvClearSelection();
  pv.blocks = {};
  pv.pdfDoc = null;

  const pages = document.getElementById('pv-pages');
  pages.innerHTML = '<div class="pv-loading">Loading…</div>';
  document.getElementById('pv-doc-name-display').textContent = pv.pdfName;
  document.getElementById('pv-page-info').textContent = '—';

  try {
    await pvEnsurePdfjs();
    pv.pdfDoc = await _pdfjs.getDocument(url).promise;
    pages.innerHTML = '';

    for (let n = 1; n <= pv.pdfDoc.numPages; n++) {
      await pvRenderPage(n);
    }
    pvUpdatePageInfo(1);
  } catch (err) {
    pages.innerHTML = `<div class="pv-error">Failed to load PDF: ${err.message}</div>`;
  }
}

async function pvRenderPage(pageNum) {
  const page = await pv.pdfDoc.getPage(pageNum);
  const vp   = page.getViewport({ scale: pv.scale });

  // Wrapper
  const wrap = document.createElement('div');
  wrap.className = 'pv-page-wrap';
  wrap.dataset.pageNum = pageNum;
  wrap.style.width  = vp.width  + 'px';
  wrap.style.height = vp.height + 'px';

  // Canvas
  const canvas = document.createElement('canvas');
  canvas.className = 'pv-canvas';
  canvas.width  = vp.width;
  canvas.height = vp.height;
  wrap.appendChild(canvas);

  // Block layer (absolute overlay container)
  const layer = document.createElement('div');
  layer.className = 'pv-block-layer';
  wrap.appendChild(layer);

  document.getElementById('pv-pages').appendChild(wrap);

  // Render PDF page
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

  // Build blocks
  if (pv.blockMode) {
    const textContent = await page.getTextContent();
    const blocks = pvBuildBlocks(textContent.items, vp, pageNum);
    pv.blocks[pageNum] = blocks;
    blocks.forEach(b => { b.el = pvCreateBlockEl(b, layer); });
  }

  // Click on canvas/wrapper deselects
  wrap.addEventListener('click', e => {
    if (!e.target.closest('.pv-block')) pvClearSelection();
  });

  // Intersection observer for page indicator
  const io = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) pvUpdatePageInfo(pageNum);
  }, { root: document.getElementById('pv-pages'), threshold: 0.4 });
  io.observe(wrap);
}

// ══════════════════════════════════════════════════════════════════════════════
//  BLOCK DETECTION
// ══════════════════════════════════════════════════════════════════════════════

function pvBuildBlocks(rawItems, vp, pageNum) {
  // Map items to screen space using the combined transform
  const items = rawItems
    .filter(it => it.str?.trim())
    .map(it => {
      const tx   = _pdfjs.Util.transform(vp.transform, it.transform);
      const fontH = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
      if (fontH < 1) return null;
      const w = (it.width  || 0) * pv.scale || fontH * it.str.length * 0.55;
      return { str: it.str, x: tx[4], y: tx[5] - fontH, w, h: fontH, fontH };
    })
    .filter(Boolean);

  if (!items.length) return [];

  // Sort top → bottom, left → right within the same line (within 2 px)
  items.sort((a, b) => Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y);

  // Average and median font heights
  const avgH    = items.reduce((s, i) => s + i.h, 0) / items.length;
  const sortedH = items.map(i => i.h).sort((a, b) => a - b);
  const medianH = sortedH[Math.floor(sortedH.length / 2)];

  // Group by Y-gap > 1.5 × avgH
  const rawGroups = [];
  let cur = null;
  for (const item of items) {
    if (!cur) { cur = [item]; continue; }
    const last = cur[cur.length - 1];
    const gap  = item.y - (last.y + last.h);
    if (gap > 1.5 * avgH) { rawGroups.push(cur); cur = [item]; }
    else cur.push(item);
  }
  if (cur?.length) rawGroups.push(cur);

  // Build block objects
  const blocks = [];
  rawGroups.forEach((grp, idx) => {
    const text = grp.map(i => i.str).join(' ').trim();
    if (!text) return;

    const x1 = Math.min(...grp.map(i => i.x));
    const y1 = Math.min(...grp.map(i => i.y));
    const x2 = Math.max(...grp.map(i => i.x + i.w));
    const y2 = Math.max(...grp.map(i => i.y + i.h));
    if (x2 <= x1 || y2 <= y1) return;

    const type = pvClassifyBlock(grp, medianH);
    blocks.push({
      id: `p${pageNum}b${idx}`,
      blockIdx: idx + 1,
      pageNum,
      type,
      text,
      x1, y1, x2, y2,
      el: null,
    });
  });

  return blocks;
}

function pvClassifyBlock(grp, medianH) {
  const avgFont = grp.reduce((s, i) => s + i.h, 0) / grp.length;

  // Heading: dominant font > 1.25× median
  if (avgFont > medianH * 1.25) return 'heading';

  // Table: ≥3 distinct X-column buckets (rounded to 20px) and ≥6 items
  if (grp.length >= 6) {
    const cols = new Set(grp.map(i => Math.round(i.x / 20) * 20));
    if (cols.size >= 3) return 'table';
  }

  // Figure: short block containing a figure/caption label
  if (grp.length <= 5 && /\b(fig(ure)?|plate|diagram|chart|table)\s*\.?\s*\d+/i.test(
    grp.map(i => i.str).join(' ')
  )) return 'figure';

  return 'paragraph';
}

// ══════════════════════════════════════════════════════════════════════════════
//  BLOCK OVERLAY ELEMENTS
// ══════════════════════════════════════════════════════════════════════════════

const PAD = 3;

function pvCreateBlockEl(block, layer) {
  const div = document.createElement('div');
  div.className = `pv-block pv-type-${block.type}`;
  div.style.left   = (block.x1 - PAD) + 'px';
  div.style.top    = (block.y1 - PAD) + 'px';
  div.style.width  = (block.x2 - block.x1 + PAD * 2) + 'px';
  div.style.height = (block.y2 - block.y1 + PAD * 2) + 'px';
  div.title = block.text.slice(0, 100);

  div.addEventListener('click', e => { e.stopPropagation(); pvSelectBlock(block, div); });
  layer.appendChild(div);
  return div;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SELECTION
// ══════════════════════════════════════════════════════════════════════════════

function pvSelectBlock(block, el) {
  // Deselect previous
  if (pv.selected) {
    pv.selected.el.classList.remove('pv-selected');
  }
  pvRemoveActionBar();

  pv.selected = { block, el };
  el.classList.add('pv-selected');
  pvShowActionBar(block, el);
}

function pvClearSelection() {
  if (pv.selected) {
    pv.selected.el.classList.remove('pv-selected');
    pv.selected = null;
  }
  pvRemoveActionBar();
}

// ══════════════════════════════════════════════════════════════════════════════
//  FLOATING ACTION BAR
// ══════════════════════════════════════════════════════════════════════════════

function pvShowActionBar(block, el) {
  pvRemoveActionBar();

  const bar = document.createElement('div');
  bar.id = 'pv-action-bar';

  const actions = [
    { label: 'Ask agent', icon: '✦', fn: () => pvAskAgent(block)    },
    null, // separator
    { label: 'Edit',      icon: '✎', fn: () => pvEditBlock(block)   },
    { label: 'Copy',      icon: '⎘', fn: () => pvCopyBlock(block, bar) },
    { label: 'Comment',   icon: '✍', fn: () => pvCommentBlock(block) },
  ];

  actions.forEach(a => {
    if (!a) {
      const sep = document.createElement('div');
      sep.className = 'pv-ab-sep';
      bar.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'pv-ab-btn';
    btn.dataset.action = a.label;
    btn.innerHTML = `<span class="pv-ab-icon">${a.icon}</span>${a.label}`;
    btn.addEventListener('click', e => { e.stopPropagation(); a.fn(); });
    bar.appendChild(btn);
  });

  document.body.appendChild(bar);
  // rAF ensures the bar is laid out so offsetWidth is accurate
  requestAnimationFrame(() => pvPositionActionBar(bar, el));
}

function pvPositionActionBar(bar, el) {
  const r   = el.getBoundingClientRect();
  const barH = 34; // approx bar height
  const gap  = 8;

  let top  = r.top - gap - barH;
  let left = r.left;

  // If bar goes above viewport, flip below the block
  if (top < 4) top = r.bottom + gap;

  // Clamp right edge
  const barW = bar.offsetWidth || 260;
  if (left + barW > window.innerWidth - 8) left = window.innerWidth - barW - 8;
  if (left < 8) left = 8;

  bar.style.top  = top  + 'px';
  bar.style.left = left + 'px';
}

function pvRemoveActionBar() {
  const b = document.getElementById('pv-action-bar');
  if (b) b.remove();
}

// ══════════════════════════════════════════════════════════════════════════════
//  BLOCK ACTIONS
// ══════════════════════════════════════════════════════════════════════════════

function pvBlockLabel(block) {
  const name  = (pv.pdfName || 'Doc').replace(/\.pdf$/i, '');
  const short = name.length > 14 ? name.slice(0, 14) + '…' : name;
  const sym   = { paragraph: '¶', heading: 'H', figure: 'Fig', table: 'Tbl' }[block.type] || '¶';
  return `${short} ${sym}${block.blockIdx}, p.${block.pageNum}`;
}

// "Ask agent" — inject context pill, focus input
function pvAskAgent(block) {
  pv.contextBlock = block;
  pvRenderPill(block);
  document.getElementById('pv-input').focus();
}

// "Edit" — pre-fill agent input with edit intent
function pvEditBlock(block) {
  pvAskAgent(block);
  document.getElementById('pv-input').value = 'Edit this to be more concise: ';
  pvAutoResizeInput();
  document.getElementById('pv-input').focus();
}

// "Copy" — clipboard + brief visual ack on the button
function pvCopyBlock(block, bar) {
  const text = block.text;
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  };
  (navigator.clipboard?.writeText(text) || Promise.reject()).catch(fallback);

  const btn = bar?.querySelector('[data-action="Copy"]');
  if (btn) {
    btn.innerHTML = '<span class="pv-ab-icon">✓</span>Copied!';
    setTimeout(() => {
      if (btn.parentNode) btn.innerHTML = '<span class="pv-ab-icon">⎘</span>Copy';
    }, 1400);
  }
}

// "Comment" — open agent input with comment prefix
function pvCommentBlock(block) {
  pvAskAgent(block);
  const inp = document.getElementById('pv-input');
  inp.value = 'Add a comment: ';
  pvAutoResizeInput();
  inp.focus();
}

// ══════════════════════════════════════════════════════════════════════════════
//  CONTEXT PILL
// ══════════════════════════════════════════════════════════════════════════════

function pvRenderPill(block) {
  const row = document.getElementById('pv-pill-row');
  row.innerHTML = '';

  const pill = document.createElement('div');
  pill.className = 'pv-context-pill';

  const label = document.createElement('span');
  label.className = 'pv-pill-label';
  label.textContent = pvBlockLabel(block);

  const x = document.createElement('button');
  x.className = 'pv-pill-x';
  x.textContent = '×';
  x.title = 'Dismiss context';
  x.addEventListener('click', () => { pv.contextBlock = null; row.innerHTML = ''; });

  pill.appendChild(label);
  pill.appendChild(x);
  row.appendChild(pill);
}

// ══════════════════════════════════════════════════════════════════════════════
//  AGENT CHAT
// ══════════════════════════════════════════════════════════════════════════════

function pvInitAgentInput() {
  const inp = document.getElementById('pv-input');
  inp.addEventListener('input', pvAutoResizeInput);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pvSend(); }
  });
  document.getElementById('pv-send').addEventListener('click', pvSend);
}

function pvAutoResizeInput() {
  const inp = document.getElementById('pv-input');
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
}

async function pvSend() {
  if (pv.streaming) return;
  const inp  = document.getElementById('pv-input');
  const text = inp.value.trim();
  if (!text) return;

  const block      = pv.contextBlock;
  const blockLabel = block ? pvBlockLabel(block) : null;

  // Clear input + pill
  inp.value = ''; pvAutoResizeInput();
  pv.contextBlock = null;
  document.getElementById('pv-pill-row').innerHTML = '';

  // Disable send
  pv.streaming = true;
  document.getElementById('pv-send').disabled = true;

  // Render user message
  pvAppendUser(text, blockLabel);

  // Build messages
  const system = `You are a helpful assistant analyzing a PDF document titled "${pv.pdfName || 'unknown'}". Answer clearly and concisely. For any math, use $...$ (inline) or $$...$$ (display).`;

  const userContent = block
    ? `[Context — ${blockLabel}]:\n"${block.text.slice(0, 1200)}"\n\nQuestion: ${text}`
    : text;

  const model = document.getElementById('pv-model-select').value || 'gemma3:latest';

  const msgs = [
    { role: 'system', content: system },
    ...pv.messages.slice(-12),
    { role: 'user', content: userContent },
  ];

  // Bot bubble (streamed into)
  const { bubble, content: contentEl } = pvAppendAgent(blockLabel);
  bubble.classList.add('pv-streaming-cursor');

  const thread = document.getElementById('pv-thread');
  thread.scrollTop = thread.scrollHeight;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: msgs, stream: true }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            raw += data.message.content;
            contentEl.innerHTML = pvMarkdown(raw);
            thread.scrollTop = thread.scrollHeight;
          }
        } catch { /* partial JSON, skip */ }
      }
    }

    // Final parse
    if (raw) contentEl.innerHTML = pvMarkdown(raw);
    pv.messages.push({ role: 'user', content: userContent });
    pv.messages.push({ role: 'assistant', content: raw });

  } catch (err) {
    contentEl.textContent = `Error: ${err.message}`;
  } finally {
    bubble.classList.remove('pv-streaming-cursor');
    pv.streaming = false;
    document.getElementById('pv-send').disabled = false;
    thread.scrollTop = thread.scrollHeight;
  }
}

// Append user message bubble
function pvAppendUser(text, blockLabel) {
  const thread = document.getElementById('pv-thread');
  const msg = document.createElement('div');
  msg.className = 'pv-msg pv-msg-user';

  if (blockLabel) {
    const ref = document.createElement('div');
    ref.className = 'pv-block-ref';
    ref.textContent = blockLabel;
    msg.appendChild(ref);
  }

  const bubble = document.createElement('div');
  bubble.className = 'pv-bubble';
  bubble.textContent = text;
  msg.appendChild(bubble);

  thread.appendChild(msg);
  thread.scrollTop = thread.scrollHeight;
}

// Append agent bubble, return reference to it
function pvAppendAgent(blockLabel) {
  const thread = document.getElementById('pv-thread');
  const msg = document.createElement('div');
  msg.className = 'pv-msg pv-msg-agent';

  if (blockLabel) {
    const ref = document.createElement('div');
    ref.className = 'pv-block-ref';
    ref.textContent = `re: ${blockLabel}`;
    msg.appendChild(ref);
  }

  const bubble = document.createElement('div');
  bubble.className = 'pv-bubble';
  msg.appendChild(bubble);

  thread.appendChild(msg);
  thread.scrollTop = thread.scrollHeight;
  return { bubble, content: bubble };
}

// Simple Markdown renderer
function pvMarkdown(text) {
  // Escape HTML first
  const esc = s => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Protect code blocks
  const codeBlocks = [];
  let t = text.replace(/```[\s\S]*?```/g, m => {
    codeBlocks.push(m); return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  // Protect inline code
  const inlineCodes = [];
  t = t.replace(/`[^`]+`/g, m => {
    inlineCodes.push(m); return `\x00ICODE${inlineCodes.length - 1}\x00`;
  });
  // Protect math
  const mathBlocks = [];
  t = t.replace(/\$\$[\s\S]+?\$\$/g, m => {
    mathBlocks.push(m); return `\x00MATH${mathBlocks.length - 1}\x00`;
  });
  const mathInlines = [];
  t = t.replace(/\$[^$\n]+\$/g, m => {
    mathInlines.push(m); return `\x00MATHINL${mathInlines.length - 1}\x00`;
  });

  t = esc(t);

  // Restore math (unescaped so KaTeX could render if loaded)
  t = t.replace(/\x00MATH(\d+)\x00/g, (_, i) => mathBlocks[i]);
  t = t.replace(/\x00MATHINL(\d+)\x00/g, (_, i) => mathInlines[i]);

  // Inline formatting
  t = t
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,         '<em>$1</em>')
    .replace(/__(.+?)__/g,         '<strong>$1</strong>')
    .replace(/_(.+?)_/g,           '<em>$1</em>');

  // Restore code
  t = t.replace(/\x00CODE(\d+)\x00/g, (_, i) => {
    const raw = codeBlocks[i];
    const m = raw.match(/^```(\w*)\n?([\s\S]*?)```$/);
    const lang = m?.[1] ? `<span style="font-size:10px;color:#888">${m[1]}</span><br>` : '';
    const code = esc(m?.[2] || raw);
    return `<pre>${lang}<code>${code}</code></pre>`;
  });
  t = t.replace(/\x00ICODE(\d+)\x00/g, (_, i) => {
    const raw = inlineCodes[i];
    return `<code>${esc(raw.slice(1, -1))}</code>`;
  });

  // Lists
  t = t.replace(/^(\s*)[*\-] (.+)$/gm,   '$1<li>$2</li>');
  t = t.replace(/^(\s*)\d+\. (.+)$/gm,   '$1<li>$2</li>');
  t = t.replace(/(<li>.*<\/li>\n?)+/g,    m => `<ul>${m}</ul>`);

  // Headings
  t = t.replace(/^### (.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:13px;color:#c0c0c0">$1</h4>');
  t = t.replace(/^## (.+)$/gm,  '<h3 style="margin:10px 0 5px;font-size:14px;color:#d0d0d0">$1</h3>');
  t = t.replace(/^# (.+)$/gm,   '<h2 style="margin:10px 0 5px;font-size:15px;color:#e0e0e0">$1</h2>');

  // Paragraphs from double newlines
  t = t.split(/\n{2,}/).map(para => {
    if (/^<(h[2-4]|ul|pre|li)/.test(para.trim())) return para;
    return `<p>${para.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return t;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MODEL SELECTOR
// ══════════════════════════════════════════════════════════════════════════════

async function pvInitModels() {
  const sel = document.getElementById('pv-model-select');
  try {
    const data = await fetch('/api/tags').then(r => r.json());
    const models = data.models || [];
    if (!models.length) {
      sel.innerHTML = '<option>gemma3:latest</option>';
      return;
    }
    sel.innerHTML = '';
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = m.name;
      sel.appendChild(opt);
    });
  } catch {
    sel.innerHTML = '<option value="gemma3:latest">gemma3:latest</option>';
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ZOOM
// ══════════════════════════════════════════════════════════════════════════════

function pvInitZoom() {
  document.getElementById('pv-zoom-out').addEventListener('click', () => {
    pv.scale = Math.max(pv.scale - 0.25, 0.5);
    pvRerender();
  });
  document.getElementById('pv-zoom-in').addEventListener('click', () => {
    pv.scale = Math.min(pv.scale + 0.25, 3.5);
    pvRerender();
  });
}

async function pvRerender() {
  if (!pv.pdfDoc) return;
  document.getElementById('pv-zoom-label').textContent = Math.round(pv.scale * 100) + '%';
  pvClearSelection();
  pv.blocks = {};
  const pages = document.getElementById('pv-pages');
  pages.innerHTML = '';
  for (let n = 1; n <= pv.pdfDoc.numPages; n++) await pvRenderPage(n);
}

// ══════════════════════════════════════════════════════════════════════════════
//  MODE TOGGLE
// ══════════════════════════════════════════════════════════════════════════════

function pvInitModeToggle() {
  document.getElementById('pv-btn-blocks').addEventListener('click', () => {
    if (pv.blockMode) return;
    pv.blockMode = true;
    document.getElementById('pv-btn-blocks').classList.add('active');
    document.getElementById('pv-btn-text').classList.remove('active');
    if (pv.pdfDoc) pvRerender();
  });
  document.getElementById('pv-btn-text').addEventListener('click', () => {
    if (!pv.blockMode) return;
    pv.blockMode = false;
    document.getElementById('pv-btn-text').classList.add('active');
    document.getElementById('pv-btn-blocks').classList.remove('active');
    if (pv.pdfDoc) pvRerender();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  KEYBOARD
// ══════════════════════════════════════════════════════════════════════════════

function pvInitKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') pvClearSelection();
    if ((e.key === '+' || e.key === '=') && e.ctrlKey) { e.preventDefault(); document.getElementById('pv-zoom-in').click(); }
    if (e.key === '-' && e.ctrlKey)                    { e.preventDefault(); document.getElementById('pv-zoom-out').click(); }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  PAGE INFO HELPER
// ══════════════════════════════════════════════════════════════════════════════

function pvUpdatePageInfo(pageNum) {
  if (!pv.pdfDoc) return;
  document.getElementById('pv-page-info').textContent =
    `Page ${pageNum} / ${pv.pdfDoc.numPages}`;
}
