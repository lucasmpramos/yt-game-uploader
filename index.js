const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { execSync } = require('child_process');
const readline = require('readline');
const chokidar = require('chokidar');

// --- Config ---
const WATCH_DIR = 'C:\\Users\\Lucas Machado\\Videos\\yt-uploads';
const SCRIPT_DIR = 'C:\\Users\\Lucas Machado\\GameUploader';
const CLIENT_SECRET = path.join(SCRIPT_DIR, 'client_secret.json');
const TOKEN_FILE = path.join(SCRIPT_DIR, 'token.json');
const UPLOADED_FILE = path.join(SCRIPT_DIR, 'uploaded.json');
const HISTORY_FILE = path.join(SCRIPT_DIR, 'history.json');
const LOG_FILE = path.join(SCRIPT_DIR, 'uploader.log');
const MIN_SIZE = 1 * 1024 * 1024;

// --- Window control ---
const WIN_HELPER = path.join(SCRIPT_DIR, '_winctl.ps1');
function initWindowHelper() {
  const ps1 = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCtl {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool FlashWindow(IntPtr h, bool invert);
}
"@

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
    public delegate bool EnumCallback(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowTextA(IntPtr h, StringBuilder sb, int max);
}
"@

$action = $args[0]
$search = $args[1]
$found = [IntPtr]::Zero
$cb = [WinEnum+EnumCallback]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [WinEnum]::GetWindowTextA($h, $sb, 256) | Out-Null
    if ($sb.ToString().Contains($search)) { $script:found = $h; return $false }
    return $true
}
[WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($found -eq [IntPtr]::Zero) { exit 1 }

switch ($action) {
    "minimize" { [WinCtl]::ShowWindow($found, 6) }
    "restore"  { [WinCtl]::ShowWindow($found, 9); [WinCtl]::SetForegroundWindow($found) }
    "flash"    { [WinCtl]::FlashWindow($found, $true) }
}
`;
  fs.writeFileSync(WIN_HELPER, ps1);
}

const WIN_TITLE = 'GameUploader';

function winctl(action) {
  try {
    execSync(`powershell -ExecutionPolicy Bypass -File "${WIN_HELPER}" ${action} "${WIN_TITLE}"`, { stdio: 'ignore', timeout: 5000 });
  } catch {}
}

function minimizeSelf() { winctl('minimize'); }
function restoreSelf() { winctl('restore'); }
function flashTaskbar() { winctl('flash'); }

function beepSuccess() {
  try { execSync('powershell -Command "[console]::beep(700,150);[console]::beep(900,150);[console]::beep(1100,200)"', { stdio: 'ignore' }); } catch {}
}
function beepError() {
  try { execSync('powershell -Command "[console]::beep(400,300);[console]::beep(300,400)"', { stdio: 'ignore' }); } catch {}
}

function copyToClipboard(text) {
  try { execSync(`powershell -Command "Set-Clipboard '${text}'"`, { stdio: 'ignore' }); return true; } catch { return false; }
}

function openInBrowser(url) {
  try { execSync(`start "" "${url}"`, { stdio: 'ignore', shell: true }); } catch {}
}

// --- Logging ---
function log(msg) {
  const ts = new Date().toLocaleString('sv-SE');
  fs.appendFileSync(LOG_FILE, `${ts} - ${msg}\n`);
}

// --- JSON ---
function loadJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; } }
function saveJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

// --- History ---
function addHistory(entry) {
  const history = loadJson(HISTORY_FILE);
  history.unshift(entry); // newest first
  if (history.length > 50) history.length = 50; // keep last 50
  saveJson(HISTORY_FILE, history);
}

// --- Display ---
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  underline: '\x1b[4m',
  white: '\x1b[37m',
  magenta: '\x1b[35m',
};

function clear() { process.stdout.write('\x1b[2J\x1b[H'); }

function drawHeader() {
  console.log('');
  console.log(`${C.cyan}  ╔══════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.cyan}  ║${C.bold}${C.cyan}           G A M E   U P L O A D E R              ${C.reset}${C.cyan}║${C.reset}`);
  console.log(`${C.cyan}  ╚══════════════════════════════════════════════════╝${C.reset}`);
  console.log('');
}

function drawIdle() {
  clear();
  process.title = 'GameUploader - Watching';
  drawHeader();
  const queueLen = uploadQueue.length;
  console.log(`${C.dim}  Status: ${C.reset}${C.green}Watching for new videos...${C.reset}`);
  console.log(`${C.dim}  Folder: ${C.reset}${WATCH_DIR}`);
  if (queueLen > 0) {
    console.log(`${C.dim}  Queue:  ${C.reset}${C.yellow}${queueLen} video(s) pending${C.reset}`);
  }
  console.log('');
  // Count uploaded files still in folder
  const uploaded = loadJson(UPLOADED_FILE);
  const deletable = uploaded.filter(f => fs.existsSync(f)).length;

  console.log(`${C.dim}  Drop a .mp4 in the folder to auto-upload to YouTube.${C.reset}`);
  console.log('');
  let keys = `${C.dim}  [H] History  |  [R] Restart`;
  if (deletable > 0) keys += `  |  [D] Delete ${deletable} uploaded`;
  keys += `  |  [Q] Minimize${C.reset}`;
  console.log(keys);
  console.log('');
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec > 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
}

function formatETA(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function drawProgress(filename, title, sizeMB, pct, speed, eta, queueLeft) {
  clear();
  process.title = `GameUploader - ${pct}%`;
  drawHeader();
  console.log(`${C.green}  ▲ Uploading${C.reset}`);
  console.log(`${C.dim}  File:  ${C.reset}${filename}`);
  console.log(`${C.dim}  Title: ${C.reset}${C.bold}${title}${C.reset}`);
  console.log(`${C.dim}  Size:  ${C.reset}${sizeMB} MB`);
  if (speed > 0) {
    console.log(`${C.dim}  Speed: ${C.reset}${formatSpeed(speed)}${C.dim}  ETA: ${C.reset}${formatETA(eta)}`);
  }
  if (queueLeft > 0) {
    console.log(`${C.dim}  Queue: ${C.reset}${C.yellow}${queueLeft} more after this${C.reset}`);
  }
  console.log('');
  const barW = 40;
  const filled = Math.round(barW * pct / 100);
  const bar = `${C.green}${'█'.repeat(filled)}${C.dim}${'░'.repeat(barW - filled)}${C.reset}`;
  console.log(`  ${bar} ${C.bold}${pct}%${C.reset}`);
  console.log('');
}

function drawDone(filename, title, sizeMB, videoId, url) {
  clear();
  process.title = 'GameUploader - Done!';
  drawHeader();
  console.log(`${C.bold}${C.green}  ✓ Upload Complete!${C.reset}`);
  console.log('');
  console.log(`${C.dim}  File:     ${C.reset}${filename}`);
  console.log(`${C.dim}  Title:    ${C.reset}${C.bold}${title}${C.reset}`);
  console.log(`${C.dim}  Size:     ${C.reset}${sizeMB} MB`);
  console.log(`${C.dim}  Video ID: ${C.reset}${videoId}`);
  console.log('');
  console.log(`${C.dim}  URL: ${C.reset}${C.bold}${C.cyan}${C.underline}${url}${C.reset}`);
  console.log('');
  console.log(`${C.bold}${C.green}  ✓ Link copied to clipboard!${C.reset}`);
  console.log('');
  console.log(`${C.dim}  [C] Copy link  |  [O] Open in browser  |  [Q] Minimize${C.reset}`);
  console.log('');
}

function drawError(filename, error) {
  clear();
  process.title = 'GameUploader - Error';
  drawHeader();
  console.log(`${C.bold}${C.red}  ✗ Upload Failed${C.reset}`);
  console.log('');
  console.log(`${C.dim}  File:  ${C.reset}${filename}`);
  console.log(`${C.dim}  Error: ${C.reset}${C.red}${error}${C.reset}`);
  console.log('');
  console.log(`${C.dim}  [Q] Minimize & keep watching${C.reset}`);
  console.log('');
}

function drawDeleteConfirm() {
  clear();
  process.title = 'GameUploader - Delete';
  drawHeader();
  const uploaded = loadJson(UPLOADED_FILE);
  const existing = uploaded.filter(f => fs.existsSync(f));

  if (existing.length === 0) {
    console.log(`${C.dim}  No uploaded files to delete.${C.reset}`);
    console.log('');
    console.log(`${C.dim}  [Esc] Back${C.reset}`);
    return;
  }

  console.log(`${C.bold}${C.yellow}  Delete uploaded videos from disk?${C.reset}`);
  console.log('');
  let totalSize = 0;
  for (const f of existing) {
    const size = fs.statSync(f).size;
    totalSize += size;
    const sizeMB = Math.round(size / 1024 / 1024);
    console.log(`${C.dim}  ${C.red}✗${C.reset} ${path.basename(f)} ${C.dim}(${sizeMB} MB)${C.reset}`);
  }
  console.log('');
  const totalGB = (totalSize / 1024 / 1024 / 1024).toFixed(1);
  console.log(`${C.bold}  ${existing.length} files — ${totalGB} GB total${C.reset}`);
  console.log('');
  console.log(`  ${C.bold}${C.red}[Y] Yes, delete all${C.reset}  ${C.dim}|  [Esc] Cancel${C.reset}`);
  console.log('');
}

function deleteUploaded() {
  const uploaded = loadJson(UPLOADED_FILE);
  let deleted = 0;
  let freed = 0;
  for (const f of uploaded) {
    if (fs.existsSync(f)) {
      try {
        const size = fs.statSync(f).size;
        fs.unlinkSync(f);
        freed += size;
        deleted++;
        log(`Deleted: ${path.basename(f)}`);
      } catch (e) {
        log(`Delete failed: ${path.basename(f)} - ${e.message}`);
      }
    }
  }
  const freedMB = Math.round(freed / 1024 / 1024);
  log(`Deleted ${deleted} files, freed ${freedMB} MB`);
  return { deleted, freedMB };
}

function drawHistory() {
  clear();
  process.title = 'GameUploader - History';
  drawHeader();
  const history = loadJson(HISTORY_FILE);
  if (history.length === 0) {
    console.log(`${C.dim}  No uploads yet.${C.reset}`);
  } else {
    console.log(`${C.bold}  Upload History${C.reset}  ${C.dim}(${history.length} total)${C.reset}`);
    console.log('');
    const show = history.slice(0, 15);
    for (const h of show) {
      const date = h.date || 'unknown';
      const status = h.success ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      console.log(`  ${status} ${C.dim}${date}${C.reset}  ${C.bold}${h.title}${C.reset}  ${C.dim}(${h.sizeMB} MB)${C.reset}`);
      if (h.url) console.log(`    ${C.cyan}${h.url}${C.reset}`);
    }
    if (history.length > 15) {
      console.log(`${C.dim}  ... and ${history.length - 15} more${C.reset}`);
    }
  }
  console.log('');
  console.log(`${C.dim}  [Esc] Back  |  [Q] Minimize${C.reset}`);
  console.log('');
}

// --- YouTube Auth ---
async function getAuth() {
  const creds = JSON.parse(fs.readFileSync(CLIENT_SECRET, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = creds.installed;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_FILE)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
    oauth2.setCredentials(token);
    if (token.expiry_date && Date.now() >= token.expiry_date) {
      try {
        const { credentials } = await oauth2.refreshAccessToken();
        oauth2.setCredentials(credentials);
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(credentials));
      } catch (e) {
        log(`Token refresh failed: ${e.message}`);
      }
    }
    return oauth2;
  }

  const open = (await import('open')).default;
  const http = require('http');
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      if (code) {
        const { tokens } = await oauth2.getToken(code);
        oauth2.setCredentials(tokens);
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens));
        res.end('OK! Close this tab.');
        server.close();
        resolve(oauth2);
      }
    });
    server.listen(0, async () => {
      const port = server.address().port;
      const o2 = new google.auth.OAuth2(client_id, client_secret, `http://localhost:${port}`);
      await open(o2.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/youtube.upload'] }));
    });
  });
}

