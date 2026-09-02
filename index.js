const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn, execFile } = require('child_process');
const { google } = require('googleapis');
const chokidar = require('chokidar');

const VERSION = require('./package.json').version;
const SIMULATE = process.argv.includes('--simulate');   // fake uploads, separate data files
const argValue = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SCRIPT_DIR = __dirname;
const CONFIG_FILE = argValue('--config') || path.join(SCRIPT_DIR, 'config.json');
const CLIENT_SECRET = path.join(SCRIPT_DIR, 'client_secret.json');
const TOKEN_FILE = path.join(SCRIPT_DIR, 'token.json');
const SIM = SIMULATE ? '.sim' : '';
const UPLOADED_FILE = path.join(SCRIPT_DIR, `uploaded${SIM}.json`);
const HISTORY_FILE = path.join(SCRIPT_DIR, `history${SIM}.json`);
const LOG_FILE = path.join(SCRIPT_DIR, `uploader${SIM}.log`);
const WIN_HELPER = path.join(SCRIPT_DIR, '_winctl.ps1');

const DEFAULT_CONFIG = {
  watchDir: path.join(os.homedir(), 'Videos', 'yt-uploads'),
  extensions: ['.mp4', '.mkv', '.mov'],
  privacy: 'unlisted',
  tags: ['gameplay'],
  categoryId: '20',
  popupOnUpload: false,
  toast: true,
  sounds: true,
  clipboard: true,
  windowControl: true,
  deleteAfterDays: 7,
  dailyUploadLimit: 6,
  minSizeMB: 1,
};

function loadConfig() {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  const cfg = { ...DEFAULT_CONFIG, ...fileCfg };
  if (argValue('--watch')) cfg.watchDir = argValue('--watch');
  if (!cfg.watchDir || typeof cfg.watchDir !== 'string') cfg.watchDir = DEFAULT_CONFIG.watchDir;
  if (!Array.isArray(cfg.extensions) || !cfg.extensions.length) cfg.extensions = DEFAULT_CONFIG.extensions;
  cfg.extensions = cfg.extensions.map(e => (e.startsWith('.') ? e : '.' + e).toLowerCase());
  return cfg;
}
const CFG = loadConfig();
const WATCH_DIR = CFG.watchDir;
const MIN_SIZE = CFG.minSizeMB * 1024 * 1024;

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------
function log(msg) {
  const ts = new Date().toLocaleString('sv-SE');
  try { fs.appendFileSync(LOG_FILE, `${ts} - ${msg}\n`); } catch {}
}
function loadJson(p, fallback = []) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}
function saveJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

