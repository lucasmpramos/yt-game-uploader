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

## Screens

**Idle** — a small dashboard: last upload with its link, how many of today's uploads you've used, how many already-uploaded clips are still on disk.

**Uploading** — flicker-free progress bar, speed and ETA, the queue by name. `X` cancels the current upload, `S` skips the next one.

**Done** — the link, plus `T` to edit the title and `P` to cycle privacy (unlisted → public → private) without opening a browser.

**Error** — plain-English messages instead of raw API errors: daily limit reached (with the reset time), Google sign-in expired (`A` to sign in again), no internet (auto-retries with a visible countdown).

**History** — browse past uploads with the arrow keys, `Enter` opens one, `C` copies its link.

## Keyboard

```
Idle        C copy last link · O open · H history · D clean up · R restart · Q minimize
Uploading   X cancel this · S skip next · Q minimize
Done        T edit title · P privacy · C copy · O open · Q minimize
Error       Enter retry · A sign in again · Esc give up · Q minimize
History     ↑↓ select · Enter open · C copy link · Esc back
Anywhere    Ctrl+C quit
```

## Features

- **Instant detection** with [chokidar](https://github.com/paulmillr/chokidar); clips dropped while the app was closed are picked up on the next start
- **Never interrupts the game** — stays minimized, signals with a toast and taskbar flash (`popupOnUpload` in config if you prefer the old behavior)
- **Windows toast** on completion; clicking it opens the video
- **Nice titles** — `ARC Raiders - 2026-08-27 12-57-02 AM.mp4` becomes `ARC Raiders — Aug 27, 2026 00:57`, and the game name is added as a tag
- **Daily limit awareness** — YouTube's API allows roughly 6 uploads per day on the default quota; the app shows your count, and if you hit the limit it queues the clip and resumes automatically after the reset
- **Auto clean-up** — clips are deleted from disk 7 days after a confirmed upload (`deleteAfterDays`, 0 to disable); `D` cleans up immediately
- **Upload queue**, retry with backoff, cancel and skip
- **Auto-start** with Windows via the Startup folder

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
| `popupOnUpload` | `false` | Bring the window to front when a clip is detected |
| `toast` / `sounds` / `clipboard` | `true` | Notification toggles |
| `deleteAfterDays` | `7` | Auto-delete uploaded clips from disk after N days (0 = never) |
| `dailyUploadLimit` | `6` | Your YouTube API daily upload allowance |
| `minSizeMB` | `1` | Ignore files smaller than this |

### 5. Auto-start with Windows (optional)

Copy `start.bat` into `shell:startup` (Win+R → `shell:startup`). It launches the app minimized in Windows Terminal.

## Demo mode

```bash
npm run demo
```

Runs the full UI with fake uploads and separate `*.sim.json` data files — useful for trying the screens without touching YouTube or your real history.

## Files

```
index.js          The whole app
config.json       Your settings (created on first run)
client_secret.json  Google OAuth client (you provide)
token.json        Your sign-in token (created by npm run auth)
history.json      Last 100 uploads
uploaded.json     Which files were handled (uploaded / skipped / cancelled)
uploader.log      Log
```

## License

ISC