// --- File stability check ---
function waitUntilStable(filepath) {
  return new Promise((resolve) => {
    const check = () => {
      if (!fs.existsSync(filepath)) { resolve(false); return; }
      const s1 = fs.statSync(filepath).size;
      setTimeout(() => {
        if (!fs.existsSync(filepath)) { resolve(false); return; }
        const s2 = fs.statSync(filepath).size;
        if (s1 === s2 && s1 > 0) resolve(true);
        else check();
      }, 5000);
    };
    check();
  });
}

// --- Upload ---
async function uploadVideo(auth, filepath, queueLeft) {
  const youtube = google.youtube({ version: 'v3', auth });
  const filename = path.basename(filepath);
  let title = path.parse(filename).name;
  if (title.length > 100) title = title.substring(0, 100);
  const fileSize = fs.statSync(filepath).size;
  const sizeMB = Math.round(fileSize / 1024 / 1024);

  log(`Uploading: ${title} (${sizeMB} MB)`);
  let lastPct = -1;
  let startTime = Date.now();
  let lastBytes = 0;
  let speed = 0;

  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title,
        description: `Gameplay uploaded automatically\nSize: ${sizeMB} MB`,
        tags: ['gameplay', 'steam'],
        categoryId: '20'
      },
      status: { privacyStatus: 'unlisted' }
    },
    media: { body: fs.createReadStream(filepath) }
  }, {
    onUploadProgress: (evt) => {
      const pct = Math.round((evt.bytesRead / fileSize) * 100);
      const now = Date.now();
      const elapsed = (now - startTime) / 1000;

      if (elapsed > 0) {
        speed = evt.bytesRead / elapsed;
      }
      const remaining = fileSize - evt.bytesRead;
      const eta = speed > 0 ? remaining / speed : 0;

      if (pct !== lastPct && pct % 2 === 0) {
        lastPct = pct;
        drawProgress(filename, title, sizeMB, pct, speed, eta, queueLeft);
        log(`  Progress: ${pct}%`);
      }
    }
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  return { videoId: res.data.id, title, sizeMB, filename, elapsed };
}

