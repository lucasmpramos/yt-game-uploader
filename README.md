# GameUploader

Auto-uploads gameplay videos to YouTube when dropped in a watched folder.

## Features

- Watches `C:\Users\<user>\Videos\yt-uploads` for new `.mp4` files
- Uploads to YouTube as **unlisted** via YouTube Data API v3
- Terminal UI with real-time progress bar, speed, and ETA
- Upload queue — handles multiple files sequentially
- Auto-minimizes on startup, restores when uploading
- Copies YouTube link to clipboard on completion
- Upload history
- Delete uploaded files from disk
- Auto-starts with Windows via Startup folder
- Retry with backoff on failure

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `H` | Show upload history |
| `D` | Delete uploaded videos from disk |
| `O` | Open last upload in browser |
| `C` | Copy last upload link to clipboard |
| `R` | Restart the app |
| `Q` | Minimize to taskbar |
| `Ctrl+C` | Exit |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. YouTube API credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project and enable **YouTube Data API v3**
3. Create **OAuth 2.0 Client ID** (Desktop app)
4. Download the JSON and save as `client_secret.json` in this folder

### 3. Authenticate

```bash
node index.js --auth
```

This opens a browser window to authorize YouTube access.

### 4. Run

```bash
node index.js
```

Or use the batch file:

```bash
start.bat
```

### 5. Auto-start with Windows

Copy `start.bat` to:
```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
```

## Config

Edit the constants at the top of `index.js`:

- `WATCH_DIR` — folder to watch for new videos
- `MIN_SIZE` — minimum file size to upload (default: 1MB)
- Privacy status — change `unlisted` to `public` or `private` in the upload config
