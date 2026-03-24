'use strict';

const path   = require('path');
const http   = require('http');
const events = require('events');
const db     = require('./db');

const { embedText } = require('./embeddings');

// ── Event bus — SSE clients subscribe here ────────────────────
const workerBus = new events.EventEmitter();
workerBus.setMaxListeners(100);

// Per-document event log for late-joining SSE clients
const docLogs = new Map(); // docId → { events: [], closed: bool }

function emit(docId, event) {
  const log = docLogs.get(docId);
  if (log) log.events.push(event);
  workerBus.emit(`doc:${docId}`, event);
}

function openLog(docId)  { docLogs.set(docId, { events: [], closed: false }); }
function closeLog(docId) {
  const log = docLogs.get(docId);
  if (log) log.closed = true;
  // Garbage-collect after 10 min
  setTimeout(() => docLogs.delete(docId), 10 * 60 * 1000);
}

function getDocLog(docId) {
  return docLogs.get(docId) || { events: [], closed: true };
}

// ── pdfjs-dist (Node/legacy build, ESM via dynamic import) ───
let _pdfjs = null;
async function getPdfjs() {
  if (!_pdfjs) {
    // pdfjs-dist 4.x is ESM-only — use dynamic import from CJS
    _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return _pdfjs;
}

// ── Block detection (ported from pdf-viewer.js pvBuildBlocks) ─
function buildBlocks(rawItems, pageWidth, pageHeight) {
  // rawItems: TextItem[] from pdfjs getTextContent()
  // Each item: { str, transform: [a,b,c,d,e,f], width, height }
  // We work in page coordinate space (origin bottom-left), convert to top-left
  const items = rawItems
    .filter(it => it.str?.trim())
    .map(it => {
      const [a, b, , d, e, f] = it.transform;
      const fontH = Math.sqrt(a * a + b * b);
      if (fontH < 1) return null;
      const x = e;
      const y = pageHeight - f;           // flip y to top-left origin
      const w = it.width  || fontH * it.str.length * 0.55;
      return { str: it.str, x, y, w, h: fontH, fontH };
    })
    .filter(Boolean);

  if (!items.length) return [];

  // Sort top → bottom, left → right within same line (2 px tolerance)
  items.sort((a, b) => Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y);

  const heights  = items.map(i => i.h).sort((a, b) => a - b);
  const avgH     = heights.reduce((s, v) => s + v, 0) / heights.length;
  const medianH  = heights[Math.floor(heights.length / 2)];

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
  if (cur) rawGroups.push(cur);

  // Merge horizontally adjacent groups on the same line
  const merged = [];
  for (const g of rawGroups) {
    const last = merged[merged.length - 1];
    if (
      last &&
      Math.abs(g[0].y - last[last.length - 1].y) < avgH * 1.2 &&
      g[0].x > last[last.length - 1].x
    ) {
      last.push(...g);
    } else {
      merged.push(g);
    }
  }

  // Classify and build block objects
  return merged
    .filter(g => g.length > 0)
    .map((g, idx) => {
      const text  = g.map(i => i.str).join(' ').trim();
      const avgFH = g.reduce((s, i) => s + i.fontH, 0) / g.length;
      const x1    = Math.min(...g.map(i => i.x));
      const y1    = Math.min(...g.map(i => i.y));
      const x2    = Math.max(...g.map(i => i.x + i.w));
      const y2    = Math.max(...g.map(i => i.y + i.h));
      const type  = classifyBlock(g, avgFH, medianH, avgH);
      return { text, type, bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, fontSize: avgFH, readingOrder: idx };
    });
}

function classifyBlock(items, avgFH, medianH) {
  if (avgFH > medianH * 1.25) return 'heading';
  // table heuristic: many items spread across distinct X columns
  const xBuckets = new Set(items.map(i => Math.round(i.x / 20) * 20));
  if (items.length >= 6 && xBuckets.size >= 3) return 'table';
  // figure/caption heuristic
  const figRe = /^(fig(ure)?|table|chart|diagram|image|photo|plate)[\s.]/i;
  if (items.length <= 5 && figRe.test(items[0]?.str || '')) return 'figure';
  return 'paragraph';
}

// ── Ollama helpers ────────────────────────────────────────────

const OLLAMA_BASE = 'http://127.0.0.1:11434';

function ollamaRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request(`${OLLAMA_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad Ollama response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(json);
    req.end();
  });
}

async function summarizeBlock(text, model = 'gemma3:latest') {
  try {
    const res = await ollamaRequest('/api/chat', {
      model,
      messages: [
        { role: 'system', content: 'Summarize the following text in exactly one sentence. Return only the sentence, no preamble.' },
        { role: 'user',   content: text }
      ],
      stream: false,
      options: { temperature: 0.1, num_ctx: 1024 }
    });
    return res?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// ── Main pipeline ─────────────────────────────────────────────

async function processDocument(docId, filepath) {
  db.updateDocument(docId, { status: 'analyzing' });
  openLog(docId);

  const filename = path.basename(filepath);
  const t0 = Date.now();
  let totalBlocks = 0;

  try {
    const pdfjs = await getPdfjs();

    const loadingTask = pdfjs.getDocument({
      url: filepath,
      disableAutoFetch: true,
      disableStream: true,
      isEvalSupported: false,
    });
    const pdfDoc   = await loadingTask.promise;
    const numPages = pdfDoc.numPages;

    emit(docId, { type: 'start', docId, filename, pages: numPages });

    for (let n = 1; n <= numPages; n++) {
      const page       = await pdfDoc.getPage(n);
      const viewport   = page.getViewport({ scale: 1 });
      const content    = await page.getTextContent();
      const blocks     = buildBlocks(content.items, viewport.width, viewport.height);

      const pageId = db.insertPage(docId, n, viewport.width, viewport.height);
      const types  = { heading: 0, paragraph: 0, table: 0, figure: 0 };

      for (const block of blocks) {
        if (!block.text.trim()) continue;
        db.insertBlock(pageId, docId, block.type, block.text, block.bbox, block.fontSize, block.readingOrder);
        types[block.type] = (types[block.type] || 0) + 1;
        totalBlocks++;
      }

      emit(docId, { type: 'page', docId, page: n, total: numPages, blocks: blocks.length, types });
    }

    db.updateDocument(docId, { status: 'ready', page_count: numPages });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    emit(docId, { type: 'done', docId, totalBlocks, elapsed });
    console.log(`[pdf-worker] doc ${docId} ready — ${totalBlocks} blocks in ${elapsed}s`);

    setImmediate(() => generateEmbeddings(docId));

  } catch (err) {
    console.error(`[pdf-worker] doc ${docId} failed:`, err.message);
    db.updateDocument(docId, { status: 'error' });
    emit(docId, { type: 'error', docId, message: err.message });
    closeLog(docId);
  }
}

async function generateEmbeddings(docId) {
  const rows = db.getAllBlocksWithEmbeddings(docId);
  const test = await embedText('test');
  if (!test) {
    closeLog(docId);
    return;
  }

  emit(docId, { type: 'embed', docId, phase: 'start', total: rows.length });
  let done = 0;
  for (const row of rows) {
    if (row.embedding) { done++; continue; }
    const emb = await embedText(row.text);
    if (emb) { db.updateBlockEmbedding(row.id, emb); done++; }
    if (done % 10 === 0) {
      emit(docId, { type: 'embed', docId, phase: 'progress', done, total: rows.length });
    }
  }
  emit(docId, { type: 'embed', docId, phase: 'done', done, total: rows.length });
  console.log(`[pdf-worker] embeddings done for doc ${docId}`);
  closeLog(docId);
}

async function generateSummaries(docId) {
  const rows = db.getAllBlocksWithEmbeddings(docId);
  const toSummarize = rows.filter(r => r.type === 'heading' || (r.type === 'paragraph' && r.text.length > 200));
  for (const row of toSummarize) {
    const summary = await summarizeBlock(row.text);
    if (summary) db.updateBlockSummary(row.id, summary);
  }
  console.log(`[pdf-worker] summaries done for doc ${docId}`);
}

module.exports = { processDocument, workerBus, getDocLog };