// --- Upload queue ---
const uploadQueue = [];
let busy = false;
let lastResult = null;
let showingHistory = false;
let showingDelete = false;

async function processQueue() {
  if (busy || uploadQueue.length === 0) return;
  busy = true;

  while (uploadQueue.length > 0) {
    const filepath = uploadQueue.shift();
    const filename = path.basename(filepath);
    lastResult = null;

    log(`New video detected: ${filename}`);
    restoreSelf();
    clear();
    drawHeader();
    console.log(`${C.yellow}  ● New video detected: ${filename}${C.reset}`);
    if (uploadQueue.length > 0) {
      console.log(`${C.dim}  ${uploadQueue.length} more in queue${C.reset}`);
    }
    console.log(`${C.dim}  Waiting for file to finish writing...${C.reset}`);

    const stable = await waitUntilStable(filepath);
    if (!stable) {
      log('File disappeared');
      addHistory({ title: filename, sizeMB: 0, success: false, error: 'File disappeared', date: new Date().toLocaleString('sv-SE') });
      continue;
    }

    if (fs.statSync(filepath).size < MIN_SIZE) {
      log('File too small, skipping');
      continue;
    }

    let lastErr;
    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const auth = await getAuth();
        const result = await uploadVideo(auth, filepath, uploadQueue.length);
        const url = `https://youtube.com/watch?v=${result.videoId}`;

        const uploaded = loadJson(UPLOADED_FILE);
        uploaded.push(filepath);
        saveJson(UPLOADED_FILE, uploaded);

        log(`Uploaded! ${url} (${result.elapsed}s)`);
        copyToClipboard(url);
        beepSuccess();
        drawDone(result.filename, result.title, result.sizeMB, result.videoId, url);
        flashTaskbar();

        addHistory({
          title: result.title,
          sizeMB: result.sizeMB,
          videoId: result.videoId,
          url,
          success: true,
          elapsed: result.elapsed,
          date: new Date().toLocaleString('sv-SE')
        });

        lastResult = { type: 'done', url, ...result };
        success = true;
        break;
      } catch (e) {
        lastErr = e;
        log(`Attempt ${attempt}/3 failed: ${e.message}`);
        if (attempt < 3) {
          clear();
          drawHeader();
          console.log(`${C.yellow}  ⟳ Upload failed, retrying (${attempt}/3)...${C.reset}`);
          console.log(`${C.dim}  ${e.message}${C.reset}`);
          await new Promise(r => setTimeout(r, 30000 * attempt));
        }
      }
    }

    if (!success) {
      log(`All retries failed: ${lastErr.message}`);
      beepError();
      drawError(filename, lastErr.message);
      flashTaskbar();
      addHistory({ title: filename, sizeMB: 0, success: false, error: lastErr.message, date: new Date().toLocaleString('sv-SE') });
      lastResult = { type: 'error', filename, error: lastErr.message };
    }

    // If more in queue, wait a moment then continue
    if (uploadQueue.length > 0) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  busy = false;
}