function fmtBytes(b) {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(b / 1024 ** 2)} MB`;
}
function fmtSpeed(bps) {
  if (bps > 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
}
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function parseTs(h) {
  if (h.ts) return h.ts;
  if (h.date) { const t = new Date(h.date.replace(' ', 'T')).getTime(); if (!isNaN(t)) return t; }
  return 0;
}

// YouTube's API quota resets at midnight Pacific time.
function pacificMidnight(offsetDays = 0) {
  const tz = 'America/Los_Angeles';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map(p => [p.type, p.value]));
  const y = +parts.year, m = +parts.month, d = +parts.day + offsetDays;
  for (const h of [7, 8]) {
    const t = Date.UTC(y, m - 1, d, h);
    const hh = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(t));
    if (hh === '00' || hh === '24') return t;
  }
  return Date.UTC(y, m - 1, d, 8);
}
function uploadsToday() {
  const since = pacificMidnight();
  return loadJson(HISTORY_FILE).filter(h => h.success && parseTs(h) >= since).length;
}

// "ARC Raiders - 2026-08-27 12-57-02 AM" -> { title: "ARC Raiders — Aug 27, 2026 00:57", game: "ARC Raiders" }
// Handles Radeon ReLive ("Game - 2026-08-27 12-57-02 AM"), Steam ("Game 2026.08.27 - 12.57.02.01"),
// OBS ("2026-08-27 12-57-02") and plain names ("Tower_Killaz_Mad_Otto").
function prettyTitle(basename) {
  const raw = basename.trim();
  const m = raw.match(/^(.*?)(?:\s*[-_ ]\s*)?(\d{4})[-.](\d{2})[-.](\d{2})[ _T-]*(\d{1,2})[-.:](\d{2})[-.:](\d{2})(?:[.-]\d+)?\s*(AM|PM)?$/i);
  if (m) {
    const game = m[1].replace(/_/g, ' ').trim();
    let hour = +m[5];
    const ampm = (m[8] || '').toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    const date = new Date(+m[2], +m[3] - 1, +m[4]);
    const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = `${String(hour).padStart(2, '0')}:${m[6]}`;
    return { title: `${game || 'Clip'} — ${day} ${time}`.slice(0, 100), game };
  }
  return { title: raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100), game: '' };
}

// ---------------------------------------------------------------------------
// Persisted state: uploaded.json (migrates old string[] format) + history.json
// ---------------------------------------------------------------------------
function loadUploaded() {
  const raw = loadJson(UPLOADED_FILE);
  return raw.map(e => (typeof e === 'string' ? { path: e, status: 'uploaded', ts: null } : e));
}
function saveUploaded(list) { saveJson(UPLOADED_FILE, list); }
function markFile(filepath, status, extra = {}) {
  const list = loadUploaded().filter(e => e.path !== filepath);
  list.push({ path: filepath, status, ts: Date.now(), ...extra });
  saveUploaded(list);
}
function isKnownFile(filepath) { return loadUploaded().some(e => e.path === filepath); }
function uploadedOnDisk() {
  return loadUploaded().filter(e => e.status === 'uploaded' && fs.existsSync(e.path));
}

function addHistory(entry) {
  const history = loadJson(HISTORY_FILE);
  history.unshift({ ...entry, ts: Date.now(), date: new Date().toLocaleString('sv-SE') });
  if (history.length > 100) history.length = 100;
  saveJson(HISTORY_FILE, history);
}
function updateHistory(videoId, patch) {
  const history = loadJson(HISTORY_FILE);
  const h = history.find(x => x.videoId === videoId);
  if (h) { Object.assign(h, patch); saveJson(HISTORY_FILE, history); }
}
function lastUpload() { return loadJson(HISTORY_FILE).find(h => h.success) || null; }

function autoClean() {
  if (!CFG.deleteAfterDays || CFG.deleteAfterDays <= 0) return;
  const cutoff = Date.now() - CFG.deleteAfterDays * 86400 * 1000;
  let n = 0, freed = 0;
  for (const e of loadUploaded()) {
    if (e.status !== 'uploaded' || !e.ts || e.ts > cutoff || !fs.existsSync(e.path)) continue;
    try { const s = fs.statSync(e.path).size; fs.unlinkSync(e.path); n++; freed += s; log(`Auto-deleted: ${path.basename(e.path)}`); } catch (err) { log(`Auto-delete failed: ${err.message}`); }
  }
  if (n) { log(`Auto-clean: ${n} files, ${fmtBytes(freed)} freed`); S.notice = `Auto-cleaned ${n} old clip(s), ${fmtBytes(freed)} freed`; }
}

// ---------------------------------------------------------------------------
// Windows integration (all async — never block the event loop)
// ---------------------------------------------------------------------------
const WIN_TITLE = 'GameUploader';
function initWindowHelper() {
  fs.writeFileSync(WIN_HELPER, `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class WinCtl {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool FlashWindow(IntPtr h, bool invert);
  public delegate bool EnumCallback(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowTextA(IntPtr h, StringBuilder sb, int max);
}
"@
$action = $args[0]; $search = $args[1]; $found = [IntPtr]::Zero
$cb = [WinCtl+EnumCallback]{ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [WinCtl]::GetWindowTextA($h, $sb, 256) | Out-Null
  if ($sb.ToString().Contains($search)) { $script:found = $h; return $false }
  return $true }
[WinCtl]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($found -eq [IntPtr]::Zero) { exit 1 }
switch ($action) {
  "minimize" { [WinCtl]::ShowWindow($found, 6) }
  "restore"  { [WinCtl]::ShowWindow($found, 9); [WinCtl]::SetForegroundWindow($found) }
  "flash"    { [WinCtl]::FlashWindow($found, $true) }
}`);
}
function ps(args) {
  try { execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: 8000 }, () => {}); } catch {}
}
function winctl(action) { if (CFG.windowControl) ps(['-File', WIN_HELPER, action, WIN_TITLE]); }
const minimizeSelf = () => winctl('minimize');
const restoreSelf = () => winctl('restore');
const flashTaskbar = () => winctl('flash');

function beepSuccess() { if (CFG.sounds) ps(['-Command', '[console]::beep(700,150);[console]::beep(900,150);[console]::beep(1100,200)']); }
function beepError() { if (CFG.sounds) ps(['-Command', '[console]::beep(400,300);[console]::beep(300,400)']); }
function copyToClipboard(text) { if (CFG.clipboard) ps(['-Command', `Set-Clipboard -Value '${String(text).replace(/'/g, "''")}'`]); }
function openInBrowser(url) { try { spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch {} }

// Windows toasts via the native WinRT API (through Windows PowerShell). Clicking the toast opens `url`.
// Desktop apps need a Start Menu shortcut carrying an AppUserModelID for toasts to show; SnoreToast's
// -install (vendored with node-notifier) creates it once.
const START_MENU_LNK = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${WIN_TITLE}.lnk`);
function ensureToastIdentity() {
  if (!CFG.toast || !process.env.APPDATA || fs.existsSync(START_MENU_LNK)) return;
  const exe = path.join(SCRIPT_DIR, 'node_modules', 'node-notifier', 'vendor', 'snoreToast', 'snoretoast-x64.exe');
  if (!fs.existsSync(exe)) return;
  try { execFile(exe, ['-install', WIN_TITLE, path.join(SCRIPT_DIR, 'start.bat'), WIN_TITLE], { windowsHide: true }, () => log('Registered toast identity (Start Menu shortcut)')); } catch {}
}
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function toast(title, message, url) {
  if (!CFG.toast) return;
  const launch = url ? ` launch="${xmlEsc(url)}" activationType="protocol"` : '';
  const xml = `<toast${launch}><visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text><text>${xmlEsc(message)}</text></binding></visual></toast>`;
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${xml.replace(/'/g, "''")}')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WIN_TITLE}').Show((New-Object Windows.UI.Notifications.ToastNotification $x))`,
  ].join('\n');
  ps(['-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
}

// ---------------------------------------------------------------------------
// Screen renderer — writes whole frames in one go, no clear(): no flicker
// ---------------------------------------------------------------------------
const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', underline: '\x1b[4m' };
const W = 68;
const out = process.stdout;
const vis = s => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const clip = (s, n) => (vis(s) <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…');
const lr = (left, right) => { const gap = W - vis(left) - vis(right); return left + ' '.repeat(Math.max(1, gap)) + right; };
const key = (k, label) => `${C.dim}[${C.reset}${C.bold}${k}${C.reset}${C.dim}]${C.reset} ${label}`;
const keys = (...pairs) => '  ' + pairs.map(([k, l]) => key(k, l)).join('   ');

function enterScreen() { out.write('\x1b[?1049h\x1b[?25l'); }
function leaveScreen() { out.write('\x1b[?25h\x1b[?1049l'); }
function render(lines) {
  out.write('\x1b[H' + lines.map(l => l + '\x1b[K').join('\n') + '\n\x1b[J');
}
function setTitle(t) { process.title = `${WIN_TITLE} - ${t}`; }

// --- Logo: "GAME" (figlet Elite) over "UPLOADER" (figlet ANSI Shadow), "Arcade" palette ---
const LOGO_GAME = [
  ' ▄▄ •  ▄▄▄· • ▌ ▄ ·. ▄▄▄ .',
  '▐█ ▀ ▪▐█ ▀█ ·██ ▐███▪▀▄.▀·',
  '▄█ ▀█▄▄█▀▀█ ▐█ ▌▐▌▐█·▐▀▀▪▄',
  '▐█▄▪▐█▐█ ▪▐▌██ ██▌▐█▌▐█▄▄▌',
  '·▀▀▀▀  ▀  ▀ ▀▀  █▪▀▀▀ ▀▀▀',
];
const LOGO_UP = [
  '██╗   ██╗██████╗ ██╗      ██████╗  █████╗ ██████╗ ███████╗██████╗',
  '██║   ██║██╔══██╗██║     ██╔═══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗',
  '██║   ██║██████╔╝██║     ██║   ██║███████║██║  ██║█████╗  ██████╔╝',
  '██║   ██║██╔═══╝ ██║     ██║   ██║██╔══██║██║  ██║██╔══╝  ██╔══██╗',
  '╚██████╔╝██║     ███████╗╚██████╔╝██║  ██║██████╔╝███████╗██║  ██║',
  ' ╚═════╝ ╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝',
];
const PAL = { game: [212, 83, 126], stops: [[29, 158, 117], [45, 150, 170], [55, 138, 221]], shadow: 0.55 };
const LOGO_W = Math.max(...LOGO_UP.map(l => l.length));
const rgb = (c) => `\x1b[38;2;${Math.round(c[0])};${Math.round(c[1])};${Math.round(c[2])}m`;
function grad(t) {
  const s = PAL.stops, n = s.length - 1, i = Math.min(n - 1, Math.floor(t * n)), f = t * n - i, a = s[i], b = s[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
// Colors a line left→right along the gradient; box-drawing "shadow" glyphs get a darker shade.
function gradientLine(line, width) {
  let out = '', last = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') { out += ' '; continue; }
    let c = grad(i / Math.max(1, width - 1));
    if ('╗╔╚╝║═'.includes(ch)) c = c.map(v => v * PAL.shadow);
    const code = rgb(c);
    if (code !== last) { out += code; last = code; }
    out += ch;
  }
  return out + C.reset;
}
const wordmark = () => `${rgb(PAL.game)}${C.bold}GAME${C.reset} ${C.bold}${gradientLine('UPLOADER', 8)}`;

const startedAt = Date.now();
function header(full = false) {
  const right = `${C.dim}v${VERSION} · up ${fmtDuration((Date.now() - startedAt) / 1000)}${SIMULATE ? ' · SIMULATION' : ''}${C.reset}`;
  if (!full) return ['', lr(`  ${wordmark()}`, right), ''];
  const L = [''];
  for (const l of LOGO_GAME) L.push(`  ${rgb(PAL.game)}${l}${C.reset}`);
  for (const l of LOGO_UP) L.push(`  ${gradientLine(l, LOGO_W)}`);
  L.push(lr('', right));
  L.push('');
  return L;
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const S = {
  view: 'idle',          // idle | uploading | done | error | waiting | history | delete | edit
  queue: [],
  busy: false,
  current: null,         // { filepath, filename, title, sizeMB, pct, speed, eta }
  abort: null,
  cancelled: false,
  last: null,            // last completed upload (history entry)
  error: null,           // { filename, message, hint, kind, filepath }
  waitUntil: 0, waitReason: '', waitFile: null,
  histCursor: 0,
  editBuf: '',
  notice: '',
  authNeeded: false,
};

function draw() {
  switch (S.view) {
    case 'idle': return drawIdle();
    case 'uploading': return drawUploading();
    case 'done': return drawDone();
    case 'error': return drawError();
    case 'waiting': return drawWaiting();
    case 'history': return drawHistory();
    case 'delete': return drawDelete();
    case 'edit': return drawEdit();
  }
}

// Lists the pending queue. startNum=2 while something is uploading (that one is #1).
function queueLines(startNum = 1) {
  const q = S.queue;
  if (!q.length) return [];
  const lines = [];
  q.slice(0, 4).forEach((f, i) => {
    let size = ''; try { size = fmtBytes(fs.statSync(f).size); } catch {}
    lines.push(lr(`  ${i === 0 ? `${C.dim}Queue${C.reset}` : '     '}  ${C.dim}${i + startNum}.${C.reset} ${clip(prettyTitle(path.parse(f).name).title, 40)}`, `${C.dim}${size}${C.reset}`));
  });
  if (q.length > 4) lines.push(`         ${C.dim}… and ${q.length - 4} more${C.reset}`);
  return lines;
}

function drawIdle() {
  setTitle('Watching');
  const L = header(true);
  const exts = CFG.extensions.map(e => e.slice(1)).join(' · ');
  L.push(lr(`  ${C.green}●${C.reset} Watching ${C.dim}${clip(WATCH_DIR, 40)}${C.reset}`, `${C.dim}${exts}${C.reset}`));
  L.push('');
  const last = S.last || lastUpload();
  if (last) {
    L.push(lr(`  ${C.dim}Last upload${C.reset}   ${clip(last.title, 36)}`, `${C.dim}${last.sizeMB ? fmtBytes(last.sizeMB * 1048576) : ''}${last.elapsed ? ` · ${last.elapsed}s` : ''}${C.reset}`));
    L.push(`                ${C.cyan}${last.url.replace('https://', '')}${C.reset}`);
  } else {
    L.push(`  ${C.dim}No uploads yet — drop a clip in the folder.${C.reset}`);
  }
  L.push('');
  const today = uploadsToday();
  const todayCol = today >= CFG.dailyUploadLimit ? C.red : today >= CFG.dailyUploadLimit - 1 ? C.yellow : '';
  L.push(lr(`  ${C.dim}Today${C.reset}         ${todayCol}${today} of ${CFG.dailyUploadLimit} uploads used${C.reset}`, `${C.dim}resets ${fmtClock(pacificMidnight(1))}${C.reset}`));
  const onDisk = uploadedOnDisk();
  if (onDisk.length) {
    const size = onDisk.reduce((a, e) => { try { return a + fs.statSync(e.path).size; } catch { return a; } }, 0);
    L.push(lr(`  ${C.dim}On disk${C.reset}       ${onDisk.length} uploaded clip(s) · ${fmtBytes(size)}`, `${C.yellow}[D] to clean${C.reset}`));
  }
  if (S.queue.length) { L.push(''); L.push(...queueLines()); }
  if (S.notice) { L.push(''); L.push(`  ${C.green}${S.notice}${C.reset}`); }
  L.push('');
  const k = [];
  if (last) k.push(['C', 'copy link'], ['O', 'open']);
  k.push(['H', 'history']);
  if (onDisk.length) k.push(['D', 'clean up']);
  k.push(['R', 'restart'], ['Q', 'minimize']);
  L.push(keys(...k));
  render(L);
}

function drawUploading() {
  const c = S.current;
  setTitle(`${c.pct}%`);
  const L = header();
  L.push(lr(`  ${C.green}▲ Uploading${C.reset}  ${clip(c.title, 40)}`, `${C.dim}${fmtBytes(c.sizeMB * 1048576)}${C.reset}`));
  L.push('');
  const barW = 40, filled = Math.round(barW * c.pct / 100);
  L.push(`  ${C.green}${'█'.repeat(filled)}${C.dim}${'░'.repeat(barW - filled)}${C.reset}  ${C.bold}${c.pct}%${C.reset}`);
  L.push(`  ${C.dim}${c.speed > 0 ? `${fmtSpeed(c.speed)} · ${fmtDuration(c.eta)} left` : c.status || 'starting…'}${C.reset}`);
  if (S.queue.length) { L.push(''); L.push(...queueLines(2)); }
  L.push('');
  const k = [['X', 'cancel this']];
  if (S.queue.length) k.push(['S', 'skip next']);
  k.push(['Q', 'minimize']);
  L.push(keys(...k));
  render(L);
}

function drawDone() {
  setTitle('Done');
  const h = S.last;
  const L = header(true);
  L.push(lr(`  ${C.green}${C.bold}✓ Uploaded${C.reset}   ${clip(h.title, 38)}`, `${C.dim}${fmtBytes(h.sizeMB * 1048576)} · ${h.elapsed}s${C.reset}`));
  L.push(lr(`  ${C.cyan}${h.url.replace('https://', '')}${C.reset}`, `${C.green}link copied${C.reset}`));
  L.push('');
  L.push(`  ${C.dim}Privacy${C.reset}  ${h.privacy || CFG.privacy}        ${C.dim}Tags${C.reset}  ${(h.tags || []).join(', ')}`);
  if (S.notice) { L.push(''); L.push(`  ${C.green}${S.notice}${C.reset}`); }
  if (S.queue.length) { L.push(''); L.push(...queueLines()); }
  L.push('');
  L.push(keys(['T', 'edit title'], ['P', 'privacy'], ['C', 'copy'], ['O', 'open'], ['Q', 'minimize']));
  render(L);
}

function drawError() {
  setTitle('Error');
  const e = S.error;
  const L = header();
  L.push(`  ${C.red}${C.bold}✗ Upload failed${C.reset}   ${clip(e.filename, 45)}`);
  L.push('');
  L.push(`  ${C.red}${clip(e.message, W - 4)}${C.reset}`);
  if (e.hint) L.push(`  ${C.dim}${clip(e.hint, W - 4)}${C.reset}`);
  if (S.queue.length) { L.push(''); L.push(...queueLines()); }
  L.push('');
  const k = [];
  if (e.kind === 'auth') k.push(['A', 'sign in again']);
  else k.push(['Enter', 'retry now']);
  k.push(['Esc', 'give up'], ['Q', 'minimize']);
  L.push(keys(...k));
  render(L);
}

function drawWaiting() {
  setTitle('Waiting');
  const L = header();
  const left = Math.max(0, (S.waitUntil - Date.now()) / 1000);
  L.push(`  ${C.yellow}${C.bold}⏸ Paused${C.reset}   ${clip(S.waitReason, 50)}`);
  L.push('');
  L.push(`  ${C.dim}Resuming in ${fmtDuration(left)} (${fmtClock(S.waitUntil)})${C.reset}`);
  if (S.waitFile) L.push(`  ${C.dim}Next: ${clip(path.basename(S.waitFile), 50)}${C.reset}`);
  if (S.queue.length) { L.push(''); L.push(...queueLines()); }
  L.push('');
  L.push(keys(['Enter', 'retry now'], ['Esc', 'give up on this clip'], ['Q', 'minimize']));
  render(L);
}

function drawHistory() {
  setTitle('History');
  const history = loadJson(HISTORY_FILE);
  const L = header();
  if (!history.length) {
    L.push(`  ${C.dim}No uploads yet.${C.reset}`);
  } else {
    L.push(lr(`  ${C.bold}Upload history${C.reset}`, `${C.dim}${history.length} total${C.reset}`));
    L.push('');
    const rows = 12;
    S.histCursor = Math.min(Math.max(0, S.histCursor), history.length - 1);
    const start = Math.max(0, Math.min(S.histCursor - Math.floor(rows / 2), history.length - rows));
    history.slice(start, start + rows).forEach((h, i) => {
      const idx = start + i, sel = idx === S.histCursor;
      const mark = h.success ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      const date = (h.date || '').slice(0, 16);
      const line = `${sel ? `${C.cyan}▸${C.reset}` : ' '} ${mark} ${C.dim}${date}${C.reset}  ${sel ? C.bold : ''}${clip(h.title, 30)}${C.reset}`;
      L.push(lr(' ' + line, `${C.dim}${h.sizeMB ? fmtBytes(h.sizeMB * 1048576) : ''}${C.reset}`));
      if (sel) L.push(`        ${C.cyan}${h.url ? h.url.replace('https://', '') : (h.error || '')}${C.reset}`);
    });
    if (start + rows < history.length) L.push(`  ${C.dim}… ${history.length - start - rows} more below${C.reset}`);
  }
  L.push('');
  L.push(keys(['↑↓', 'select'], ['Enter', 'open'], ['C', 'copy link'], ['Esc', 'back']));
  render(L);
}

function drawDelete() {
  setTitle('Clean up');
  const L = header();
  const existing = uploadedOnDisk();
  if (!existing.length) {
    L.push(`  ${C.dim}Nothing to clean — no uploaded clips left on disk.${C.reset}`);
    L.push(''); L.push(keys(['Esc', 'back']));
    return render(L);
  }
  L.push(`  ${C.bold}${C.yellow}Delete these already-uploaded clips from disk?${C.reset}`);
  L.push('');
  let total = 0;
  for (const e of existing.slice(0, 10)) {
    let size = 0; try { size = fs.statSync(e.path).size; } catch {}
    total += size;
    L.push(lr(`  ${C.red}✗${C.reset} ${clip(path.basename(e.path), 50)}`, `${C.dim}${fmtBytes(size)}${C.reset}`));
  }
  if (existing.length > 10) {
    for (const e of existing.slice(10)) { try { total += fs.statSync(e.path).size; } catch {} }
    L.push(`  ${C.dim}… and ${existing.length - 10} more${C.reset}`);
  }
  L.push('');
  L.push(`  ${C.bold}${existing.length} files — ${fmtBytes(total)}${C.reset}   ${C.dim}(they stay on YouTube)${C.reset}`);
  L.push('');
  L.push(keys(['Y', 'yes, delete all'], ['Esc', 'cancel']));
  render(L);
}

function drawEdit() {
  setTitle('Edit title');
  const L = header();
  L.push(`  ${C.bold}Edit title${C.reset}   ${C.dim}${clip(S.last.url.replace('https://', ''), 40)}${C.reset}`);
  L.push('');
  L.push(`  ${C.dim}Current:${C.reset} ${clip(S.last.title, 56)}`);
  L.push('');
  L.push(`  ${C.cyan}›${C.reset} ${S.editBuf}${C.cyan}_${C.reset}`);
  L.push('');
  L.push(`  ${C.dim}${S.editBuf.length}/100${C.reset}`);
  L.push('');
  L.push(keys(['Enter', 'save'], ['Esc', 'cancel']));
  render(L);
}

// Tickers: 1s for countdowns, 30s for the idle dashboard (uptime, quota reset)
setInterval(() => { if (S.view === 'waiting') draw(); }, 1000);
setInterval(() => { if (S.view === 'idle') draw(); }, 30000);

// ---------------------------------------------------------------------------
// YouTube auth
// ---------------------------------------------------------------------------
let authClient = null;

function readToken() {
  const t = loadJson(TOKEN_FILE, null);
  if (!t) return null;
  // Normalize legacy Python-format token (token / expiry) to the Node format.
  const norm = {
    access_token: t.access_token || t.token,
    refresh_token: t.refresh_token,
    scope: t.scope || (Array.isArray(t.scopes) ? t.scopes.join(' ') : undefined),
    token_type: t.token_type || 'Bearer',
    expiry_date: t.expiry_date || (t.expiry ? new Date(t.expiry).getTime() : undefined),
  };
  return norm.refresh_token ? norm : null;
}

async function getAuth(force = false) {
  if (SIMULATE) return {};
  if (authClient && !force) return authClient;
  const creds = JSON.parse(fs.readFileSync(CLIENT_SECRET, 'utf-8'));
  const { client_id, client_secret } = creds.installed || creds.web;

  const makeClient = (redirect) => {
    const c = new google.auth.OAuth2(client_id, client_secret, redirect);
    c.on('tokens', (tokens) => {
      const cur = readToken() || {};
      saveJson(TOKEN_FILE, { ...cur, ...tokens, refresh_token: tokens.refresh_token || cur.refresh_token });
    });
    return c;
  };

  const saved = force ? null : readToken();
  if (saved) {
    authClient = makeClient('http://localhost');
    authClient.setCredentials(saved);  // library auto-refreshes with the refresh_token
    return authClient;
  }

  // Browser sign-in flow
  const open = (await import('open')).default;
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code');
      if (!code) { res.end(''); return; }
      try {
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        saveJson(TOKEN_FILE, tokens);
        res.end('<body style="font-family:sans-serif;padding:2em">GameUploader is signed in. You can close this tab.</body>');
        server.close();
        authClient = client;
        resolve(client);
      } catch (e) { res.end('Sign-in failed: ' + e.message); server.close(); reject(e); }
    });
    let client;
    server.listen(0, () => {
      client = makeClient(`http://localhost:${server.address().port}`);
      const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/youtube.upload'] });
      log('Opening browser for Google sign-in');
      open(url);
    });
  });
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
function waitUntilStable(filepath) {
  // Size must stay unchanged for two consecutive 3s checks (recorders write in bursts).
  return new Promise((resolve) => {
    let prev = -1, stableCount = 0;
    const tick = () => {
      if (!fs.existsSync(filepath)) return resolve(false);
      const size = fs.statSync(filepath).size;
      if (size === prev && size > 0) stableCount++; else stableCount = 0;
      prev = size;
      if (stableCount >= 2) return resolve(true);
      if (S.current) { S.current.status = `waiting for recording to finish… (${fmtBytes(size)})`; draw(); }
      setTimeout(tick, 3000);
    };
    tick();
  });
}

function classifyError(e) {
  const msg = e && e.message ? e.message : String(e);
  const reason = (e && e.errors && e.errors[0] && e.errors[0].reason) || '';
  const code = (e && (e.code || e.status)) || 0;
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded' || /quota/i.test(msg))
    return { kind: 'quota', message: 'Daily YouTube upload limit reached', hint: `YouTube's API allows about ${CFG.dailyUploadLimit} uploads per day. Resets at ${fmtClock(pacificMidnight(1))}.` };
  if (/invalid_grant|invalid_client|unauthorized|Login Required/i.test(msg) || code === 401)
    return { kind: 'auth', message: 'Google sign-in expired', hint: 'Press A to sign in again in your browser.' };
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|network|fetch failed/i.test(msg))
    return { kind: 'network', message: 'No internet connection', hint: 'Will retry automatically.' };
  if (/ENOENT/.test(msg)) return { kind: 'gone', message: 'File disappeared before upload finished', hint: '' };
  return { kind: 'other', message: msg.slice(0, 200), hint: '' };
}

async function uploadVideo(auth, filepath) {
  const c = S.current;
  const fileSize = fs.statSync(filepath).size;
  const startTime = Date.now();
  let lastDraw = 0, lastLoggedQuarter = 0;
  const onProgress = (bytes) => {
    const pct = Math.min(100, Math.round((bytes / fileSize) * 100));
    const elapsed = (Date.now() - startTime) / 1000;
    c.pct = pct;
    c.speed = elapsed > 0.5 ? bytes / elapsed : 0;
    c.eta = c.speed > 0 ? (fileSize - bytes) / c.speed : 0;
    const q = Math.floor(pct / 25);
    if (q > lastLoggedQuarter) { lastLoggedQuarter = q; log(`  Progress: ${q * 25}%`); }
    if (Date.now() - lastDraw > 150 || pct === 100) { lastDraw = Date.now(); if (S.view === 'uploading') draw(); }
  };

  if (SIMULATE) {
    S.abort = new AbortController();
    for (let i = 0; i <= 40; i++) {
      if (S.abort.signal.aborted) throw new Error('aborted');
      await new Promise(r => setTimeout(r, 120));
      onProgress(fileSize * i / 40);
    }
    return { videoId: 'SIM' + Math.random().toString(36).slice(2, 10), elapsed: ((Date.now() - startTime) / 1000).toFixed(0) };
  }

  const youtube = google.youtube({ version: 'v3', auth });
  S.abort = new AbortController();
  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: { title: c.title, description: `Gameplay clip · uploaded automatically by GameUploader`, tags: c.tags, categoryId: CFG.categoryId },
      status: { privacyStatus: CFG.privacy, selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(filepath) },
  }, { signal: S.abort.signal, onUploadProgress: evt => onProgress(evt.bytesRead) });
  return { videoId: res.data.id, elapsed: ((Date.now() - startTime) / 1000).toFixed(0) };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
