'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'myai.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    filename   TEXT    NOT NULL,
    filepath   TEXT    NOT NULL,
    page_count INTEGER DEFAULT 0,
    status     TEXT    DEFAULT 'queued',
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    page_number INTEGER NOT NULL,
    width       REAL,
    height      REAL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS blocks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id       INTEGER NOT NULL,
    document_id   INTEGER NOT NULL,
    type          TEXT    DEFAULT 'paragraph',
    text          TEXT    NOT NULL,
    bbox          TEXT,
    font_size     REAL,
    reading_order INTEGER,
    embedding     BLOB,
    summary       TEXT,
    FOREIGN KEY (page_id)     REFERENCES pages(id)     ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_blocks_doc ON blocks(document_id);
  CREATE INDEX IF NOT EXISTS idx_pages_doc  ON pages(document_id);

  CREATE TABLE IF NOT EXISTS pdf_annotations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id           TEXT    NOT NULL,
    page_num         INTEGER NOT NULL,
    annotations_json TEXT    NOT NULL,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(doc_id, page_num)
  );
`);

// ── Prepared statements ───────────────────────────────────────
const stmts = {
  insertDoc:   db.prepare(`INSERT INTO documents (filename, filepath) VALUES (?, ?)`),
  getDoc:      db.prepare(`SELECT * FROM documents WHERE id = ?`),
  findByPath:  db.prepare(`SELECT * FROM documents WHERE filepath = ? ORDER BY id DESC LIMIT 1`),
  insertPage:  db.prepare(`INSERT INTO pages (document_id, page_number, width, height) VALUES (?, ?, ?, ?)`),
  insertBlock: db.prepare(`
    INSERT INTO blocks (page_id, document_id, type, text, bbox, font_size, reading_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getPageBlocks: db.prepare(`
    SELECT b.*, p.page_number FROM blocks b
    JOIN pages p ON b.page_id = p.id
    WHERE b.document_id = ? AND p.page_number = ?
    ORDER BY b.reading_order
  `),
  getOutline: db.prepare(`
    SELECT b.*, p.page_number FROM blocks b
    JOIN pages p ON b.page_id = p.id
    WHERE b.document_id = ? AND b.type = 'heading'
    ORDER BY p.page_number, b.reading_order
  `),
  keywordSearch: db.prepare(`
    SELECT b.*, p.page_number FROM blocks b
    JOIN pages p ON b.page_id = p.id
    WHERE b.document_id = ? AND b.text LIKE ?
    ORDER BY b.reading_order
    LIMIT 10
  `),
  getAllBlocksForDoc: db.prepare(`
    SELECT b.id, b.embedding, b.text, b.type, b.reading_order, p.page_number
    FROM blocks b
    JOIN pages p ON b.page_id = p.id
    WHERE b.document_id = ?
    ORDER BY p.page_number, b.reading_order
  `),
  updateBlockEmbedding: db.prepare(`UPDATE blocks SET embedding = ? WHERE id = ?`),
  updateBlockSummary:   db.prepare(`UPDATE blocks SET summary = ? WHERE id = ?`),
};

// Dynamic update helper
function buildUpdate(table, id, fields) {
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
}

// ── Exports ───────────────────────────────────────────────────

function insertDocument(filename, filepath) {
  const result = stmts.insertDoc.run(filename, filepath);
  return result.lastInsertRowid;
}

function updateDocument(id, fields) {
  buildUpdate('documents', id, fields);
}

function getDocument(id) {
  return stmts.getDoc.get(id) || null;
}

function findByFilepath(filepath) {
  return stmts.findByPath.get(filepath) || null;
}

function insertPage(documentId, pageNumber, width, height) {
  const result = stmts.insertPage.run(documentId, pageNumber, width, height);
  return result.lastInsertRowid;
}

function insertBlock(pageId, documentId, type, text, bbox, fontSize, readingOrder) {
  const result = stmts.insertBlock.run(
    pageId, documentId, type, text,
    typeof bbox === 'object' ? JSON.stringify(bbox) : bbox,
    fontSize, readingOrder
  );
  return result.lastInsertRowid;
}

function updateBlockEmbedding(id, float32Array) {
  const buf = Buffer.from(float32Array.buffer);
  stmts.updateBlockEmbedding.run(buf, id);
}

function updateBlockSummary(id, text) {
  stmts.updateBlockSummary.run(text, id);
}

function getPageBlocks(documentId, pageNumber) {
  return stmts.getPageBlocks.all(documentId, pageNumber).map(parseBlock);
}

function getOutline(documentId) {
  return stmts.getOutline.all(documentId).map(parseBlock);
}

function searchKeyword(documentId, query) {
  return stmts.keywordSearch.all(documentId, `%${query}%`).map(parseBlock);
}

function getAllBlocksWithEmbeddings(documentId) {
  return stmts.getAllBlocksForDoc.all(documentId);
}

// Cosine similarity between two Float32Arrays
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function searchSemantic(documentId, queryEmbedding, topN = 5) {
  const rows = getAllBlocksWithEmbeddings(documentId);
  const scored = rows
    .filter(r => r.embedding)
    .map(r => {
      const stored = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      return { ...r, score: cosineSimilarity(queryEmbedding, stored) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  return scored.map(parseBlock);
}

// Parse bbox JSON if stored as string
function parseBlock(row) {
  if (!row) return row;
  if (typeof row.bbox === 'string') {
    try { row.bbox = JSON.parse(row.bbox); } catch {}
  }
  return row;
}

// ── Annotation CRUD ──────────────────────────────────────────────

const annotStmts = {
  upsert: db.prepare(`
    INSERT INTO pdf_annotations (doc_id, page_num, annotations_json, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(doc_id, page_num) DO UPDATE SET
      annotations_json = excluded.annotations_json,
      updated_at = CURRENT_TIMESTAMP
  `),
  getAll: db.prepare(`SELECT page_num, annotations_json FROM pdf_annotations WHERE doc_id = ? ORDER BY page_num`),
  deleteAll: db.prepare(`DELETE FROM pdf_annotations WHERE doc_id = ?`),
};

function saveAnnotations(docId, pages) {
  const tx = db.transaction(() => {
    for (const [pageNum, anns] of Object.entries(pages)) {
      annotStmts.upsert.run(String(docId), parseInt(pageNum), JSON.stringify(anns));
    }
  });
  tx();
}

function getAnnotations(docId) {
  const rows = annotStmts.getAll.all(String(docId));
  const pages = {};
  for (const row of rows) {
    try { pages[row.page_num] = JSON.parse(row.annotations_json); }
    catch { pages[row.page_num] = []; }
  }
  return pages;
}

function deleteAnnotations(docId) {
  annotStmts.deleteAll.run(String(docId));
}

module.exports = {
  insertDocument,
  updateDocument,
  getDocument,
  findByFilepath,
  insertPage,
  insertBlock,
  updateBlockEmbedding,
  updateBlockSummary,
  getPageBlocks,
  getOutline,
  searchKeyword,
  searchSemantic,
  getAllBlocksWithEmbeddings,
  saveAnnotations,
  getAnnotations,
  deleteAnnotations,
};
