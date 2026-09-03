# yt-game-uploader

A lightweight terminal app that watches a folder and automatically uploads new gameplay clips to YouTube.

Built for gamers who record with Steam, Radeon ReLive, OBS, or similar tools and want their clips on YouTube without manual work — and without the uploader popping over the game.

## How it works

```
Record gameplay → Clip saved to folder → Detected → Uploaded → Toast + link on clipboard
```

1. The app watches `Videos\yt-uploads` for new `.mp4` / `.mkv` / `.mov` files
2. It waits for the recorder to finish writing, then uploads with a live progress bar
3. When done: Windows toast notification, YouTube link copied to your clipboard, taskbar flash
4. It stays minimized the whole time — it never steals focus from your game

## Tray mode

The app lives in the system tray. The terminal window is hidden until you want it:

- **Left-click** the icon (a pixel `▲` — cyan while watching, pink while uploading, red on error, gray when paused) to show or hide the window. `Q` hides it again.
- **Hover** for status: "watching · 2 of 6 today · last: …" or "Uploading 61% · 22s left".
- **Right-click**: Show window · Copy last link · Open last clip · Open watch folder · Pause watching · Start with Windows · Quit.
- When an upload finishes (or fails) the window **appears without taking focus** — your game keeps keyboard and mouse — and hides itself again after 2 minutes unless you press a key in it (`showAfterUpload`, `autoHideAfter`).

The tray icon is a ~10 KB helper (`tray.cs`) compiled on first run by the C# compiler that ships with Windows — no downloads, no third-party binaries. Without it (`tray: false` or no compiler) the app falls back to minimizing to the taskbar.

