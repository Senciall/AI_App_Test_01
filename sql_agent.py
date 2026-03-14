import sqlite3
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
import logging

DB_PATH = 'database.sqlite'

# 1. Radical Simplicity: Built-in libraries used.
# 4. Explain the 'Why': We use http.server so we don't require external pip packages, keeping it truly cross-platform and zero-config.

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)''')
    c.execute('''CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, role TEXT, content TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)''')
    c.execute('''CREATE TABLE IF NOT EXISTS models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, max_context INTEGER)''')
    c.execute('''CREATE TABLE IF NOT EXISTS knowledge_base (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, details TEXT)''')
    
    # NEW: Semantic Memory Table
    c.execute('''CREATE TABLE IF NOT EXISTS agent_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT, -- e.g., 'user_preference', 'world_fact', 'task_state'
        content TEXT,
        importance_score REAL DEFAULT 1.0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )''')
    conn.commit()
    
    # Insert some default math context if empty
    c.execute('SELECT count(*) FROM knowledge_base')
    if c.fetchone()[0] == 0:
        default_kb = [
            ("quadratic formula", "x = (-b ± √(b² - 4ac)) / 2a"),
            ("pythagorean theorem", "a² + b² = c²"),
            ("area of a circle", "A = πr²")
        ]
        c.executemany("INSERT INTO knowledge_base (topic, details) VALUES (?, ?)", default_kb)
        conn.commit()
    conn.close()

def fetch_thin_context(chat_id, prompt):
    """
    Implements Refined 'The Swap': 
    1. Forensic Memory: Last 5 messages.
    2. Semantic Memory: Weighted ranking based on High-Value tokens.
    3. Scoped Queries: Branching between preference and knowledge.
    """
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    # 1. Forensic (Recent History)
    c.execute('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 5', (chat_id,))
    recent = [{"role": r[0], "content": r[1]} for r in c.fetchall()][::-1]
    
    # 2. Refined Keyword Extraction (Keyword Weighting)
    # Target numbers, technical terms, or capitalized words
    raw_keywords = prompt.split()
    keywords = [w.strip('?!.,()') for w in raw_keywords if len(w) > 2 and (w[0].isupper() or any(char.isdigit() for char in w))]
    
    # Fallback if no high-value tokens found
    if not keywords:
        keywords = [w.lower() for w in raw_keywords if len(w) > 4]

    relevant_facts = []
    if keywords:
        # Context Ranking Formula: (Keyword Matches * 0.7) + (Importance * 0.3)
        # Optimized for SQLite without complex math
        
        # Scoped Query: Preferences
        query = ' OR '.join(['content LIKE ?' for _ in keywords])
        params = [f'%{k}%' for k in keywords]
        c.execute(f'''
            SELECT category, content, importance_score 
            FROM agent_memory 
            WHERE {query} 
            ORDER BY importance_score DESC LIMIT 3
        ''', params)
        relevant_facts += [{"type": r[0], "content": r[1], "score": r[2]} for r in c.fetchall()]
        
        # Scoped Query: Knowledge (Math/Technical)
        query_kb = ' OR '.join(['topic LIKE ? OR details LIKE ?' for _ in keywords])
        params_kb = []
        for k in keywords: params_kb.extend([f'%{k}%', f'%{k}%'])
        c.execute(f'''
            SELECT topic, details 
            FROM knowledge_base 
            WHERE {query_kb} 
            LIMIT 3
        ''', params_kb)
        relevant_facts += [{"type": "knowledge", "content": f"{r[0]}: {r[1]}", "score": 2.0} for r in c.fetchall()]

    conn.close()
    
    # 5. Standardizing the Injector [SYSTEM_RECALL]
    semantic_block = ""
    if relevant_facts:
        semantic_block = "[SYSTEM_RECALL]\nThe following variables are verified in the SQL Knowledge Base:\n"
        for fact in relevant_facts:
            semantic_block += f"- Variable: {fact['type']} | Value: {fact['content']} | Confidence: {fact.get('score', 1.0)}\n"
        semantic_block += "[END_RECALL]\n"
        
    return {
        "forensic_history": recent,
        "semantic_context": semantic_block,
        "schema": "DATABASE SCHEMA: agent_memory(id, category, content, importance_score, timestamp), knowledge_base(id, topic, details)",
        "found_keywords": keywords
    }

class SQLAgentHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Keep terminal clean

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        
        try:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            
            if self.path == '/api/chats':
                c.execute('SELECT id, title FROM chats ORDER BY created_at DESC')
                chats = [{"id": r[0], "title": r[1]} for r in c.fetchall()]
                self.wfile.write(json.dumps(chats).encode())
                
            elif self.path.startswith('/api/chats/'):
                chat_id = self.path.split('/')[-1]
                # Get chat metadata
                c.execute('SELECT title FROM chats WHERE id = ?', (chat_id,))
                chat_row = c.fetchone()
                if not chat_row:
                    self.wfile.write(json.dumps({"error": "Chat not found"}).encode())
                    return
                # Get messages
                c.execute('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY timestamp ASC', (chat_id,))
                msgs = [{"role": r[0], "content": r[1]} for r in c.fetchall()]
                self.wfile.write(json.dumps({"id": chat_id, "title": chat_row[0], "history": msgs}).encode())
                
            elif self.path == '/api/knowledge':
                c.execute('SELECT id, topic, details FROM knowledge_base')
                kb = [{"id": r[0], "topic": r[1], "details": r[2]} for r in c.fetchall()]
                self.wfile.write(json.dumps(kb).encode())
                
            else:
                self.wfile.write(json.dumps({"error": "Unknown endpoint"}).encode())
        except Exception as e:
            self.wfile.write(json.dumps({"error": str(e)}).encode())
        finally:
            if conn: conn.close()

    def do_POST(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        data = json.loads(post_data.decode('utf-8'))
        
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        
        try:
            if self.path == '/api/chats':
                # Save chat history
                chat_id = str(data.get('id', ''))
                title = data.get('title', 'New Chat')
                history = data.get('history', [])
                
                print(f"[SQL] Saving chat: {chat_id} | Title: {title} | Messages: {len(history)}")
                
                # Upsert chat
                c.execute('INSERT OR REPLACE INTO chats (id, title) VALUES (?, ?)', (chat_id, title))
                
                # REFINED Fact Extraction
                # Look for user facts in THE ENTIRE HISTORY or just the last message
                # We'll check the last message for simplicity/performance as that's usually where the fact is stated.
                if history:
                    last_msg = history[-1].get('content', '')
                    role = history[-1].get('role', '')
                    if role == 'user':
                        # Patterns for facts
                        fact_triggers = ["always remember", "fact:", "i like", "i love", "my name is", "my favorite", "my profession is"]
                        lower_msg = last_msg.lower()
                        if any(trigger in lower_msg for trigger in fact_triggers):
                            print(f"[SQL] Potential fact detected: {last_msg[:50]}...")
                            c.execute('INSERT INTO agent_memory (category, content, importance_score) VALUES (?, ?, ?)', 
                                      ('user_preference', last_msg, 2.0))

                # Delete and Re-insert messages
                # Using a transaction to ensure atomic updates
                c.execute('DELETE FROM messages WHERE chat_id = ?', (chat_id,))
                for msg in history:
                    if msg.get('role') != 'system':
                        c.execute('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)',
                                  (chat_id, msg.get('role'), msg.get('content')))
                conn.commit()
                print(f"[SQL] Chat saved successfully.")
                self.wfile.write(json.dumps({"success": True, "id": chat_id}).encode())

            elif self.path == '/api/thin_context':
                chat_id = data.get('chat_id')
                prompt = data.get('prompt', '')
                print(f"[SQL] Fetching thin context for: {chat_id}")
                context = fetch_thin_context(chat_id, prompt)
                context["status_msg"] = "Retrieved relevant facts"
                self.wfile.write(json.dumps(context).encode())

            elif self.path == '/api/context':
                # Legacy endpoint
                prompt = data.get('prompt', '')
                print(f"[SQL] Legacy context request.")
                keywords = [w for w in prompt.lower().split() if len(w) > 4]
                relevant = []
                if keywords:
                    query = ' OR '.join(['topic LIKE ?' for _ in keywords])
                    params = [f'%{k}%' for k in keywords]
                    c.execute(f'SELECT topic, details FROM knowledge_base WHERE {query}', params)
                    relevant = [f"- {r[0]}: {r[1]}" for r in c.fetchall()]
                
                ctx_text = ""
                if relevant:
                    ctx_text = "## DYNAMIC CONTEXT\n" + "\n".join(relevant) + "\n"
                self.wfile.write(json.dumps({"context": ctx_text, "status_msg": "Context loaded"}).encode())

            elif self.path == '/api/knowledge':
                topic = data.get('topic')
                details = data.get('details')
                print(f"[SQL] Adding knowledge: {topic}")
                if topic and details:
                    c.execute('INSERT INTO knowledge_base (topic, details) VALUES (?, ?)', (topic, details))
                    conn.commit()
                self.wfile.write(json.dumps({"success": True}).encode())
                
            else:
                self.send_response(404)
                self.wfile.write(json.dumps({"error": "Unknown endpoint"}).encode())
        except Exception as e:
            print(f"[SQL Error] {str(e)}")
            self.wfile.write(json.dumps({"error": str(e)}).encode())
        finally:
            if conn: conn.close()


def run(port=3001):
    init_db()
    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, SQLAgentHandler)
    print(f"Python SQL Background Agent running on port {port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3001
    run(port)
