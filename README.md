# yt-game-uploader

A lightweight terminal app that watches a folder and automatically uploads new gameplay videos to YouTube.

Built for gamers who record with Steam, Radeon ReLive, or similar tools and want their clips on YouTube without manual work.

## How it works

```
Record gameplay → Video saved to folder → Auto-detected → Uploaded to YouTube → Link copied to clipboard
```

1. The app watches `Videos\yt-uploads` for new `.mp4` files
2. When a new video appears, the terminal restores itself and shows a real-time progress bar
3. Once uploaded, the YouTube link is automatically copied to your clipboard
4. The app minimizes back and keeps watching

No browser tabs, no manual uploads, no drag-and-drop. Just drop a file and it's on YouTube.

## Features

- **Instant detection** — uses [chokidar](https://github.com/paulmillr/chokidar) for file system watching
- **Real-time progress** — progress bar with upload speed (MB/s) and ETA
- **Upload queue** — drop multiple files at once, they upload sequentially
- **Auto-clipboard** — YouTube link copied automatically on completion
- **Upload history** — browse your last 50 uploads with links
- **Disk cleanup** — delete already-uploaded videos from disk with one key
- **Auto-start** — launches minimized with Windows via Startup folder
- **Smart window** — minimizes when idle, restores when uploading, never steals focus from games
- **Retry logic** — retries up to 3x with backoff on failure
- **Distinct sounds** — different audio cues for success and error

## Keyboard Shortcuts

```
┌─────────────────────────────────────────────────────┐
│  [H]  Show upload history                           │
│  [D]  Delete uploaded videos from disk              │
│  [O]  Open last upload in browser                   │
│  [C]  Copy last upload link to clipboard            │
│  [R]  Restart the app                               │
│  [Q]  Minimize to taskbar                           │
│  [Y]  Confirm deletion (in delete screen)           │
│  [Esc] Go back                                      │
│  Ctrl+C  Exit                                       │
└─────────────────────────────────────────────────────┘
```

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A Google Cloud project with YouTube Data API v3 enabled

### 1. Clone and install

```bash
git clone https://github.com/lucasmpramos/yt-game-uploader.git
cd yt-game-uploader
npm install
```

### 2. YouTube API credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Go to **APIs & Services** → **Library** → search **YouTube Data API v3** → **Enable**
4. Go to **APIs & Services** → **Credentials** → **+ Create Credentials** → **OAuth client ID**
   - If prompted, configure the OAuth consent screen first (External, add your email as test user)
   - Application type: **Desktop app**
   - Name: anything (e.g. "GameUploader")
5. Download the JSON and save it as `client_secret.json` in the project folder
6. Go to **OAuth consent screen** → **Publish App** (so the token doesn't expire in 7 days)

### 3. Authenticate

```bash
node index.js --auth
```

A browser window will open asking you to authorize YouTube access. Sign in and approve.

### 4. Run

```bash
node index.js
```

Or use the included batch file:

```bash
start.bat
```

### 5. Auto-start with Windows (optional)

Copy `start.bat` to your Windows Startup folder:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
```

The app will launch minimized every time you log in.

## Configuration

Edit the constants at the top of `index.js`:

| Variable | Default | Description |
|----------|---------|-------------|
| `WATCH_DIR` | `Videos\yt-uploads` | Folder to watch for new videos |
| `MIN_SIZE` | `1 MB` | Minimum file size to upload (ignores tiny/corrupt files) |
| `privacyStatus` | `unlisted` | Upload visibility: `unlisted`, `public`, or `private` |

## File structure

```
yt-game-uploader/
├── index.js           # Main app (watcher + uploader + UI)
├── upload_ui.js       # Legacy UI module (unused)
├── start.bat          # Windows launcher
├── package.json       # Node.js dependencies
├── client_secret.json # YouTube OAuth credentials (not in repo)
├── token.json         # YouTube auth token (not in repo)
├── uploaded.json      # List of uploaded file paths (not in repo)
└── history.json       # Upload history (not in repo)
```

## Tech stack

- **Node.js** — runtime
- **googleapis** — YouTube Data API v3 client
- **chokidar** — file system watcher
- **PowerShell** — window management (minimize/restore/flash)

## License

MIT