function enqueueFile(filepath) {
  if (isKnownFile(filepath) || S.queue.includes(filepath) || (S.current && S.current.filepath === filepath)) return;
  S.queue.push(filepath);
  log(`Queued: ${path.basename(filepath)} (${S.queue.length} in queue)`);
  if (S.view === 'idle' || S.view === 'done' || S.view === 'error') draw();
  processQueue();
}

function pauseUntil(ts, reason, filepath) {
  S.view = 'waiting'; S.waitUntil = ts; S.waitReason = reason; S.waitFile = filepath;
  draw();
  return new Promise((resolve) => {
    S.resumeWait = (giveUp) => { S.resumeWait = null; clearTimeout(t); resolve(giveUp ? 'giveup' : 'go'); };
    const t = setTimeout(() => S.resumeWait && S.resumeWait(false), Math.max(0, ts - Date.now()));
  });
}
// Resolves with 'retry' | 'auth' | 'giveup' when the user presses a key on the error screen.
function waitForKey() {
  return new Promise((resolve) => { S.resumeError = (k) => { S.resumeError = null; resolve(k); }; });
}

async function processQueue() {
  if (S.busy) return;
  S.busy = true;
  try {
    while (S.queue.length) {
      const filepath = S.queue.shift();
      const outcome = await handleFile(filepath);
      if (outcome === 'stop') break;
      if (S.queue.length) await new Promise(r => setTimeout(r, 1500));
    }
  } finally {
    S.busy = false;
    S.current = null;
    if (S.view === 'uploading' || S.view === 'waiting') { S.view = 'idle'; draw(); }
  }
}

