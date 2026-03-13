const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { ensureOllama, stopOllama, ensureModel } = require('./ollama-manager');
const { startServer } = require('./server');

const PORT = 3000;
let mainWindow = null;
let tray = null;
let expressServer = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        minWidth: 800,
        minHeight: 600,
        title: 'ChatGPT 2.0',
        backgroundColor: '#0a0a0c',
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    mainWindow.setMenuBarVisibility(false);

    mainWindow.loadFile(path.join(__dirname, 'public', 'loading.html'));
    mainWindow.once('ready-to-show', () => mainWindow.show());

    mainWindow.on('close', (e) => {
        if (tray) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
    const iconSize = 16;
    const icon = nativeImage.createEmpty();

    tray = new Tray(icon);
    tray.setToolTip('ChatGPT 2.0');
    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: 'Show',
            click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                tray.destroy();
                tray = null;
                app.quit();
            },
        },
    ]));

    tray.on('double-click', () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
}

function sendStatus(stage, progress) {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('setup-status', { stage, progress });
    }
}

async function bootstrap() {
    createWindow();
    createTray();

    try {
        sendStatus('checking', 0);

        await ensureOllama((stage, progress) => {
            sendStatus(stage, progress);
        });

        await ensureModel('gemma3:latest', (stage, progress) => {
            sendStatus(stage, progress);
        });

        await ensureModel('exaone-deep:2.4b', (stage, progress) => {
            sendStatus(stage, progress);
        });

        const result = await startServer(PORT);
        expressServer = result.server;
        const actualPort = result.port;

        sendStatus('ready', 100);
        await new Promise((r) => setTimeout(r, 600));

        if (mainWindow) {
            mainWindow.loadURL(`http://localhost:${actualPort}`);
        }
    } catch (err) {
        console.error('Bootstrap failed:', err);
        sendStatus('error', err.message);
    }
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) createWindow();
});

app.on('before-quit', () => {
    stopOllama();
    if (expressServer) {
        expressServer.close();
    }
    if (tray) {
        tray.destroy();
        tray = null;
    }
});
