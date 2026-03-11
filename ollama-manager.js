const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');

const OLLAMA_URL = 'http://127.0.0.1:11434';
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download/OllamaSetup.exe';

let ollamaProcess = null;

function getOllamaPath() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe');
}

function isOllamaInstalled() {
    if (fs.existsSync(getOllamaPath())) return true;

    try {
        execSync('where ollama', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function isOllamaRunning() {
    return new Promise((resolve) => {
        const req = http.get(OLLAMA_URL, (res) => {
            resolve(true);
            res.resume();
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    });
}

function downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);

        const follow = (currentUrl) => {
            const client = currentUrl.startsWith('https') ? https : http;
            client.get(currentUrl, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    follow(response.headers.location);
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`Download failed with status ${response.statusCode}`));
                    return;
                }

                const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
                let downloadedBytes = 0;

                response.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (onProgress && totalBytes > 0) {
                        onProgress(Math.round((downloadedBytes / totalBytes) * 100));
                    }
                });

                response.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
                file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
            }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
        };

        follow(url);
    });
}

async function installOllama(onStatus) {
    const tempDir = os.tmpdir();
    const installerPath = path.join(tempDir, 'OllamaSetup.exe');

    if (onStatus) onStatus('downloading', 0);
    await downloadFile(OLLAMA_DOWNLOAD_URL, installerPath, (pct) => {
        if (onStatus) onStatus('downloading', pct);
    });

    if (onStatus) onStatus('installing', 100);
    return new Promise((resolve, reject) => {
        const installer = spawn(installerPath, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], {
            stdio: 'ignore',
            detached: true,
        });

        installer.on('close', (code) => {
            try { fs.unlinkSync(installerPath); } catch {}
            if (code === 0 || code === null) {
                resolve();
            } else {
                reject(new Error(`Installer exited with code ${code}`));
            }
        });

        installer.on('error', (err) => {
            try { fs.unlinkSync(installerPath); } catch {}
            reject(err);
        });
    });
}

function startOllamaServe() {
    if (ollamaProcess) return;

    const ollamaExe = isOllamaInstalled() ? getOllamaPath() : 'ollama';
    const exePath = fs.existsSync(getOllamaPath()) ? getOllamaPath() : 'ollama';

    ollamaProcess = spawn(exePath, ['serve'], {
        stdio: 'ignore',
        detached: false,
        env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' },
    });

    ollamaProcess.on('error', (err) => {
        console.error('Failed to start Ollama:', err.message);
        ollamaProcess = null;
    });

    ollamaProcess.on('exit', () => {
        ollamaProcess = null;
    });
}

async function waitForOllama(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isOllamaRunning()) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

function stopOllama() {
    if (ollamaProcess) {
        try {
            ollamaProcess.kill();
        } catch {}
        ollamaProcess = null;
    }
}

async function ensureOllama(onStatus) {
    if (await isOllamaRunning()) {
        if (onStatus) onStatus('ready', 100);
        return;
    }

    if (!isOllamaInstalled()) {
        await installOllama(onStatus);
        await new Promise((r) => setTimeout(r, 2000));
    }

    if (onStatus) onStatus('starting', 100);
    startOllamaServe();

    const ready = await waitForOllama();
    if (!ready) {
        throw new Error('Ollama failed to start within timeout');
    }

    if (onStatus) onStatus('ready', 100);
}

module.exports = {
    isOllamaInstalled,
    isOllamaRunning,
    installOllama,
    startOllamaServe,
    waitForOllama,
    stopOllama,
    ensureOllama,
};
