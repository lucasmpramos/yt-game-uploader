// Node side of the tray helper: compiles tray.cs with the C# compiler that ships with Windows
// (.NET Framework 4.x — no install needed), then talks to tray.exe over stdin/stdout.
// If the compiler is missing or the build fails, startTray() returns null and the app falls
// back to its PowerShell window control (no tray icon, minimize instead of hide).
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

function ensureBuilt(dir, log = () => {}) {
  dir = path.resolve(dir);
  const src = path.join(dir, 'tray.cs');
  const exe = path.join(dir, 'tray.exe');
  if (!fs.existsSync(src)) return null;
  try {
    if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(src).mtimeMs) return exe;
  } catch {}
  if (!fs.existsSync(CSC)) { log('Tray: C# compiler not found, tray disabled'); return null; }
  const ico = path.join(dir, 'icon.ico'), png = path.join(dir, 'icon.png'), stage = path.join(dir, 'tray-stage.exe');
  const compile = (out, iconFile) => execFileSync(CSC, ['/nologo', '/target:winexe', '/optimize+', '/warn:0', `/out:${out}`, ...(iconFile ? [`/win32icon:${iconFile}`] : []), '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', src], { windowsHide: true, stdio: 'pipe', timeout: 60000 });
  try {
    // Two stages: build once to render the icon artwork, then build the real helper with that icon embedded.
    // The embedded icon is what Windows shows as the app identity (toast header, Start Menu shortcut).
    compile(stage, null);
    execFileSync(stage, ['--export-icon', png, ico], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
    compile(exe, ico);
    try { fs.unlinkSync(stage); } catch {}
    log('Tray: helper compiled (with embedded icon)');
    return exe;
  } catch (e) {
    log(`Tray: build failed: ${(e.stdout || e.stderr || e.message).toString().trim().slice(0, 400)}`);
    try { fs.unlinkSync(stage); } catch {}
    return null;
  }
}

// Returns { send(line), stop(), get alive() } or null.
function startTray({ dir, title, tooltip, onEvent, log = () => {} }) {
  const exe = ensureBuilt(dir, log);
  if (!exe) return null;
  let child;
  try {
    child = spawn(exe, [title, tooltip || title], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { log(`Tray: spawn failed: ${e.message}`); return null; }
  let alive = true, buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) { try { onEvent(line); } catch (e) { log(`Tray: handler error: ${e.message}`); } }
    }
  });
  child.stderr.on('data', d => log(`Tray: ${d.toString().trim()}`));
  child.on('exit', (code) => { alive = false; log(`Tray: helper exited (${code})`); });
  return {
    send(line) { if (alive) { try { child.stdin.write(line + '\n'); } catch {} } },
    stop() { if (alive) { try { child.stdin.write('quit\n'); } catch {} setTimeout(() => { try { child.kill(); } catch {} }, 500); } },
    get alive() { return alive; },
  };
}

module.exports = { startTray, ensureBuilt, CSC };