async function handleFile(filepath) {
  const filename = path.basename(filepath);
  const { title, game } = prettyTitle(path.parse(filename).name);
  const tags = [...new Set([...(game ? [game.toLowerCase()] : []), ...CFG.tags])];
  S.current = { filepath, filename, title, tags, sizeMB: 0, pct: 0, speed: 0, eta: 0, status: 'waiting for recording to finish…' };
  S.cancelled = false;
  S.view = 'uploading';
  log(`New video detected: ${filename}`);
  if (CFG.popupOnUpload) restoreSelf(); else flashTaskbar();
  draw();

  if (!(await waitUntilStable(filepath))) { log('File disappeared'); return 'next'; }
  const size = fs.statSync(filepath).size;
  if (size < MIN_SIZE) { log('File too small, skipping'); markFile(filepath, 'skipped'); return 'next'; }
  S.current.sizeMB = Math.round(size / 1048576);
  S.current.status = 'starting…';

  // Daily-quota guard: don't burn a failed request if we already know it'll fail.
  if (uploadsToday() >= CFG.dailyUploadLimit) {
    const r = await pauseUntil(pacificMidnight(1), `Daily upload limit (${CFG.dailyUploadLimit}) reached`, filepath);
    if (r === 'giveup') { markFile(filepath, 'skipped'); return 'next'; }
    S.view = 'uploading'; draw();
  }

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const auth = await getAuth();
      log(`Uploading: ${title} (${S.current.sizeMB} MB)${attempt > 1 ? ` [attempt ${attempt}]` : ''}`);
      const result = await uploadVideo(auth, filepath);
      const url = `https://youtube.com/watch?v=${result.videoId}`;
      markFile(filepath, 'uploaded', { videoId: result.videoId });
      const entry = { title, sizeMB: S.current.sizeMB, videoId: result.videoId, url, success: true, elapsed: result.elapsed, privacy: CFG.privacy, tags, filename };
      addHistory(entry);
      S.last = { ...entry, ts: Date.now() };
      S.notice = '';
      log(`Uploaded! ${url} (${result.elapsed}s)`);
      copyToClipboard(url);
      beepSuccess();
      flashTaskbar();
      toast('Uploaded · link copied', title, url);
      S.view = 'done'; draw();
      return 'next';
    } catch (e) {
      if (S.cancelled) {
        log(`Cancelled: ${filename}`);
        markFile(filepath, 'cancelled');
        addHistory({ title, sizeMB: S.current.sizeMB, success: false, error: 'Cancelled', filename });
        S.notice = `Cancelled ${clip(title, 40)}`;
        S.view = 'idle'; draw();
        return 'next';
      }
      const err = classifyError(e);
      log(`Attempt ${attempt} failed [${err.kind}]: ${(e && e.message) || e}`);

      if (err.kind === 'gone') return 'next';

      if (err.kind === 'network' && attempt < 4) {
        const r = await pauseUntil(Date.now() + 15000 * attempt, `${err.message} — retrying`, filepath);
        if (r === 'giveup') break;
        S.view = 'uploading'; draw();
        continue;
      }
      if (err.kind === 'quota') {
        const r = await pauseUntil(pacificMidnight(1), err.message, filepath);
        if (r === 'giveup') break;
        S.view = 'uploading'; draw();
        continue;
      }
      if (err.kind === 'other' && attempt < 3) {
        const r = await pauseUntil(Date.now() + 20000 * attempt, `Upload failed — retrying`, filepath);
        if (r === 'giveup') break;
        S.view = 'uploading'; draw();
        continue;
      }

      // Show the error and wait for the user: Enter = retry, A = re-auth, Esc = give up
      S.error = { ...err, filename, filepath };
      S.view = 'error';
      beepError(); flashTaskbar();
      toast('Upload failed', `${err.message} — ${filename}`);
      draw();
      const k = await waitForKey();
      if (k === 'giveup') break;
      if (k === 'auth') {
        try { await getAuth(true); log('Re-authenticated'); } catch (e2) { log(`Re-auth failed: ${e2.message}`); }
      }
      S.view = 'uploading'; draw();
      attempt = 0;
    }
  }

  // Gave up
  log(`Gave up on: ${filename}`);
  markFile(filepath, 'failed');
  addHistory({ title, sizeMB: S.current.sizeMB, success: false, error: (S.error && S.error.message) || S.waitReason || 'Failed', filename });
  S.notice = `Gave up on ${clip(title, 40)}`;
  S.view = 'idle'; draw();
  return 'next';
}

