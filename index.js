const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn, execFile } = require('child_process');
const { google } = require('googleapis');
const chokidar = require('chokidar');
const { resumableUpload } = require('./resumable');
const { startTray } = require('./tray');

const VERSION = require('./package.json').version;
const SIMULATE = process.argv.includes('--simulate');   // fake uploads, separate data files
const argValue = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; };

// Process model:
//   --daemon     background process: watcher, uploads, tray icon, all state. No window. Publishes state over a pipe.
//   --ui         the terminal screens: a viewer that renders the daemon's state and forwards keys. Close/reopen freely.
//   (no flag)    standalone: both in one process (old behaviour; also the fallback when no daemon is running).
const MODE = process.argv.includes('--daemon') ? 'daemon' : process.argv.includes('--ui') ? 'ui' : 'standalone';
const IS_DAEMON = MODE === 'daemon';
let IS_UI = MODE === 'ui';   // flips to false if no daemon answers and the window runs standalone instead
const PIPE = `\\\\.\\pipe\\GameUploader${SIMULATE ? '-sim' : ''}`;

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
  tray: true,             // tray icon; the window hides to the tray instead of minimizing
  showAfterUpload: true,  // bring the window back (without stealing focus) when an upload finishes
  autoHideAfter: 120,     // seconds until an auto-shown window hides again (0 = never); any key cancels
  toast: true,
  sounds: true,
  clipboard: true,
  windowControl: true,
  deleteAfterDays: 7,
  dailyUploadLimit: 6,
  minSizeMB: 1,
  // Placeholders: {game} {date} {time} {file} {size}
  titleTemplate: '{game} — {date} {time}',
  descriptionTemplate: '{game} gameplay · {date}\nUploaded automatically by GameUploader',
  playlists: true,        // add each clip to a playlist named after the game (needs the full YouTube permission)
  hdReadyToast: true,     // notify when YouTube has finished processing the clip (full quality available)
  // Per-game overrides, matched case-insensitively against the game name parsed from the filename:
  // "games": { "ARC Raiders": { "privacy": "public", "tags": ["arc raiders", "extraction"], "playlist": "ARC clips" } }
  games: {},
};

// Returns { cfg, error }. `error` is set when config.json exists but can't be parsed (defaults are used).
function loadConfig() {
  let fileCfg = {}, error = null;
  if (fs.existsSync(CONFIG_FILE)) {
    try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) { error = e.message; }
  }
  const cfg = { ...DEFAULT_CONFIG, ...fileCfg };
  if (argValue('--watch')) cfg.watchDir = argValue('--watch');
  if (!cfg.watchDir || typeof cfg.watchDir !== 'string') cfg.watchDir = DEFAULT_CONFIG.watchDir;
  if (!Array.isArray(cfg.extensions) || !cfg.extensions.length) cfg.extensions = DEFAULT_CONFIG.extensions;
  cfg.extensions = cfg.extensions.map(e => (e.startsWith('.') ? e : '.' + e).toLowerCase());
  if (!cfg.games || typeof cfg.games !== 'object') cfg.games = {};
  if (!Array.isArray(cfg.tags)) cfg.tags = DEFAULT_CONFIG.tags;
  // Write the file back when it's missing or lacks newer keys, so every option is discoverable.
  const missing = Object.keys(DEFAULT_CONFIG).some(k => !(k in fileCfg));
  if (!error && missing && !argValue('--config')) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...DEFAULT_CONFIG, ...fileCfg }, null, 2)); } catch {}
  }
  return { cfg, error };
}
const CFG = loadConfig().cfg;   // mutated in place by reloadConfig() so every reference sees updates
const gameOverrides = (game) => { if (!game) return {}; const k = Object.keys(CFG.games).find(k => k.toLowerCase() === game.toLowerCase()); return k ? CFG.games[k] || {} : {}; };

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------
function log(msg) {
  const ts = new Date().toLocaleString('sv-SE');
  try {
    // Rotate at 1 MB: keep one previous log.
    try { if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    fs.appendFileSync(LOG_FILE, `${ts} - ${msg}\n`);
  } catch {}
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
    const when = new Date(+m[2], +m[3] - 1, +m[4], hour, +m[6], +m[7]);
    const date = when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = `${String(hour).padStart(2, '0')}:${m[6]}`;
    return { title: `${game || 'Clip'} — ${date} ${time}`.slice(0, 100), game, date, time, when };
  }
  return { title: raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100), game: '', date: '', time: '', when: null };
}

// Everything YouTube needs for a clip, from the filename + config templates + per-game overrides.
function buildMeta(filepath) {
  const name = path.parse(filepath).name;
  const p = prettyTitle(name);
  let size = 0; let when = p.when;
  try { const st = fs.statSync(filepath); size = st.size; if (!when) when = st.mtime; } catch {}
  const vars = {
    game: p.game || p.title,
    date: when ? when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
    time: when ? `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}` : '',
    file: p.title,
    size: fmtBytes(size),
  };
  const fill = (tpl) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`)).trim();
  const g = gameOverrides(p.game);
  // Without a recognizable game in the filename the template would read "— Aug 27…", so use the cleaned filename instead.
  const title = (p.game ? fill(g.titleTemplate || CFG.titleTemplate) : p.title).slice(0, 100) || 'Clip';
  const description = fill(g.descriptionTemplate || CFG.descriptionTemplate).slice(0, 5000);
  const tags = [...new Set([...(p.game ? [p.game.toLowerCase()] : []), ...(Array.isArray(g.tags) ? g.tags : CFG.tags)])].slice(0, 30);
  const privacy = ['public', 'private', 'unlisted'].includes(g.privacy) ? g.privacy : CFG.privacy;
  const playlist = CFG.playlists ? (g.playlist || p.game || null) : null;
  return { title, description, tags, privacy, playlist, game: p.game, filename: path.basename(filepath) };
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

// --- Tray mode: the window hides to a tray icon instead of minimizing; tray.exe also does the window control ---
let tray = null;
let autoHideTimer = null;
const trayOn = () => !!(tray && tray.alive);
function cancelAutoHide() { if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null; } }
function scheduleAutoHide() {
  cancelAutoHide();
  if (!trayOn() || !CFG.autoHideAfter) return;
  autoHideTimer = setTimeout(() => { autoHideTimer = null; if (S.busy || S.view === 'edit') scheduleAutoHide(); else hideSelf(); }, CFG.autoHideAfter * 1000);
}
function hideSelf() { cancelAutoHide(); if (IS_DAEMON && !uiAttached()) return; if (trayOn()) tray.send('hide'); else minimizeSelf(); }
// Show the window without taking focus from the game; hides again after autoHideAfter.
// With no UI window open at all we don't create one (a brand-new window would take focus) — the toast covers it.
function showQuiet() { if (IS_DAEMON && !uiAttached()) return; if (trayOn()) { tray.send('shownoactivate'); scheduleAutoHide(); } else flashTaskbar(); }
// User asked for the window (tray click): show and focus — or open a new one if it was closed.
function showFocus() { cancelAutoHide(); if (IS_DAEMON && !uiAttached()) { spawnUi(); return; } if (trayOn()) tray.send('show'); else restoreSelf(); }

const STARTUP_BAT = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${WIN_TITLE}.bat`);
const autostartEnabled = () => !!process.env.APPDATA && fs.existsSync(STARTUP_BAT);
function setAutostart(on) {
  if (!process.env.APPDATA) return;
  try {
    if (on) fs.writeFileSync(STARTUP_BAT, `@echo off\r\nrem Auto-start GameUploader with Windows (written by GameUploader). Starts the hidden background process.\r\nwscript.exe "${path.join(SCRIPT_DIR, 'daemon.vbs')}"\r\n`);
    else if (fs.existsSync(STARTUP_BAT)) fs.unlinkSync(STARTUP_BAT);
    log(`Start with Windows: ${on ? 'on' : 'off'}`);
  } catch (e) { log(`Autostart change failed: ${e.message}`); }
  if (trayOn()) tray.send(`menu-autostart ${autostartEnabled() ? 1 : 0}`);
}

