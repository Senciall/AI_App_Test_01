// Electron launcher — strips ELECTRON_RUN_AS_NODE so the app runs as a
// proper Electron main process even when launched from VS Code's terminal.
const { spawn } = require('child_process');
const electron  = require('electron');           // npm package → path to binary
const env       = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;                 // VS Code sets this; must remove
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('close', code => process.exit(code ?? 0));
