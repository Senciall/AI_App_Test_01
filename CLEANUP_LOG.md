# Cleanup Log

Generated: 2026-03-19

## Summary

Promoted v2/ (Electron + Express + SQLite app) to root and archived the older root-level server app. The project now has a clean structure:

```
main.js           ← Electron entry
server.js         ← Server entry (delegates to server/index.js)
launch.js         ← Electron launcher
package.json
server/           ← All backend code (7 files)
public/           ← All frontend files (9 files)
```

---

## Moved to /archive

### archive/root-server/ — Legacy root-level server app (superseded by v2)
- `index.js` — Express server with modular routes, TTS proxy, context-director
- `paths.js` — Path constants for user_data/
- `data.js` — Data file helpers
- `migrate.js` — Migration system
- `ollama.js` — Ollama base URL + helpers
- `context-director.js` — Model warm-up + keep-alive
- `web-agent.js` — Web search agent (older variant of v2's)
- `routes/chat.js` — Chat endpoint (modularized)
- `routes/chats.js` — Chat CRUD
- `routes/context.js` — Context endpoint
- `routes/documents.js` — Document handling
- `routes/files.js` — File CRUD
- `routes/life.js` — Life entries
- `routes/rag.js` — RAG search endpoints
- `routes/settings.js` — Settings endpoint
- `rag/metadata-agent.js` — RAG metadata extraction
- `rag/prompt.js` — RAG prompt templates
- `rag/vector-store.js` — Vector store

### archive/root-public/ — Legacy root-level frontend
- `app.js` — Larger frontend (160KB, different feature set from v2's 65KB)
- `index.html` — Older frontend markup
- `style.css` — Older styles
- `math-presets.js` — Math preset features (not present in v2)

### archive/root-package.json — Old root package manifest
### archive/root-package-lock.json — Old root lockfile

### archive/legacy-chats-root/ — v1-era chat history
- 50 JSON files from original app (older timestamps, different naming format)

### archive/user-data/ — Root server's runtime data store
- `chats/` — 70 chat JSON files (superset of v2/Chats, byte-identical overlap)
- `documents/` — Indexed PDFs, images, spreadsheets with extracted text
- `config.json` — Root server config
- `rag/vector-index.json` — RAG vector index (nearly empty)

### archive/temp-uploads/ — Old uploaded test files
- 27 files (~52MB) — duplicate uploaded resumes, PDFs, screenshots with timestamps

### archive/v2-temp-uploads/ — v2's old temp uploads
- 1 file — old uploaded resume

### archive/dist/ — Old Electron build artifacts
- `ChatGPT 2.0 Setup 1.0.0.exe` (121MB installer)
- `win-unpacked/` (full unpacked app)
- Build configs and metadata

### archive/scripts/
- `rag_chromadb.py` — Python RAG script with ChromaDB (standalone, never used by Node app)

### archive/tts_server.py — Python TTS server (Kokoro, standalone utility)
### archive/Current_problems.txt — Dev notes from Mar 10 (issues now resolved)
### archive/PDF_EDITOR_LOGIC.md — Technical docs for PDF editor coordinate system
### archive/image.png — Screenshot or reference image
### archive/OLD_APPLICATION/README.md — Note about old code in git history
### archive/package.json.tmp.30948.1773938398930 — Stale npm temp file

---

## Paths Updated

### server/index.js (was v2/server.js)
- Line 15: `BASE_PATH = __dirname` → `BASE_PATH = path.join(__dirname, '..')`
- Line 110: `express.static(path.join(__dirname, 'public'))` → `express.static(path.join(__dirname, '..', 'public'))`
- Line 431: `require('./server/pdf-routes')` → `require('./pdf-routes')`
- Line 434: `require('./server/embeddings')` → `require('./embeddings')`
- Line 452: `require('./server/web-agent')` → `require('./web-agent')`
- Line 455: `require('./server/browser-agent')` → `require('./browser-agent')`
- Line 476: `require('./server/embeddings')` → `require('./embeddings')`

### server.js (root entry point) — rewritten
- Was: `require('./server/index.js')` (old root server)
- Now: Thin entry that requires `./server/index.js`, re-exports `{ startServer, PORT }`, and starts server when run directly

### data.json — path updated
- `filesDir`: `chatgpt20\v2\files` → `chatgpt20\files`

### .gitignore — updated for new structure
- Added: `uploads/`, `archive/`, `v2/`, `*.db`, `*.db-shm`, `*.db-wal`, `data.json`, `browser-accounts.json`, `browser-cookies.json`, `life-entries.json`
- Removed: `user_data/`, `temp_uploads/`, `OLD_APPLICATION/`, `Workspaces/`

---

## Flagged for Manual Review

### v2/ directory remnants
- `v2/myai.db`, `v2/myai.db-shm`, `v2/myai.db-wal` — SQLite files locked by running Electron process. Copied to root. Delete v2/ after closing Electron.
- `v2/node_modules/` — Locked by running Electron. Delete v2/ after closing Electron.

### archive/root-server/ — features not in v2
The legacy root server had features that do NOT exist in the current v2 codebase:
- **TTS proxy** (Kokoro on port 5111) — if you want TTS, port this from `archive/root-server/index.js`
- **Context director** (model warm-up + keep-alive pings) — useful for faster first response, port from `archive/root-server/context-director.js`
- **RAG system** (vector store, metadata agent, prompts) — port from `archive/root-server/rag/`
- **Math presets** — port from `archive/root-public/math-presets.js`
- **Modular route structure** — the root server split routes into 8 files vs v2's monolithic server.js. Consider refactoring server/index.js to match this pattern.

---

## Unused Packages (confirm before removing)

**None found.** All 7 production dependencies and 1 dev dependency are actively used:

| Package | Used In |
|---------|---------|
| better-sqlite3 | server/db.js |
| express | server/index.js, server/pdf-routes.js, server/browser-agent.js |
| http-proxy-middleware | server/index.js |
| multer | server/index.js, server/pdf-routes.js |
| pdf-parse | server/index.js |
| pdfjs-dist | server/pdf-worker.js, public/pdf-editor.js, public/pdf-viewer.html |
| xlsx | server/index.js |
| electron (dev) | main.js, launch.js |

---

## Validation

All require() chains verified:
- ✓ `server.js` → `server/index.js` → exports `{ startServer, PORT }`
- ✓ `main.js` → `require('./server')` → `{ startServer, PORT }`
- ✓ `server/db.js` — better-sqlite3 loads, DB path resolves to root
- ✓ `server/embeddings.js` — Ollama HTTP helper loads
- ✓ `server/pdf-routes.js` — requires db, pdf-worker, embeddings
- ✓ `server/pdf-worker.js` — requires db, embeddings
- ✓ `server/browser-agent.js` — requires no local modules, BASE_PATH resolves to root
- ✓ `server/web-agent.js` — requires no local modules
- ✓ All 9 public/ files present