// ---------------------------------------------------------------------------
// Post-upload edits (title / privacy) via the YouTube API
// ---------------------------------------------------------------------------
async function updateVideo(patch) {
  const h = S.last;
  if (!h || !h.videoId) return;
  S.notice = 'Saving…'; draw();
  try {
    if (!SIMULATE) {
      const youtube = google.youtube({ version: 'v3', auth: await getAuth() });
      if (patch.title !== undefined) {
        await youtube.videos.update({ part: 'snippet', requestBody: { id: h.videoId, snippet: { title: patch.title, categoryId: CFG.categoryId, tags: h.tags, description: 'Gameplay clip · uploaded automatically by GameUploader' } } });
      }
      if (patch.privacy !== undefined) {
        await youtube.videos.update({ part: 'status', requestBody: { id: h.videoId, status: { privacyStatus: patch.privacy, selfDeclaredMadeForKids: false } } });
      }
    }
    Object.assign(h, patch);
    updateHistory(h.videoId, patch);
    S.notice = patch.title !== undefined ? 'Title updated' : `Privacy set to ${patch.privacy}`;
    log(`Updated ${h.videoId}: ${JSON.stringify(patch)}`);
  } catch (e) {
    S.notice = `${C.red}Couldn't update: ${classifyError(e).message}${C.reset}`;
    log(`Update failed: ${e.message}`);
  }
  draw();
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function goIdle(minimize = false) {
  S.view = 'idle';
  draw();
  if (minimize) minimizeSelf();
}

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

process.stdin.on('keypress', (str, k = {}) => {
  if (k.ctrl && k.name === 'c') { shutdown(); return; }
  const ch = (str || '').toLowerCase();
  const name = k.name || '';

  switch (S.view) {
    case 'edit':
      if (name === 'return') { const t = S.editBuf.trim(); S.view = 'done'; if (t && t !== S.last.title) updateVideo({ title: t.slice(0, 100) }); else draw(); }
      else if (name === 'escape') { S.view = 'done'; draw(); }
      else if (name === 'backspace') { S.editBuf = S.editBuf.slice(0, -1); draw(); }
      else if (str && !k.ctrl && !k.meta && str >= ' ' && S.editBuf.length < 100) { S.editBuf += str; draw(); }
      return;

    case 'history': {
      const history = loadJson(HISTORY_FILE);
      const h = history[S.histCursor];
      if (name === 'up') { S.histCursor--; draw(); }
      else if (name === 'down') { S.histCursor++; draw(); }
      else if (name === 'return' && h && h.url) openInBrowser(h.url);
      else if (ch === 'c' && h && h.url) { copyToClipboard(h.url); }
      else if (name === 'escape' || ch === 'h') goIdle();
      else if (ch === 'q') goIdle(true);
      return;
    }

    case 'delete':
      if (ch === 'y') {
        let n = 0, freed = 0;
        for (const e of uploadedOnDisk()) {
          try { const s = fs.statSync(e.path).size; fs.unlinkSync(e.path); n++; freed += s; log(`Deleted: ${path.basename(e.path)}`); } catch (err) { log(`Delete failed: ${err.message}`); }
        }
        S.notice = `Deleted ${n} clip(s), ${fmtBytes(freed)} freed`;
        goIdle();
      } else if (name === 'escape' || ch === 'd') goIdle();
      else if (ch === 'q') goIdle(true);
      return;

    case 'uploading':
      if (ch === 'x' && S.abort) { S.cancelled = true; S.abort.abort(); }
      else if (ch === 's' && S.queue.length) { const f = S.queue.shift(); markFile(f, 'skipped'); log(`Skipped: ${path.basename(f)}`); draw(); }
      else if (ch === 'q') minimizeSelf();
      return;

    case 'waiting':
      if (name === 'return' && S.resumeWait) S.resumeWait(false);
      else if (name === 'escape' && S.resumeWait) S.resumeWait(true);
      else if (ch === 'q') minimizeSelf();
      return;

    case 'error':
      if (name === 'return' && S.resumeError) S.resumeError('retry');
      else if (ch === 'a' && S.resumeError) S.resumeError('auth');
      else if (name === 'escape' && S.resumeError) S.resumeError('giveup');
      else if (ch === 'q') minimizeSelf();
      return;

    case 'done':
      if (ch === 't') { S.editBuf = S.last.title; S.view = 'edit'; draw(); }
      else if (ch === 'p') { const order = ['unlisted', 'public', 'private']; const cur = S.last.privacy || CFG.privacy; updateVideo({ privacy: order[(order.indexOf(cur) + 1) % order.length] }); }
      else if (ch === 'c') { copyToClipboard(S.last.url); S.notice = 'Link copied'; draw(); }
      else if (ch === 'o') openInBrowser(S.last.url);
      else if (ch === 'h') { S.histCursor = 0; S.view = 'history'; draw(); }
      else if (name === 'escape') goIdle();
      else if (ch === 'q') goIdle(true);
      return;

    case 'idle': {
      const last = S.last || lastUpload();
      if (ch === 'c' && last) { copyToClipboard(last.url); S.notice = 'Link copied'; draw(); }
      else if (ch === 'o' && last) openInBrowser(last.url);
      else if (ch === 'h') { S.histCursor = 0; S.view = 'history'; draw(); }
      else if (ch === 'd') { S.view = 'delete'; draw(); }
      else if (ch === 'r') restart();
      else if (ch === 'q') { S.notice = ''; goIdle(true); }
      return;
    }
  }
});

function restart() {
  log('Restarting...');
  leaveScreen();
  spawn(process.argv[0], process.argv.slice(1), { cwd: process.cwd(), detached: false, stdio: 'inherit', shell: true });
  process.exit(0);
}
function shutdown() { leaveScreen(); process.exit(0); }
process.on('exit', () => { try { leaveScreen(); } catch {} });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (process.argv.includes('--auth')) {
    await getAuth(true);
    console.log('Signed in. Token saved to token.json');
    process.exit(0);
  }

  process.title = WIN_TITLE;
  initWindowHelper();
  ensureToastIdentity();
  if (!fs.existsSync(WATCH_DIR)) fs.mkdirSync(WATCH_DIR, { recursive: true });

  log(`Watching: ${WATCH_DIR} (v${VERSION})`);
  enterScreen();
  draw();
  setTimeout(() => { if (!CFG.popupOnUpload || S.view === 'idle') minimizeSelf(); }, 2000);

  autoClean();
  setInterval(autoClean, 60 * 60 * 1000);

  // Watch the folder. ignoreInitial:false also picks up clips dropped while the app was closed
  // (already-uploaded / skipped ones are filtered by uploaded.json).
  const watcher = chokidar.watch(WATCH_DIR, { ignoreInitial: false, depth: 0, awaitWriteFinish: false, usePolling: false });
  watcher.on('add', (filepath) => {
    if (CFG.extensions.includes(path.extname(filepath).toLowerCase())) enqueueFile(filepath);
  });
  watcher.on('error', (err) => log(`Watcher error: ${err.message}`));

  process.on('uncaughtException', (e) => log(`Uncaught: ${e.stack || e.message}`));
  process.on('unhandledRejection', (e) => log(`Unhandled: ${(e && e.stack) || e}`));
}

if (require.main === module) main();
else module.exports = { prettyTitle, pacificMidnight, classifyError, readToken, fmtBytes, fmtDuration, toast, CFG };