let lastTrayState = '', lastRecentKey = '';
function updateTray() {
  if (!trayOn()) return;
  let tip, status, icon = 'idle';
  const q = S.queue.length ? ` · ${S.queue.length} in queue` : '';
  const c = S.current;
  if (S.paused) { tip = `${WIN_TITLE} · paused${q}`; status = 'Paused — not watching'; icon = 'paused'; }
  else if (S.view === 'uploading' && c) {
    if (c.sizeMB) { tip = `Uploading ${c.pct}% · ${fmtDuration(c.eta)} left${q}`; status = `Uploading ${c.pct}% · ${clip(c.title, 32)}`; icon = `busy ${c.pct}`; }
    else { tip = `Waiting for recording to finish${q}`; status = 'Waiting for the recording to finish'; icon = 'busy 0'; }
  }
  else if (S.view === 'error' && S.error) { tip = `Upload failed: ${S.error.message}`; status = `Failed: ${clip(S.error.message, 40)}`; icon = 'error'; }
  else if (S.view === 'waiting') { tip = `Paused: ${S.waitReason}${q}`; status = clip(S.waitReason, 50); icon = 'paused'; }
  else {
    const last = S.last || lastUpload();
    const today = uploadsToday();
    tip = `${WIN_TITLE} · watching · ${today} of ${CFG.dailyUploadLimit} today${last ? ` · last: ${last.title}` : ''}`;
    status = `Watching · ${today} of ${CFG.dailyUploadLimit} uploads today${q}`;
  }
  const state = `${icon}|${tip}|${status}`;
  if (state !== lastTrayState) {
    lastTrayState = state;
    tray.send(`icon ${icon}`);
    tray.send(`tooltip ${tip.replace(/[\r\n]+/g, ' ')}`);
    tray.send(`status ${status.replace(/[\r\n]+/g, ' ')}`);
  }
  // Recent uploads submenu (last 5)
  const recent = loadJson(HISTORY_FILE).filter(h => h.success && h.videoId).slice(0, 5);
  const key = recent.map(h => `${h.videoId}:${h.title}`).join('|');
  if (key !== lastRecentKey) {
    lastRecentKey = key;
    tray.send('recent-clear');
    for (const h of recent) tray.send(`recent-add ${h.videoId}\t${h.title.replace(/[\r\n\t]+/g, ' ')}`);
  }
}

function onTrayEvent(line) {
  const [ev, arg] = line.split(' ');
  const last = S.last || lastUpload();
  if (ev !== 'ready') log(`Tray: ${line}`);
  switch (ev) {
    case 'ready': tray.send(`menu-autostart ${autostartEnabled() ? 1 : 0}`); tray.send(`menu-pause ${S.paused ? 1 : 0}`); lastTrayState = ''; updateTray(); break;
    case 'click': cancelAutoHide(); if (IS_DAEMON && !uiAttached()) spawnUi(); else tray.send('toggle'); break;
    case 'show': showFocus(); break;
    case 'copy': if (last) { copyToClipboard(last.url); toast('Link copied', last.title); } break;
    case 'open': if (last) openInBrowser(last.url); break;
    case 'recent': { const h = loadJson(HISTORY_FILE).find(x => x.videoId === arg); if (h) { copyToClipboard(h.url); toast('Link copied', h.title, h.url); } break; }
    case 'folder': openFolder(CFG.watchDir); break;
    case 'pause': S.paused = true; S.notice = 'Paused — new clips are ignored until you resume'; tray.send('menu-pause 1'); log('Paused watching'); if (S.view === 'idle') draw(); lastTrayState = ''; updateTray(); break;
    case 'resume': S.paused = false; S.notice = ''; tray.send('menu-pause 0'); log('Resumed watching'); startWatcher(); if (S.view === 'idle') draw(); lastTrayState = ''; updateTray(); break;
    case 'autostart': setAutostart(arg === '1'); break;
    case 'quit': shutdown('tray menu'); break;
  }
}

