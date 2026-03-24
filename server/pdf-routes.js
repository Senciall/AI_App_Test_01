'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fsSync  = require('fs');

const db                      = require('./db');
const worker                  = require('./pdf-worker');
const { embedText }           = require('./embeddings');
const { workerBus, getDocLog } = worker;

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// Ensure uploads dir exists
if (!fsSync.existsSync(UPLOADS_DIR)) fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, fileFilter: (_req, file, cb) => {
  cb(null, file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf'));
}});

const router = express.Router();

// ── POST /api/pdf/upload ──────────────────────────────────────
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

  const filepath = req.file.path;
  const filename = req.file.originalname;

  // Check if already indexed and ready
  const existing = db.findByFilepath(filepath);
  if (existing && existing.status === 'ready') {
    return res.json({ id: existing.id, status: existing.status });
  }

  const docId = db.insertDocument(filename, filepath);
  setImmediate(() => worker.processDocument(docId, filepath));
  res.json({ id: docId, status: 'queued' });
});

// ── POST /api/pdf/register ────────────────────────────────────
// Register a PDF already on disk (opened from the file tree)
router.post('/register', express.json(), (req, res) => {
  const { filepath, filename } = req.body;
  if (!filepath) return res.status(400).json({ error: 'filepath required' });

  // Return existing record if already indexed
  const existing = db.findByFilepath(filepath);
  if (existing) {
    // Re-process if previous attempt failed
    if (existing.status === 'error') {
      db.updateDocument(existing.id, { status: 'queued' });
      setImmediate(() => worker.processDocument(existing.id, filepath));
      return res.json({ id: existing.id, status: 'queued' });
    }
    return res.json({ id: existing.id, status: existing.status });
  }

  // New document — file must exist on disk
  if (!fsSync.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const docId = db.insertDocument(filename || path.basename(filepath), filepath);
  setImmediate(() => worker.processDocument(docId, filepath));
  res.json({ id: docId, status: 'queued' });
});

// ── GET /api/pdf/:id/status ───────────────────────────────────
router.get('/:id/status', (req, res) => {
  const doc = db.getDocument(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json({ id: doc.id, status: doc.status, page_count: doc.page_count });
});

// ── GET /api/pdf/:id/page/:n ──────────────────────────────────
router.get('/:id/page/:n', (req, res) => {
  const docId = Number(req.params.id);
  const page  = Number(req.params.n);
  if (!db.getDocument(docId)) return res.status(404).json({ error: 'Not found' });
  const blocks = db.getPageBlocks(docId, page);
  res.json({ blocks });
});

// ── POST /api/pdf/:id/search ──────────────────────────────────
router.post('/:id/search', express.json(), async (req, res) => {
  const docId = Number(req.params.id);
  if (!db.getDocument(docId)) return res.status(404).json({ error: 'Not found' });

  const { query = '', mode = 'keyword' } = req.body;
  if (!query.trim()) return res.json({ blocks: [], mode });

  if (mode === 'semantic') {
    try {
      const emb = await embedText(query);
      if (emb) {
        const blocks = db.searchSemantic(docId, emb, 5);
        return res.json({ blocks, mode: 'semantic' });
      }
    } catch { /* fall through to keyword */ }
  }

  const blocks = db.searchKeyword(docId, query);
  res.json({ blocks, mode: 'keyword' });
});

// ── GET /api/pdf/:id/progress  (SSE live parsing feed) ───────
router.get('/:id/progress', (req, res) => {
  const docId = Number(req.params.id);

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  function send(event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // Replay stored events so late joiners catch up
  const log = getDocLog(docId);
  for (const ev of log.events) send(ev);
  if (log.closed) { res.end(); return; }

  // Subscribe to future events
  const channel = `doc:${docId}`;
  function onEvent(event) {
    send(event);
    if (event.type === 'error' || (event.type === 'embed' && event.phase === 'done')) {
      res.end();
    }
  }

  workerBus.on(channel, onEvent);
  req.on('close', () => workerBus.off(channel, onEvent));
});

// ── GET /api/pdf/:id/outline ──────────────────────────────────
router.get('/:id/outline', (req, res) => {
  const docId = Number(req.params.id);
  if (!db.getDocument(docId)) return res.status(404).json({ error: 'Not found' });
  res.json({ blocks: db.getOutline(docId) });
});

// ── GET /api/pdf/:id/context ──────────────────────────────────
// Returns selected block (by text) + top similar blocks — for agent context injection
router.get('/:id/context', async (req, res) => {
  const docId = Number(req.params.id);
  if (!db.getDocument(docId)) return res.status(404).json({ error: 'Not found' });

  const { text = '' } = req.query;
  if (!text.trim()) return res.json({ blocks: [] });

  // Try semantic first, fall back to keyword
  let similar = [];
  try {
    const emb = await embedText(text);
    if (emb) {
      similar = db.searchSemantic(docId, emb, 4);
      // Remove the block that is identical to the selected text (it'll be first)
      similar = similar.filter(b => b.text !== text).slice(0, 3);
    }
  } catch { /* ignore */ }

  if (!similar.length) {
    // keyword fallback — take words from the selection
    const words = text.split(/\s+/).slice(0, 3).join(' ');
    similar = db.searchKeyword(docId, words)
      .filter(b => b.text !== text)
      .slice(0, 3);
  }

  res.json({ blocks: similar });
});

// ══════════════════════════════════════════════════════════════════
//  ANNOTATION CRUD
// ══════════════════════════════════════════════════════════════════

router.post('/:docId/annotations', express.json(), (req, res) => {
  const { docId } = req.params;
  const { pages } = req.body;
  if (!pages) return res.status(400).json({ error: 'Missing pages' });
  try {
    db.saveAnnotations(docId, pages);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:docId/annotations', (req, res) => {
  const { docId } = req.params;
  try {
    const pages = db.getAnnotations(docId);
    res.json({ pages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:docId/annotations', (req, res) => {
  const { docId } = req.params;
  try {
    db.deleteAnnotations(docId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