Closing the terminal window with ✕ still quits the app (Windows Terminal doesn't let us intercept that) — use `Q` or the tray's Quit.

## Screens

**Idle** — a small dashboard: last upload with its link, how many of today's uploads you've used, how many already-uploaded clips are still on disk.

**Uploading** — flicker-free progress bar, speed and ETA, the queue by name. `X` cancels the current upload, `S` skips the next one.

**Done** — the link, plus `T` to edit the title and `P` to cycle privacy (unlisted → public → private) without opening a browser.

**Error** — plain-English messages instead of raw API errors: daily limit reached (with the reset time), Google sign-in expired (`A` to sign in again), no internet (auto-retries with a visible countdown).

**History** — browse past uploads with the arrow keys, `Enter` opens one, `C` copies its link.

## Keyboard

```
Dashboard   C copy last link · O open · L open in YouTube Studio · T edit title · P privacy
            H history · F open folder · D clean up · R restart · Q minimize
Uploading   T edit title · P privacy (applied when the upload finishes) · X cancel · S skip next · Q minimize
Done        T edit title · P privacy · C copy · O open · L studio · Q minimize
Error       Enter retry · A sign in again · Esc give up · Q minimize
History     ↑↓ select · Enter open · C copy link · X delete that file from disk · Esc back
Anywhere    ? help · Esc back · Ctrl+C quit
```

## Features

- **Instant detection** with [chokidar](https://github.com/paulmillr/chokidar); clips dropped while the app was closed are picked up on the next start
- **Never interrupts the game** — stays minimized, signals with a toast and taskbar flash (`popupOnUpload` in config if you prefer the old behavior)
- **Windows toast** on completion; clicking it opens the video
- **Nice titles** — `ARC Raiders - 2026-08-27 12-57-02 AM.mp4` becomes `ARC Raiders — Aug 27, 2026 00:57`, and the game name is added as a tag
- **Daily limit awareness** — YouTube's API allows roughly 6 uploads per day on the default quota; the app shows your count, and if you hit the limit it queues the clip and resumes automatically after the reset
- **Auto clean-up** — clips are deleted from disk 7 days after a confirmed upload (`deleteAfterDays`, 0 to disable); `D` cleans up immediately, or `X` on a single entry in History
- **Resumable uploads** — a dropped connection continues from the last confirmed byte instead of restarting a multi-GB clip; an upload session even survives an app restart
- **Waits for the recorder** — uploads start only when the file has stopped growing *and* no other program still has it open for writing
- **Playlists per game** — every clip lands in a playlist named after the game (created on first use); override the name per game in config
- **"Ready in full quality" alert** — a second toast when YouTube has finished processing, so you don't share a 360p link
- **Templates** — title and description from `{game} {date} {time} {file} {size}`, with per-game overrides for privacy, tags, playlist, and templates
- **Live settings** — edit `config.json` and the app applies it without a restart
- **Upload queue**, retry with backoff, cancel and skip
- **Crash-proof** — `run.bat` restarts the app if it ever dies; `R` restarts on demand
- **Auto-start** with Windows via the Startup folder
- **Retro console jingles** for done / error / ready (`sounds: false` to mute)

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer
- A Google Cloud project with the YouTube Data API v3 enabled

### 1. Clone and install

```bash
git clone https://github.com/lucasmpramos/yt-game-uploader.git
cd yt-game-uploader
npm install
```

### 2. Google credentials

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**
2. Create an **OAuth client ID** of type **Desktop app**
3. Download the JSON and save it as `client_secret.json` in the project folder

### 3. Sign in

```bash
npm run auth
```

A browser tab opens for Google sign-in. The token is saved to `token.json`.

### 4. Run

```bash
npm start
```

On first run a `config.json` is created with defaults you can edit:

| Key | Default | What it does |
| --- | --- | --- |
| `watchDir` | `~/Videos/yt-uploads` | Folder to watch |
| `extensions` | `[".mp4", ".mkv", ".mov"]` | File types to upload |
| `privacy` | `"unlisted"` | `unlisted`, `public`, or `private` |
| `tags` | `["gameplay"]` | Tags added to every upload (game name is added automatically) |
| `tray` | `true` | Tray icon; the window hides to the tray instead of minimizing |
| `showAfterUpload` | `true` | Show the window (without stealing focus) when an upload finishes or fails |
| `autoHideAfter` | `120` | Seconds until an auto-shown window hides again (0 = never); any key cancels |
| `popupOnUpload` | `false` | Also show the window when a clip is *detected* |
| `toast` / `sounds` / `clipboard` | `true` | Notification toggles |
| `deleteAfterDays` | `7` | Auto-delete uploaded clips from disk after N days (0 = never) |
| `dailyUploadLimit` | `6` | Your YouTube API daily upload allowance |
| `minSizeMB` | `1` | Ignore files smaller than this |
| `titleTemplate` | `{game} — {date} {time}` | YouTube title (only used when a game name is found in the filename) |
| `descriptionTemplate` | `{game} gameplay · {date}\nUploaded automatically by GameUploader` | YouTube description |
| `playlists` | `true` | Add each clip to a playlist named after the game |
| `hdReadyToast` | `true` | Notify when YouTube has finished processing the clip |
| `games` | `{}` | Per-game overrides, e.g. `{ "ARC Raiders": { "privacy": "public", "tags": ["arc raiders"], "playlist": "ARC clips", "titleTemplate": "[{game}] {date}" } }` |

Changes to `config.json` are picked up live — no restart needed.

**Permissions:** the first sign-in grants the full YouTube permission (needed for playlists and processing status). If you signed in with an older version you'll see a one-line reminder on the dashboard — press `A` to re-sign in once.

### 5. Auto-start with Windows (optional)

Tick **Start with Windows** in the tray menu — it installs a launcher in `shell:startup`. (Manual alternative: copy `start.bat` there with absolute paths.) The launcher opens `run.bat` in its own Windows Terminal window, which keeps the app alive: crashes restart it after 5 s, and `R` restarts it instantly.

## Demo mode

```bash
npm run demo
```

Runs the full UI with fake uploads and separate `*.sim.json` data files — useful for trying the screens without touching YouTube or your real history.

## Tests

```bash
npm test
```

Unit tests for title parsing, templates and overrides, file-lock detection (with a really locked file), and the resumable upload protocol against a local mock of YouTube's upload server that drops connections mid-way.

## Files

```
index.js          The app (UI, queue, YouTube calls)
resumable.js      Resumable upload protocol
tray.cs / tray.js Tray icon + window control helper (compiled to tray.exe on first run)
run.bat           Keeps the app running (auto-restart); start.bat opens it in Windows Terminal
config.json       Your settings (created on first run, reloaded live)
client_secret.json  Google OAuth client (you provide)
token.json        Your sign-in token (created by npm run auth)
history.json      Last 100 uploads
uploaded.json     Which files were handled (uploaded / skipped / cancelled)
playlists.json    Playlist name → id cache
uploader.log      Log (rotates at 1 MB)
```

## License

ISC