// Retro console-speaker jingles (frequency Hz, duration ms).
const JINGLES = {
  success: [[523, 90], [659, 90], [784, 90], [1047, 200]],        // C E G C — "level up"
  error:   [[392, 180], [330, 180], [262, 360]],                   // G E C — "game over"
  ready:   [[880, 70], [1175, 70], [1760, 140]],                   // "item get"
  tick:    [[1200, 40]],
};
function jingle(name) {
  if (!CFG.sounds || !JINGLES[name]) return;
  ps(['-Command', JINGLES[name].map(([f, d]) => `[console]::beep(${f},${d})`).join(';')]);
}
const beepSuccess = () => jingle('success');
const beepError = () => jingle('error');
function copyToClipboard(text) { if (CFG.clipboard) ps(['-Command', `Set-Clipboard -Value '${String(text).replace(/'/g, "''")}'`]); }
function openInBrowser(url) { try { spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch {} }
function openFolder(dir) { try { spawn('explorer.exe', [dir], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch {} }
const studioUrl = videoId => `https://studio.youtube.com/video/${videoId}/edit`;

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
  const iconPng = path.join(SCRIPT_DIR, 'icon.png');   // exported from the tray helper's artwork (256 px)
  const img = fs.existsSync(iconPng) ? `<image placement="appLogoOverride" src="file:///${xmlEsc(iconPng.replace(/\\/g, '/'))}"/>` : '';
  const xml = `<toast${launch}><visual><binding template="ToastGeneric">${img}<text>${xmlEsc(title)}</text><text>${xmlEsc(message)}</text></binding></visual></toast>`;
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
const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', brightGreen: '\x1b[92m', yellow: '\x1b[33m', red: '\x1b[31m', underline: '\x1b[4m', inv: '\x1b[7m', noinv: '\x1b[27m' };
const W = 68;
const out = process.stdout;
const vis = s => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, '').length;   // ignore SGR colors and OSC 8 links
const clip = (s, n) => (vis(s) <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…');
const lr = (left, right) => { const gap = W - vis(left) - vis(right); return left + ' '.repeat(Math.max(1, gap)) + right; };
const cap = k => `${C.inv} ${k} ${C.noinv}`;                        // key cap: inverse-video " C "
const key = (k, label) => `${cap(k)} ${label}`;
const keys = (...pairs) => '  ' + pairs.map(([k, l]) => key(k, l)).join('  ');
const rule = label => `  ${C.dim}── ${label} ${'─'.repeat(Math.max(0, W - 6 - label.length))}${C.reset}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const shortPath = p => (p.toLowerCase().startsWith(os.homedir().toLowerCase()) ? '~' + p.slice(os.homedir().length) : p);
// Clickable link: OSC 8 hyperlink (Ctrl+click in Windows Terminal) around the full URL, which
// also keeps the terminal's own URL auto-detection working.
const link = url => `\x1b]8;;${url}\x1b\\${C.cyan}${C.underline}${url}${C.reset}\x1b]8;;\x1b\\`;
const SPARK = '▁▂▃▄▅▆▇█';
const sparkline = (vals) => { const max = Math.max(1, ...vals); return vals.map(v => SPARK[Math.min(7, Math.floor((v / max) * 7.99))]).join(''); };

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
// `sweep` (0..1, or null) is the position of a bright scanline passing over the letters.
function gradientLine(line, width, sweep = null) {
  let out = '', last = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') { out += ' '; continue; }
    const x = i / Math.max(1, width - 1);
    let m = 1;
    if (sweep !== null) { const d = Math.abs(x - sweep); if (d < 0.07) m = 1.6 - d * 8; }
    if ('╗╔╚╝║═'.includes(ch)) m *= PAL.shadow;
    const c = grad(x).map(v => Math.min(255, v * m));
    const code = rgb(c);
    if (code !== last) { out += code; last = code; }
    out += ch;
  }
  return out + C.reset;
}

// Sweep animation: repaints only the UPLOADER rows (rows 7–12 of the full header) ~15×/s
// while the full logo is on screen and there was activity in the last 10 minutes.
const SWEEP_PERIOD = 1500;   // ms per pass
const SWEEP_ROW0 = 7;        // header(): row 1 blank, rows 2–6 GAME, rows 7–12 UPLOADER
let lastActivity = Date.now();
const touch = () => { lastActivity = Date.now(); };
function sweepTick() {
  if (IS_UI && !S.connected) return;
  if (S.view === 'uploading' && S.current && S.current.sizeMB) {
    out.write(`\x1b[${BAR_ROW};1H${barLine(S.current.pct)}\x1b[K`);   // shimmer along the bar
    return;
  }
  if (!(S.view === 'idle' || S.view === 'done')) return;
  if (Date.now() - lastActivity > 10 * 60 * 1000) return;
  const pos = ((Date.now() % SWEEP_PERIOD) / SWEEP_PERIOD) * 1.3 - 0.15;
  let buf = '';
  LOGO_UP.forEach((l, i) => { buf += `\x1b[${SWEEP_ROW0 + i};1H  ${gradientLine(l, LOGO_W, pos)}\x1b[K`; });
  out.write(buf);
}
const wordmark = () => `${rgb(PAL.game)}${C.bold}GAME${C.reset} ${C.bold}${gradientLine('UPLOADER', 8)}`;

let startedAt = Date.now();   // in UI mode: the daemon's start time (from its state)
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
  histConfirm: null,
  editBuf: '',
  notice: '',
  authNeeded: false,
  helpReturn: 'idle',
  polls: new Set(),      // videoIds being polled for processing status
  paused: false,         // "Pause watching" from the tray menu
  connected: false,      // UI mode: connected to the daemon
  trayRemote: false,     // UI mode: the daemon has a tray icon
};

// ---------------------------------------------------------------------------
// Daemon ⇄ UI pipe: the daemon publishes state on every draw(), the UI renders it and sends keys back
// ---------------------------------------------------------------------------
const STATE_FIELDS = ['view', 'queue', 'current', 'last', 'error', 'waitUntil', 'waitReason', 'waitFile', 'histCursor', 'histConfirm',
  'editBuf', 'editFresh', 'editTarget', 'editReturn', 'notice', 'paused', 'busy', 'helpReturn'];
const uiClients = new Set();
let uiEverAttached = false;

function snapshot() {
  const s = {};
  for (const k of STATE_FIELDS) s[k] = S[k];
  return { type: 'state', S: s, cfg: CFG, startedAt, version: VERSION, tray: trayOn() };
}
function publishState(sock) {
  if (!uiClients.size) return;
  const msg = JSON.stringify(snapshot()) + '\n';
  for (const c of (sock ? [sock] : uiClients)) { try { c.write(msg); } catch {} }
}
function broadcast(obj) { const msg = JSON.stringify(obj) + '\n'; for (const c of uiClients) { try { c.write(msg); } catch {} } }

function startIpcServer(onAlreadyRunning) {
  const server = net.createServer((sock) => {
    uiClients.add(sock);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'key') handleKey(msg.str, msg.key || {});
        else if (msg.type === 'hello') publishState(sock);
      }
    });
    sock.on('close', () => { uiClients.delete(sock); log(`UI window detached (${uiClients.size} left)`); });
    sock.on('error', () => {});
    log(`UI window attached (${uiClients.size})`);
    publishState(sock);
    setTimeout(() => { if (trayOn()) tray.send(`seticon ${path.join(SCRIPT_DIR, 'icon.ico')}`); }, 800);   // window exists by now
    if (!uiEverAttached) { uiEverAttached = true; setTimeout(() => { if (S.view === 'idle') hideSelf(); }, 2000); }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') onAlreadyRunning();
    else { log(`IPC server error: ${e.message}`); process.exit(1); }
  });
  server.listen(PIPE);
  return server;
}

// Windows Terminal "fragment": registers a GameUploader profile (icon + pink tab) without touching the
// user's settings.json. See https://learn.microsoft.com/windows/terminal/json-fragment-extensions
const WT_FRAGMENT = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows Terminal', 'Fragments', WIN_TITLE, 'profile.json');
function ensureWtProfile() {
  if (!process.env.LOCALAPPDATA || SIMULATE) return false;
  try {
    const profile = {
      profiles: [{
        name: WIN_TITLE,
        commandline: `node "${path.join(SCRIPT_DIR, 'index.js')}" --ui`,
        startingDirectory: SCRIPT_DIR,
        icon: path.join(SCRIPT_DIR, 'icon.png'),
        tabColor: '#D4537E',
        suppressApplicationTitle: false,
      }],
    };
    const json = JSON.stringify(profile, null, 2);
    if (fs.existsSync(WT_FRAGMENT) && fs.readFileSync(WT_FRAGMENT, 'utf8') === json) return true;
    fs.mkdirSync(path.dirname(WT_FRAGMENT), { recursive: true });
    fs.writeFileSync(WT_FRAGMENT, json);
    log('Windows Terminal profile registered (fragment)');
    return true;
  } catch (e) { log(`WT profile registration failed: ${e.message}`); return false; }
}

// Opens the terminal UI in its own Windows Terminal window. Prefers the GameUploader profile (tab icon + color);
// if Terminal doesn't know it yet (fragment just written, Terminal not restarted) falls back to the plain command.
let spawnUiPlain = false;
function spawnUi() {
  if (process.env.GAMEUPLOADER_NO_UI) return;
  const useProfile = !spawnUiPlain && ensureWtProfile();
  const args = ['/c', 'start', '', 'wt.exe', '-w', WIN_TITLE];
  if (useProfile) args.push('-p', WIN_TITLE, '--title', WIN_TITLE);
  else {
    args.push('-d', SCRIPT_DIR, '--title', WIN_TITLE, '--tabColor', '#D4537E', 'node', 'index.js', '--ui');
    if (SIMULATE) args.push('--simulate');
    if (argValue('--config')) args.push('--config', argValue('--config'));
  }
  try { spawn('cmd.exe', args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); log(`Opening UI window${useProfile ? ' (profile)' : ''}`); }
  catch (e) { log(`Could not open UI window: ${e.message}`); return; }
  if (useProfile) {
    const before = uiClients.size;
    setTimeout(() => { if (uiClients.size <= before) { log('Profile launch did not attach — retrying with the plain command'); spawnUiPlain = true; spawnUi(); } }, 4000);
  }
}
const uiAttached = () => uiClients.size > 0;

// UI side
let uiSock = null;
function startUiClient() {
  let retries = 0;
  const connect = () => {
    const sock = net.createConnection(PIPE);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('connect', () => { uiSock = sock; retries = 0; S.connected = true; sock.write(JSON.stringify({ type: 'hello' }) + '\n'); });
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'state') { Object.assign(S, msg.S); Object.assign(CFG, msg.cfg); startedAt = msg.startedAt; S.trayRemote = !!msg.tray; S.connected = true; draw(); }
        else if (msg.type === 'quit') { leaveScreen(); process.exit(0); }
      }
    });
    const lost = () => {
      if (uiSock === sock) uiSock = null;
      if (S.connected) { S.connected = false; draw(); }
      // Not running at all on first try → become the app ourselves (start.bat double-clicked without the daemon).
      if (retries === 0 && !uiEverConnected) { runStandaloneFallback(); return; }
      retries++;
      setTimeout(connect, Math.min(1000, 250 * retries));
    };
    let uiEverConnected = false;
    sock.once('connect', () => { uiEverConnected = true; });
    sock.on('error', lost);
    sock.on('close', () => { if (uiEverConnected) lost(); });
  };
  connect();
}
function uiSendKey(str, key) {
  if (!uiSock) return;
  try { uiSock.write(JSON.stringify({ type: 'key', str, key: { name: key.name, ctrl: key.ctrl, meta: key.meta, shift: key.shift } }) + '\n'); } catch {}
}
let standaloneFallback = null;   // set by main()
function runStandaloneFallback() { if (standaloneFallback) standaloneFallback(); }

function draw() {
  if (IS_DAEMON) { publishState(); updateTray(); return; }   // the UI process does the drawing
  if (IS_UI && !S.connected) { drawDisconnected(); return; }
  switch (S.view) {
    case 'help': drawHelp(); break;
    case 'idle': drawIdle(); break;
    case 'uploading': drawUploading(); break;
    case 'done': drawDone(); break;
    case 'error': drawError(); break;
    case 'waiting': drawWaiting(); break;
    case 'history': drawHistory(); break;
    case 'delete': drawDelete(); break;
    case 'edit': drawEdit(); break;
  }
  updateTray();
}
const hideLabel = () => ((IS_UI ? S.trayRemote : trayOn()) ? 'hide to tray' : 'minimize');

function drawDisconnected() {
  setTitle('Connecting');
  const L = header();
  L.push(`  ${C.yellow}⟳${C.reset} Connecting to the GameUploader background process…`);
  L.push('');
  L.push(`  ${C.dim}It restarts by itself after ${cap('R')} or a crash; this window reconnects automatically.${C.reset}`);
  L.push(`  ${C.dim}If it never comes back: run start.bat.${C.reset}`);
  L.push('');
  L.push(keys(['Ctrl+C', 'close this window']));
  render(L);
}

// Lists the pending queue as a section. startNum=2 while something is uploading (that one is #1).
function queueLines(startNum = 1) {
  const q = S.queue;
  if (!q.length) return [];
  const lines = ['', rule(`Queue · ${plural(q.length, 'clip')}`)];
  q.slice(0, 4).forEach((f, i) => {
    let size = ''; try { size = fmtBytes(fs.statSync(f).size); } catch {}
    lines.push(lr(`  ${C.dim}${i + startNum}.${C.reset} ${clip(prettyTitle(path.parse(f).name).title, 48)}`, `${C.dim}${size}${C.reset}`));
  });
  if (q.length > 4) lines.push(`     ${C.dim}… and ${q.length - 4} more${C.reset}`);
  return lines;
}

// Progress bar with a shimmer that travels along the filled part.
function barLine(pct, shimmer = true) {
  const barW = 40, filled = Math.round(barW * pct / 100);
  let bar = '';
  const pos = shimmer ? Math.floor((Date.now() % 1200) / 1200 * (filled + 6)) - 3 : -99;
  for (let i = 0; i < filled; i++) bar += (Math.abs(i - pos) <= 1 ? C.brightGreen : C.green) + '█';
  bar += `${C.dim}${'░'.repeat(barW - filled)}${C.reset}`;
  return `  ${bar}  ${C.bold}${pct}%${C.reset}`;
}
const BAR_ROW = 6;   // compact header rows 1–3, "▲ Uploading" row 4, blank row 5, bar row 6

function drawIdle() {
  setTitle('Watching');
  const L = header(true);
  const exts = CFG.extensions.map(e => e.slice(1)).join('  ');
  if (S.paused) L.push(lr(`  ${C.yellow}⏸${C.reset} Paused — not watching ${C.dim}${clip(shortPath(CFG.watchDir), 36)}${C.reset}`, `${C.dim}resume from the tray icon${C.reset}`));
  else L.push(lr(`  ${C.green}●${C.reset} Watching ${C.bold}${clip(shortPath(CFG.watchDir), 40)}${C.reset}`, `${C.dim}${exts}${C.reset}`));
  L.push('');
  L.push(rule('Last upload'));
  const last = S.last || lastUpload();
  if (last) {
    L.push(lr(`  ${clip(last.title, 48)}`, `${C.dim}${last.sizeMB ? fmtBytes(last.sizeMB * 1048576) : ''}${last.elapsed ? ` · ${last.elapsed}s` : ''}${C.reset}`));
    L.push(`  ${link(last.url)}`);
  } else {
    L.push(`  ${C.dim}No uploads yet — drop a clip in the folder.${C.reset}`);
  }
  L.push('');
  L.push(rule('Today'));
  const today = uploadsToday(), limit = CFG.dailyUploadLimit;
  const todayCol = today >= limit ? C.red : today >= limit - 1 ? C.yellow : C.cyan;
  const bar = `${todayCol}${'▰'.repeat(Math.min(today, limit))}${C.dim}${'▱'.repeat(Math.max(0, limit - today))}${C.reset}`;
  L.push(lr(`  ${bar}  ${plural(today, 'upload')}${today >= limit ? ` — limit reached` : ''}`, `${C.dim}resets in ${fmtDuration((pacificMidnight(1) - Date.now()) / 1000)}${C.reset}`));
  const onDisk = uploadedOnDisk();
  if (onDisk.length) {
    const size = onDisk.reduce((a, e) => { try { return a + fs.statSync(e.path).size; } catch { return a; } }, 0);
    L.push(lr(`  ${C.yellow}${fmtBytes(size)}${C.reset} in ${plural(onDisk.length, 'uploaded clip')} waiting for clean-up`, `${C.dim}press${C.reset} ${cap('D')}`));
  }
  L.push(...queueLines());
  if (needsFullScope()) { L.push(''); L.push(lr(`  ${C.yellow}Playlists and HD-ready alerts need a one-time re-sign-in${C.reset}`, `${C.dim}press${C.reset} ${cap('A')}`)); }
  if (S.notice) { L.push(''); L.push(`  ${C.green}${S.notice}${C.reset}`); }
  L.push('');
  if (last) L.push(keys(['C', 'copy link'], ['O', 'open'], ['L', 'studio'], ['T', 'edit title'], ['P', `privacy: ${last.privacy || CFG.privacy}`]));
  const k = [['H', 'history'], ['F', 'folder']];
  if (onDisk.length) k.push(['D', 'clean up']);
  k.push(['?', 'help'], ['R', 'restart'], ['Q', hideLabel()]);
  L.push(keys(...k));
  render(L);
}

function drawHelp() {
  setTitle('Help');
  const L = header();
  L.push(`  ${C.bold}Keys${C.reset}`);
  L.push('');
  const rows = [
    ['Dashboard', [['C', 'copy last link'], ['O', 'open last clip'], ['L', 'open in YouTube Studio'], ['T', 'edit title'], ['P', 'cycle privacy']]],
    ['', [['H', 'history'], ['F', 'open watch folder'], ['D', 'delete uploaded clips'], ['R', 'restart'], ['Q', 'minimize']]],
    ['Uploading', [['T', 'title (applied at the end)'], ['P', 'privacy'], ['X', 'cancel'], ['S', 'skip next in queue']]],
    ['History', [['↑↓', 'select'], ['Enter', 'open'], ['C', 'copy link'], ['X', 'delete that file from disk']]],
    ['Errors', [['Enter', 'retry now'], ['A', 'sign in again'], ['Esc', 'give up on that clip']]],
    ['Anywhere', [['?', 'this screen'], ['Esc', 'back'], ['Ctrl+C', 'quit']]],
  ];
  for (const [section, ks] of rows) {
    L.push(`  ${C.dim}${section.padEnd(11)}${C.reset}${ks.map(([k, l]) => `${cap(k)} ${l}`).join('   ')}`);
  }
  L.push('');
  L.push(`  ${C.dim}Settings live in ${shortPath(CONFIG_FILE)} — changes apply without a restart.${C.reset}`);
  L.push(`  ${C.dim}Watching ${shortPath(CFG.watchDir)} · privacy ${CFG.privacy} · playlists ${CFG.playlists ? 'on' : 'off'} · auto-delete ${CFG.deleteAfterDays ? CFG.deleteAfterDays + ' days' : 'off'}${C.reset}`);
  L.push('');
  L.push(keys(['Esc', 'back']));
  render(L);
}

function drawUploading() {
  const c = S.current;
  setTitle(`${c.pct}%`);
  const L = header();
  L.push(lr(`  ${C.green}▲ Uploading${C.reset}  ${clip(c.title, 40)}`, `${C.dim}${fmtBytes(c.sizeMB * 1048576)}${C.reset}`));
  L.push('');
  L.push(barLine(c.pct));
  const spark = c.speeds && c.speeds.length > 1 ? `   ${C.cyan}${sparkline(c.speeds)}${C.reset}` : '';
  L.push(`  ${C.dim}${c.speed > 0 ? `${fmtSpeed(c.speed)} · ${fmtDuration(c.eta)} left` : c.status || 'starting…'}${C.reset}${spark}`);
  L.push(...queueLines(2));
  L.push('');
  const k = [['T', 'edit title'], ['P', `privacy: ${c.privacy}`], ['X', 'cancel']];
  if (S.queue.length) k.push(['S', 'skip next']);
  k.push(['Q', hideLabel()]);
  L.push(keys(...k));
  render(L);
}

function drawDone() {
  setTitle('Done');
  const h = S.last;
  const L = header(true);
  L.push(lr(`  ${C.green}${C.bold}✓ Uploaded${C.reset}   ${clip(h.title, 38)}`, `${C.dim}${fmtBytes(h.sizeMB * 1048576)} · ${h.elapsed}s${C.reset}`));
  L.push(lr(`  ${link(h.url)}`, `${C.green}link copied${C.reset}`));
  L.push('');
  L.push(`  ${C.dim}Privacy${C.reset}  ${h.privacy || CFG.privacy}        ${C.dim}Tags${C.reset}  ${(h.tags || []).join(', ')}`);
  if (S.notice) { L.push(''); L.push(`  ${C.green}${S.notice}${C.reset}`); }
  L.push(...queueLines());
  L.push('');
  L.push(keys(['T', 'edit title'], ['P', 'privacy'], ['C', 'copy'], ['O', 'open'], ['L', 'studio'], ['Q', hideLabel()]));
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
  L.push(...queueLines());
  L.push('');
  const k = [];
  if (e.kind === 'auth') k.push(['A', 'sign in again']);
  else k.push(['Enter', 'retry now']);
  k.push(['Esc', 'give up'], ['Q', hideLabel()]);
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
  L.push(...queueLines());
  L.push('');
  L.push(keys(['Enter', 'retry now'], ['Esc', 'give up on this clip'], ['Q', hideLabel()]));
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
      const onDisk = historyFilePath(h) ? `${C.dim}●${C.reset}` : ' ';
      const line = `${sel ? `${C.cyan}▸${C.reset}` : ' '} ${mark} ${C.dim}${date}${C.reset}  ${sel ? C.bold : ''}${clip(h.title, 30)}${C.reset}`;
      L.push(lr(' ' + line, `${onDisk} ${C.dim}${h.sizeMB ? fmtBytes(h.sizeMB * 1048576) : ''}${C.reset}`));
      if (sel) L.push(`        ${h.url ? link(h.url) : `${C.red}${h.error || ''}${C.reset}`}`);
    });
    if (start + rows < history.length) L.push(`  ${C.dim}… ${history.length - start - rows} more below${C.reset}`);
  }
  L.push('');
  const cur = history[S.histCursor];
  if (S.histConfirm !== null && cur) {
    L.push(lr(`  ${C.yellow}Delete ${clip(path.basename(historyFilePath(cur) || ''), 40)} from disk?${C.reset}`, `${cap('Y')} yes   ${cap('N')} no`));
  } else {
    L.push(lr(keys(['↑↓', 'select'], ['Enter', 'open'], ['C', 'copy link'], ['X', 'delete file'], ['Esc', 'back']), `${C.dim}● still on disk${C.reset}`));
  }
  render(L);
}

// Local file for a history entry, if it still exists (matched through uploaded.json by videoId, else by filename).
function historyFilePath(h) {
  let p = null;
  if (h.videoId) { const e = loadUploaded().find(e => e.videoId === h.videoId); if (e) p = e.path; }
  if (!p && h.filename) p = path.join(CFG.watchDir, h.filename);
  return p && fs.existsSync(p) ? p : null;
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
  const editingCurrent = S.editTarget === 'current' && S.current;
  L.push(`  ${C.bold}Edit title${C.reset}   ${editingCurrent ? `${C.dim}applies when the upload finishes${C.reset}` : link(S.last.url)}`);
  L.push('');
  L.push(`  ${C.dim}Current:${C.reset} ${clip(editingCurrent ? S.current.title : S.last.title, 56)}`);
  L.push('');
  L.push(`  ${C.cyan}›${C.reset} ${S.editFresh ? `${C.inv}${S.editBuf}${C.noinv}` : S.editBuf}${C.cyan}_${C.reset}`);
  L.push('');
  L.push(`  ${C.dim}${S.editBuf.length}/100${S.editFresh ? '   type to replace · Backspace or → to edit the current title' : ''}${C.reset}`);
  L.push('');
  L.push(keys(['Enter', 'save'], ['Esc', 'cancel']));
  render(L);
}
function startEdit(target, returnTo, initial) {
  S.editTarget = target; S.editReturn = returnTo; S.editBuf = initial || ''; S.editFresh = !!initial;   // pre-filled text is "selected": typing replaces it
  S.view = 'edit'; draw();
}

// Tickers: 1s for countdowns, 30s for the idle dashboard (uptime, quota reset), ~15 fps for animations
function startTickers() {
  setInterval(() => { if (S.view === 'waiting' && (!IS_UI || S.connected)) draw(); }, 1000);
  setInterval(() => { if (S.view === 'idle' && (!IS_UI || S.connected)) draw(); }, 30000);
  setInterval(sweepTick, 66);
}

// ---------------------------------------------------------------------------
// YouTube auth
// ---------------------------------------------------------------------------
let authClient = null;
// youtube.upload only allows uploading + editing your own videos. Playlists and processing status need the full scope.
const SCOPE_FULL = 'https://www.googleapis.com/auth/youtube';
const hasFullScope = () => { const t = readToken(); return !!(t && t.scope && /auth\/youtube(\s|$)/.test(t.scope)); };
const needsFullScope = () => !SIMULATE && (CFG.playlists || CFG.hdReadyToast) && !hasFullScope();

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
      const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [SCOPE_FULL] });
      log('Opening browser for Google sign-in');
      open(url);
    });
  });
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
// True while another process (the recorder) still has the file open for writing. Writers normally open
// with share-read only, so our own write-mode open fails with EBUSY/EPERM until they close it.
function isLockedForWrite(filepath) {
  try { fs.closeSync(fs.openSync(filepath, 'r+')); return false; }
  catch (e) { return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'; }
}

function waitUntilStable(filepath) {
  // Size must stay unchanged for two consecutive 3s checks (recorders write in bursts) AND nobody may
  // still hold the file open for writing.
  return new Promise((resolve) => {
    let prev = -1, stableCount = 0;
    const tick = () => {
      if (!fs.existsSync(filepath)) return resolve(false);
      const size = fs.statSync(filepath).size;
      if (size === prev && size > 0) stableCount++; else stableCount = 0;
      prev = size;
      const locked = stableCount >= 2 && isLockedForWrite(filepath);
      if (stableCount >= 2 && !locked) return resolve(true);
      if (S.current) { S.current.status = locked ? `recorder still has the file open… (${fmtBytes(size)})` : `waiting for recording to finish… (${fmtBytes(size)})`; if (S.view === 'uploading') draw(); }
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
  let lastDraw = 0, lastLoggedQuarter = 0, lastSample = 0, lastSampleBytes = 0;
  c.speeds = [];
  const onProgress = (bytes) => {
    const pct = Math.min(100, Math.round((bytes / fileSize) * 100));
    const elapsed = (Date.now() - startTime) / 1000;
    c.pct = pct;
    c.speed = elapsed > 0.5 ? bytes / elapsed : 0;
    c.eta = c.speed > 0 ? (fileSize - bytes) / c.speed : 0;
    if (Date.now() - lastSample >= 1000) {   // instantaneous speed sample for the sparkline
      if (lastSample) c.speeds.push((bytes - lastSampleBytes) / ((Date.now() - lastSample) / 1000));
      if (c.speeds.length > 16) c.speeds.shift();
      lastSample = Date.now(); lastSampleBytes = bytes;
    }
    const q = Math.floor(pct / 25);
    if (q > lastLoggedQuarter) { lastLoggedQuarter = q; log(`  Progress: ${q * 25}%`); }
    if (Date.now() - lastDraw > 150 || pct === 100) { lastDraw = Date.now(); if (S.view === 'uploading') draw(); }
  };

  if (SIMULATE) {
    S.abort = new AbortController();
    c.sentTitle = c.title; c.sentPrivacy = c.privacy;
    for (let i = 0; i <= 40; i++) {
      if (S.abort.signal.aborted) throw new Error('aborted');
      await new Promise(r => setTimeout(r, 120));
      onProgress(fileSize * i / 40);
    }
    return { videoId: 'SIM' + Math.random().toString(36).slice(2, 10), elapsed: ((Date.now() - startTime) / 1000).toFixed(0) };
  }

  // Resumable protocol: a dropped connection continues from the last byte YouTube confirmed, and the
  // session file lets an upload survive an app restart (see resumable.js).
  S.abort = new AbortController();
  c.sentTitle = c.title; c.sentPrivacy = c.privacy;   // edits made during the upload are applied afterwards
  const res = await resumableUpload({
    filepath,
    metadata: {
      snippet: { title: c.sentTitle, description: c.description, tags: c.tags, categoryId: CFG.categoryId },
      status: { privacyStatus: c.sentPrivacy, selfDeclaredMadeForKids: false },
    },
    getAuthHeaders: () => auth.getRequestHeaders(),
    signal: S.abort.signal,
    onProgress: (bytes) => onProgress(bytes),
    sessionFile: path.join(SCRIPT_DIR, `upload-session${SIM}.json`),
    log: (m) => log(`  [upload] ${m}`),
  });
  return { videoId: res.videoId, elapsed: ((Date.now() - startTime) / 1000).toFixed(0) };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
function enqueueFile(filepath) {
  if (S.paused) { log(`Ignored while paused: ${path.basename(filepath)}`); return; }
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
  const meta = buildMeta(filepath);
  const { title, tags } = meta;
  S.current = { filepath, ...meta, sizeMB: 0, pct: 0, speed: 0, eta: 0, status: 'waiting for recording to finish…' };
  S.cancelled = false;
  S.view = 'uploading';
  touch();
  log(`New video detected: ${filename}`);
  if (CFG.popupOnUpload) showQuiet(); else if (!trayOn()) flashTaskbar();
  draw();

  if (!(await waitUntilStable(filepath))) { log('File disappeared'); return 'next'; }
  const size = fs.statSync(filepath).size;
  if (size < CFG.minSizeMB * 1048576) { log('File too small, skipping'); markFile(filepath, 'skipped'); return 'next'; }
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
      const c = S.current;
      const url = `https://youtube.com/watch?v=${result.videoId}`;
      markFile(filepath, 'uploaded', { videoId: result.videoId });
      const entry = { title: c.sentTitle, sizeMB: c.sizeMB, videoId: result.videoId, url, success: true, elapsed: result.elapsed, privacy: c.sentPrivacy, tags, filename, description: c.description, game: c.game };
      addHistory(entry);
      S.last = { ...entry, ts: Date.now() };
      S.notice = '';
      log(`Uploaded! ${url} (${result.elapsed}s)`);
      copyToClipboard(url);
      beepSuccess();
      if (CFG.showAfterUpload) showQuiet(); else flashTaskbar();
      toast('Uploaded · link copied', c.title, url);
      // If the user is mid-edit of this clip's title, keep the editor open but point it at the finished video.
      if (S.view === 'edit' && S.editTarget === 'current') { S.editTarget = 'last'; S.editReturn = 'done'; }
      else { S.view = 'done'; draw(); }
      // Apply title/privacy changes made while the upload was running.
      const patch = {};
      if (c.title !== c.sentTitle) patch.title = c.title;
      if (c.privacy !== c.sentPrivacy) patch.privacy = c.privacy;
      if (Object.keys(patch).length) await updateVideo(patch);
      if (c.playlist) await addToPlaylist(result.videoId, c.playlist);
      watchProcessing(result.videoId, c.title, url);
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
      beepError(); showQuiet();
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
// Playlists (one per game) and processing status — both need SCOPE_FULL
// ---------------------------------------------------------------------------
const PLAYLISTS_FILE = path.join(SCRIPT_DIR, `playlists${SIM}.json`);

async function ensurePlaylist(youtube, name) {
  const cache = loadJson(PLAYLISTS_FILE, {});
  if (cache[name]) return cache[name];
  // Look through the channel's playlists first so we don't create duplicates.
  let pageToken;
  do {
    const res = await youtube.playlists.list({ part: 'snippet', mine: true, maxResults: 50, pageToken });
    const hit = (res.data.items || []).find(p => p.snippet.title.toLowerCase() === name.toLowerCase());
    if (hit) { cache[name] = hit.id; saveJson(PLAYLISTS_FILE, cache); return hit.id; }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  const created = await youtube.playlists.insert({
    part: 'snippet,status',
    requestBody: { snippet: { title: name, description: 'Gameplay clips · added automatically by GameUploader' }, status: { privacyStatus: 'unlisted' } },
  });
  cache[name] = created.data.id; saveJson(PLAYLISTS_FILE, cache);
  log(`Created playlist "${name}" (${created.data.id})`);
  return created.data.id;
}

async function addToPlaylist(videoId, name) {
  if (SIMULATE) { S.notice = `Added to playlist "${name}"`; updateHistory(videoId, { playlist: name }); if (S.view === 'done') draw(); return; }
  if (!hasFullScope()) { log('Playlist skipped: token lacks the full YouTube scope'); return; }
  try {
    const youtube = google.youtube({ version: 'v3', auth: await getAuth() });
    const playlistId = await ensurePlaylist(youtube, name);
    await youtube.playlistItems.insert({ part: 'snippet', requestBody: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } } });
    updateHistory(videoId, { playlist: name });
    S.notice = `Added to playlist "${name}"`;
    log(`Added ${videoId} to playlist "${name}"`);
  } catch (e) {
    const err = classifyError(e);
    log(`Playlist failed: ${e.message}`);
    S.notice = `${C.yellow}Couldn't add to playlist: ${err.message}${C.reset}`;
  }
  if (S.view === 'done') draw();
}

// Polls YouTube every 30s (1 quota unit each) until the clip is fully processed, then toasts. Max 40 polls (20 min).
function watchProcessing(videoId, title, url) {
  if (!CFG.hdReadyToast || S.polls.has(videoId)) return;
  if (SIMULATE) { setTimeout(() => { S.notice = 'Ready to watch in full quality'; updateHistory(videoId, { hd: true }); if (S.view === 'done' || S.view === 'idle') draw(); }, 4000); return; }
  if (!hasFullScope()) return;
  S.polls.add(videoId);
  let n = 0;
  const poll = async () => {
    try {
      const youtube = google.youtube({ version: 'v3', auth: await getAuth() });
      const res = await youtube.videos.list({ part: 'processingDetails,status', id: videoId });
      const v = (res.data.items || [])[0];
      const status = v && v.processingDetails && v.processingDetails.processingStatus;
      if (status === 'succeeded') {
        S.polls.delete(videoId);
        updateHistory(videoId, { hd: true });
        log(`Processing finished: ${videoId}`);
        jingle('ready');
        toast('Ready to watch in full quality', title, url);
        S.notice = `Ready in full quality: ${clip(title, 40)}`;
        if (S.view === 'done' || S.view === 'idle') draw();
        return;
      }
      if (status === 'failed' || status === 'terminated') {
        S.polls.delete(videoId);
        log(`Processing ${status}: ${videoId} ${v.processingDetails.processingFailureReason || ''}`);
        toast('YouTube could not process the clip', title, url);
        return;
      }
    } catch (e) { log(`Processing poll failed: ${e.message}`); }
    if (++n < 40) setTimeout(poll, 30000); else S.polls.delete(videoId);
  };
  setTimeout(poll, 20000);
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
        await youtube.videos.update({ part: 'snippet', requestBody: { id: h.videoId, snippet: { title: patch.title, categoryId: CFG.categoryId, tags: h.tags, description: h.description || buildMeta(path.join(CFG.watchDir, h.filename || h.title)).description } } });
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
  if (minimize) hideSelf();
}

function initKeyboard() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (str, k = {}) => {
    touch();
    if (IS_UI) {
      if (!S.connected && k.ctrl && k.name === 'c') { leaveScreen(); process.exit(0); }
      uiSendKey(str, k);
    } else handleKey(str, k);
  });
}

function handleKey(str, k = {}) {
  touch();
  cancelAutoHide();   // the user is at the window: don't yank it away
  if (k.ctrl && k.name === 'c') { shutdown(); return; }
  const ch = (str || '').toLowerCase();
  const name = k.name || '';

  // Help is reachable from every screen except the text editor.
  if (S.view === 'help') { if (name === 'escape' || ch === '?' || ch === 'q') { S.view = S.helpReturn; draw(); } return; }
  if (ch === '?' && S.view !== 'edit') { S.helpReturn = S.view; S.view = 'help'; draw(); return; }

  switch (S.view) {
    case 'edit': {
      const back = S.editReturn || 'done';
      if (name === 'return') {
        const t = S.editBuf.trim().slice(0, 100);
        S.view = back;
        if (S.editTarget === 'current' && S.current) { if (t) { S.current.title = t; S.notice = 'Title will be applied when the upload finishes'; } draw(); }
        else if (t && t !== S.last.title) updateVideo({ title: t });
        else draw();
      }
      else if (name === 'escape') { S.view = back; draw(); }
      else if (name === 'backspace') { if (S.editFresh) S.editFresh = false; else S.editBuf = S.editBuf.slice(0, -1); draw(); }
      else if (name === 'right' || name === 'end') { S.editFresh = false; draw(); }
      else if (str && !k.ctrl && !k.meta && str >= ' ') {
        if (S.editFresh) { S.editBuf = ''; S.editFresh = false; }
        if (S.editBuf.length < 100) S.editBuf += str;
        draw();
      }
      return;
    }

    case 'history': {
      const history = loadJson(HISTORY_FILE);
      const h = history[S.histCursor];
      if (S.histConfirm !== null) {
        if (ch === 'y' && h) {
          const p = historyFilePath(h);
          if (p) { try { const s = fs.statSync(p).size; fs.unlinkSync(p); log(`Deleted: ${path.basename(p)}`); S.notice = `Deleted ${path.basename(p)} (${fmtBytes(s)})`; } catch (e) { log(`Delete failed: ${e.message}`); } }
        }
        S.histConfirm = null; draw();
        return;
      }
      if (name === 'up') { S.histCursor--; draw(); }
      else if (name === 'down') { S.histCursor++; draw(); }
      else if (name === 'return' && h && h.url) openInBrowser(h.url);
      else if (ch === 'c' && h && h.url) { copyToClipboard(h.url); }
      else if (ch === 'x' && h && historyFilePath(h)) { S.histConfirm = S.histCursor; draw(); }
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
      if (ch === 't' && S.current) startEdit('current', 'uploading', S.current.title);
      else if (ch === 'p' && S.current) { const order = ['unlisted', 'public', 'private']; S.current.privacy = order[(order.indexOf(S.current.privacy) + 1) % order.length]; draw(); }
      else if (ch === 'x' && S.abort) { S.cancelled = true; S.abort.abort(); }
      else if (ch === 's' && S.queue.length) { const f = S.queue.shift(); markFile(f, 'skipped'); log(`Skipped: ${path.basename(f)}`); draw(); }
      else if (ch === 'q') hideSelf();
      return;

    case 'waiting':
      if (name === 'return' && S.resumeWait) S.resumeWait(false);
      else if (name === 'escape' && S.resumeWait) S.resumeWait(true);
      else if (ch === 'q') hideSelf();
      return;

    case 'error':
      if (name === 'return' && S.resumeError) S.resumeError('retry');
      else if (ch === 'a' && S.resumeError) S.resumeError('auth');
      else if (name === 'escape' && S.resumeError) S.resumeError('giveup');
      else if (ch === 'q') hideSelf();
      return;

    case 'done':
      if (ch === 't') startEdit('last', 'done', S.last.title);
      else if (ch === 'l' && S.last.videoId) openInBrowser(studioUrl(S.last.videoId));
      else if (ch === 'p') { const order = ['unlisted', 'public', 'private']; const cur = S.last.privacy || CFG.privacy; updateVideo({ privacy: order[(order.indexOf(cur) + 1) % order.length] }); }
      else if (ch === 'c') { copyToClipboard(S.last.url); S.notice = 'Link copied'; draw(); }
      else if (ch === 'o') openInBrowser(S.last.url);
      else if (ch === 'h') { S.histCursor = 0; S.view = 'history'; draw(); }
      else if (name === 'escape') goIdle();
      else if (ch === 'q') goIdle(true);
      return;

    case 'idle': {
      const last = S.last || lastUpload();
      if (last && !S.last) S.last = last;
      if (ch === 'c' && last) { copyToClipboard(last.url); S.notice = 'Link copied'; draw(); }
      else if (ch === 'o' && last) openInBrowser(last.url);
      else if (ch === 'l' && last && last.videoId) openInBrowser(studioUrl(last.videoId));
      else if (ch === 'f') openFolder(CFG.watchDir);
      else if (ch === 'a' && needsFullScope()) { S.notice = 'Opening Google sign-in in your browser…'; draw(); getAuth(true).then(() => { S.notice = 'Signed in — playlists and HD-ready alerts enabled'; draw(); }).catch(e => { S.notice = `${C.red}Sign-in failed: ${e.message}${C.reset}`; draw(); }); }
      else if (ch === 't' && last) startEdit('last', 'idle', last.title);
      else if (ch === 'p' && last) { const order = ['unlisted', 'public', 'private']; const cur = last.privacy || CFG.privacy; updateVideo({ privacy: order[(order.indexOf(cur) + 1) % order.length] }); }
      else if (ch === 'h') { S.histCursor = 0; S.view = 'history'; draw(); }
      else if (ch === 'd') { S.view = 'delete'; draw(); }
      else if (ch === 'r') restart();
      else if (ch === 'q') { S.notice = ''; goIdle(true); }
      return;
    }
  }
}

function restart() {
  log('Restarting...');
  if (!IS_DAEMON) leaveScreen();
  if (process.env.GAMEUPLOADER_LOOP) process.exit(3);   // run.bat restarts us; UI windows reconnect
  spawn(process.argv[0], process.argv.slice(1), { cwd: process.cwd(), detached: false, stdio: 'inherit', shell: true });
  process.exit(0);
}
function shutdown(reason = 'Ctrl+C') {
  log(`Quit (${reason})`);
  if (tray) tray.stop();
  if (IS_DAEMON) broadcast({ type: 'quit' }); else leaveScreen();
  setTimeout(() => process.exit(0), 250);
}
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

  process.on('uncaughtException', (e) => log(`Uncaught: ${e.stack || e.message}`));
  process.on('unhandledRejection', (e) => log(`Unhandled: ${(e && e.stack) || e}`));

  if (IS_UI) {
    // Viewer only: render the daemon's state, forward keys. Falls back to standalone if no daemon answers.
    process.title = WIN_TITLE;
    standaloneFallback = () => { log('No background process found — running standalone in this window'); IS_UI = false; S.connected = true; runCore(); };
    enterScreen();
    initKeyboard();
    startTickers();
    draw();
    startUiClient();
    return;
  }
  if (IS_DAEMON) {
    process.title = 'gu-daemon';   // must NOT contain the window title: the tray helper finds the UI window by title
    startIpcServer(() => {
      log('Background process already running — opening its window instead');
      spawnUi();
      setTimeout(() => process.exit(0), 500);
    });
    log(`Background process started (v${VERSION}) · pipe ${PIPE}`);
    runCore();
    // Open the UI window unless one (from before a restart) reconnects first.
    setTimeout(() => { if (!uiAttached()) spawnUi(); }, 3000);
    return;
  }
  process.title = WIN_TITLE;
  enterScreen();
  initKeyboard();
  startTickers();
  runCore();
  setTimeout(() => { if (S.view === 'idle') hideSelf(); }, 2000);
}

// icon.png (256 px, for toasts) and icon.ico are exported from the tray helper's artwork whenever the helper is rebuilt.
function ensureIconAssets() {
  const exe = path.join(SCRIPT_DIR, 'tray.exe'), png = path.join(SCRIPT_DIR, 'icon.png'), ico = path.join(SCRIPT_DIR, 'icon.ico');
  try {
    if (!fs.existsSync(exe)) return;
    if (fs.existsSync(png) && fs.statSync(png).mtimeMs >= fs.statSync(exe).mtimeMs) return;
    execFile(exe, ['--export-icon', png, ico], { windowsHide: true, timeout: 20000 }, (e) => log(e ? `Icon export failed: ${e.message}` : 'Icon assets exported (icon.png, icon.ico)'));
  } catch (e) { log(`Icon export failed: ${e.message}`); }
}

// Everything that makes the app tick (daemon and standalone modes): window helper, tray, watcher, config, clean-up.
function runCore() {
  initWindowHelper();
  ensureToastIdentity();
  log(`Watching: ${CFG.watchDir} (v${VERSION}, ${MODE})`);
  if (CFG.tray && !SIMULATE) tray = startTray({ dir: SCRIPT_DIR, title: WIN_TITLE, tooltip: `${WIN_TITLE} · starting`, onEvent: onTrayEvent, log });
  ensureIconAssets();
  draw();
  autoClean();
  setInterval(autoClean, 60 * 60 * 1000);
  startWatcher();
  watchConfig();
  setInterval(() => { if (IS_DAEMON && S.view === 'idle') publishState(); }, 30000);
  setInterval(() => { if (IS_DAEMON && S.view === 'waiting') publishState(); }, 1000);
}

// Watch the folder. ignoreInitial:false also picks up clips dropped while the app was closed
// (already-uploaded / skipped ones are filtered by uploaded.json).
let watcher = null;
function startWatcher() {
  if (watcher) { watcher.close().catch(() => {}); watcher = null; }
  if (!fs.existsSync(CFG.watchDir)) { try { fs.mkdirSync(CFG.watchDir, { recursive: true }); } catch (e) { log(`Can't create watch folder: ${e.message}`); } }
  watcher = chokidar.watch(CFG.watchDir, { ignoreInitial: false, depth: 0, awaitWriteFinish: false, usePolling: false });
  watcher.on('add', (filepath) => {
    if (CFG.extensions.includes(path.extname(filepath).toLowerCase())) enqueueFile(filepath);
  });
  watcher.on('error', (err) => log(`Watcher error: ${err.message}`));
}

// Reload config.json when it changes on disk — no restart needed.
function watchConfig() {
  if (argValue('--config')) return;
  fs.watchFile(CONFIG_FILE, { interval: 2000 }, () => {
    const { cfg, error } = loadConfig();
    if (error) { S.notice = `${C.red}config.json has an error: ${clip(error, 45)}${C.reset}`; log(`Config reload failed: ${error}`); }
    else {
      const dirChanged = cfg.watchDir !== CFG.watchDir;
      Object.assign(CFG, cfg);
      if (dirChanged) { startWatcher(); log(`Watch folder changed: ${CFG.watchDir}`); }
      S.notice = 'Settings reloaded';
      log('Config reloaded');
    }
    if (S.view === 'idle') draw();
  });
}

if (require.main === module) main();
else module.exports = { prettyTitle, buildMeta, pacificMidnight, classifyError, readToken, fmtBytes, fmtDuration, toast, isLockedForWrite, loadConfig, CFG };