function enqueueFile(filepath) {
  const uploaded = loadJson(UPLOADED_FILE);
  if (uploaded.includes(filepath)) return;
  if (uploadQueue.includes(filepath)) return;
  uploadQueue.push(filepath);
  log(`Queued: ${path.basename(filepath)} (${uploadQueue.length} in queue)`);
  processQueue();
}

// --- Keyboard ---
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

process.stdin.on('keypress', (str, key) => {
  if (key && key.ctrl && key.name === 'c') process.exit();

  const k = (str || '').toLowerCase();

  // History screen
  if (showingHistory) {
    if (k === 'q') {
      showingHistory = false;
      drawIdle();
      minimizeSelf();
    } else if (key && key.name === 'escape') {
      showingHistory = false;
      drawIdle();
    }
    return;
  }

  // Delete confirmation screen
  if (showingDelete) {
    if (k === 'y') {
      const result = deleteUploaded();
      showingDelete = false;
      clear();
      drawHeader();
      console.log(`${C.bold}${C.green}  ✓ Deleted ${result.deleted} files (${result.freedMB} MB freed)${C.reset}`);
      console.log('');
      console.log(`${C.dim}  Returning to watch mode in 3 seconds...${C.reset}`);
      setTimeout(() => drawIdle(), 3000);
    } else if (key && key.name === 'escape') {
      showingDelete = false;
      drawIdle();
    }
    return;
  }

  if (k === 'c' && lastResult && lastResult.type === 'done') {
    copyToClipboard(lastResult.url);
    drawDone(lastResult.filename, lastResult.title, lastResult.sizeMB, lastResult.videoId, lastResult.url);
  }

  if (k === 'o' && lastResult && lastResult.type === 'done') {
    openInBrowser(lastResult.url);
  }

  if (k === 'h' && !busy) {
    showingHistory = true;
    restoreSelf();
    drawHistory();
  }

  if (k === 'd' && !busy) {
    showingDelete = true;
    restoreSelf();
    drawDeleteConfirm();
  }

  if (k === 'r' && !busy) {
    log('Restarting...');
    const { spawn } = require('child_process');
    spawn(process.argv[0], process.argv.slice(1), {
      cwd: process.cwd(),
      detached: false,
      stdio: 'inherit',
      shell: true
    });
    process.exit();
  }

  if (k === 'q') {
    showingHistory = false;
    showingDelete = false;
    lastResult = null;
    drawIdle();
    minimizeSelf();
  }
});

// --- Main ---
async function main() {
  if (process.argv.includes('--auth')) {
    await getAuth();
    console.log('Auth done!');
    process.exit(0);
  }

  process.title = WIN_TITLE;
  initWindowHelper();
  if (!fs.existsSync(WATCH_DIR)) fs.mkdirSync(WATCH_DIR, { recursive: true });

  log(`Watching: ${WATCH_DIR}`);
  drawIdle();

  // Auto-minimize after 2 seconds
  setTimeout(() => minimizeSelf(), 2000);

  // Chokidar watcher - instant detection
  const watcher = chokidar.watch(WATCH_DIR, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: false,
    usePolling: false,
  });

  watcher.on('add', (filepath) => {
    if (path.extname(filepath).toLowerCase() === '.mp4') {
      enqueueFile(filepath);
    }
  });

  watcher.on('error', (err) => {
    log(`Watcher error: ${err.message}`);
  });

  // Error handlers
  process.on('uncaughtException', (e) => log(`Uncaught: ${e.message}`));
  process.on('unhandledRejection', (e) => log(`Unhandled: ${e}`));
}

main();
