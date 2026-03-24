'use strict';

const http = require('http');

const OLLAMA_BASE     = 'http://127.0.0.1:11434';
const EMBEDDING_MODEL = 'nomic-embed-text'; // 274M params, 768-dim, fast + high quality

// ── Ollama HTTP helper ────────────────────────────────────────
function ollamaPost(path, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req  = http.request(`${OLLAMA_BASE}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end',  () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON from Ollama')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(json);
    req.end();
  });
}

// ── Embed a single string ─────────────────────────────────────
async function embedText(text) {
  try {
    const res = await ollamaPost('/api/embeddings', { model: EMBEDDING_MODEL, prompt: text }, 15000);
    if (!res.embedding || !res.embedding.length) return null;
    return new Float32Array(res.embedding);
  } catch {
    return null; // graceful degradation — search falls back to keyword
  }
}

// ── Pull the embedding model if not installed ─────────────────
async function ensureEmbeddingModel() {
  // Check if already installed
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${OLLAMA_BASE}/api/tags`, { method: 'GET' }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    const installed = (res.models || []).map(m => m.name.split(':')[0]);
    if (installed.includes(EMBEDDING_MODEL)) {
      console.log(`[embeddings] ${EMBEDDING_MODEL} already installed`);
      return;
    }
  } catch (err) {
    console.warn('[embeddings] could not check Ollama models:', err.message);
    return;
  }

  // Pull the model (streaming response — log dots to console)
  console.log(`[embeddings] pulling ${EMBEDDING_MODEL}…`);
  try {
    await new Promise((resolve, reject) => {
      const json = JSON.stringify({ model: EMBEDDING_MODEL, stream: true });
      const req  = http.request(`${OLLAMA_BASE}/api/pull`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
      }, res => {
        let lastStatus = '';
        let buf = '';
        res.on('data', chunk => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.status && obj.status !== lastStatus) {
                console.log(`[embeddings] ${obj.status}` + (obj.total ? ` (${Math.round((obj.completed||0)/obj.total*100)}%)` : ''));
                lastStatus = obj.status;
              }
              if (obj.status === 'success') resolve();
            } catch {}
          }
        });
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(10 * 60 * 1000, () => { req.destroy(); reject(new Error('pull timed out')); });
      req.write(json);
      req.end();
    });
    console.log(`[embeddings] ${EMBEDDING_MODEL} ready`);
  } catch (err) {
    console.warn(`[embeddings] pull failed: ${err.message}`);
  }
}

// ── Model classification helpers (used by frontend filter API) ─

/**
 * Parse a parameter size string like "4.3B", "500M", "1.1B" → gigacount float.
 * Returns 0 if unparseable (unknown = include by default).
 */
function parseParamBillions(sizeStr) {
  if (!sizeStr) return 0;
  const m = sizeStr.match(/^(\d+\.?\d*)\s*([BbMmKk])/);
  if (!m) return 0;
  const n    = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'B') return n;
  if (unit === 'M') return n / 1000;
  return 0;
}

/** Returns true if a model from /api/tags is an embedding model. */
function isEmbeddingModel(model) {
  const name   = (model.name   || '').toLowerCase();
  const family = (model.details?.family || '').toLowerCase();
  return (
    name.includes('embed')             ||  // nomic-embed-text, mxbai-embed-large, etc.
    family.includes('bert')            ||  // bert, nomic-bert
    name.startsWith('bge-')            ||  // bge-m3, bge-large, etc.
    name.startsWith('snowflake-arctic-embed') ||
    name.startsWith('all-minilm')      ||
    name.startsWith('paraphrase-multilingual')
  );
}

/** Returns true if a model is suitable for chat (not an embedder, >= 1B params). */
function isChatModel(model) {
  if (isEmbeddingModel(model)) return false;
  const params = parseParamBillions(model.details?.parameter_size);
  return params === 0 || params >= 1; // 0 = unknown size → include
}

module.exports = {
  EMBEDDING_MODEL,
  embedText,
  ensureEmbeddingModel,
  isEmbeddingModel,
  isChatModel,
};
