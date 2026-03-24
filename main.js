const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const http = require('http');

let win = null;
let expressPort = 3000;
let ollamaProcess = null;

function createWindow(port) {
  expressPort = port;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    title: 'MyAI',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
  });

  win.loadURL(`http://localhost:${port}`);
  win.on('closed', () => { win = null; });
}

function isOllamaRunning() {
  return new Promise(resolve => {
    http.get('http://127.0.0.1:11434', res => {
      res.resume();
      resolve(true);
    }).on('error', () => resolve(false));
  });
}

async function ensureOllama() {
  if (await isOllamaRunning()) return;

  ollamaProcess = spawn('ollama', ['serve'], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });

  ollamaProcess.on('error', (err) => {
    console.warn('Failed to start ollama:', err.message);
    ollamaProcess = null;
  });

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isOllamaRunning()) return;
  }
  console.warn('Ollama did not become ready within 10 seconds');
}

app.whenReady().then(async () => {
  await ensureOllama();
  const { startServer, PORT } = require('./server');
  startServer(PORT, (port) => createWindow(port));
});

app.on('will-quit', () => {
  if (ollamaProcess && !ollamaProcess.killed) {
    ollamaProcess.kill();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!win) createWindow(expressPort);
});
