const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SCRIPT_DIR = path.join('C:\\Users\\Lucas Machado\\GameUploader');
const PROGRESS_FILE = path.join(SCRIPT_DIR, 'progress.json');

// Set window title
process.title = 'GameUploader';
process.stdout.write('\x1b]0;GameUploader\x07');

function readProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function clear() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function color(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function progressBar(pct, width = 40) {
  const filled = Math.round(width * pct / 100);
  return color('█'.repeat(filled), '32') + color('░'.repeat(width - filled), '90');
}

function render(data, copied) {
  clear();
  console.log('');
  console.log(color('  ╔══════════════════════════════════════════════╗', '36'));
  console.log(color('  ║', '36') + color('          G A M E   U P L O A D E R          ', '1;36') + color('║', '36'));
  console.log(color('  ╚══════════════════════════════════════════════╝', '36'));
  console.log('');

  if (!data) {
    console.log(color('  Waiting for upload to start...', '90'));
    return;
  }

  const { state, file } = data;

  if (state === 'detected') {
    console.log(color('  ● New video detected!', '1;33'));
    console.log(`  File: ${file}`);
    console.log(color('  Preparing...', '33'));
  } else if (state === 'uploading') {
    const { title, size_mb, progress } = data;
    process.title = `GameUploader - ${progress}%`;
    console.log(color('  ▲ Uploading', '1;32'));
    console.log(`  File:  ${file}`);
    console.log(`  Title: ${color(title, '1')}`);
    console.log(`  Size:  ${size_mb} MB`);
    console.log('');
    console.log(`  ${progressBar(progress)} ${progress}%`);
  } else if (state === 'done') {
    const { title, size_mb, video_id, url } = data;
    process.title = 'GameUploader - Done!';
    console.log(color('  ✓ Upload Complete!', '1;32'));
    console.log(`  File:     ${file}`);
    console.log(`  Title:    ${color(title, '1')}`);
    console.log(`  Size:     ${size_mb} MB`);
    console.log(`  Video ID: ${video_id}`);
    console.log('');
    console.log(`  URL: ${color(url, '1;4;36')}`);
    console.log('');
    if (copied) {
      console.log(color('  ✓ Link copied to clipboard!', '1;32'));
    } else {
      console.log(color('  Press [C] to copy link  |  Press [Q] to close', '90'));
    }
    // Flash taskbar
    try {
      const { execSync } = require('child_process');
      execSync('powershell -Command "[console]::beep(800,200)"', { stdio: 'ignore' });
    } catch {}
  } else if (state === 'retrying') {
    const { attempt, max_retries, error } = data;
    process.title = `GameUploader - Retrying ${attempt}/${max_retries}`;
    console.log(color(`  ⟳ Retrying (${attempt}/${max_retries})`, '1;33'));
    console.log(`  File:  ${file}`);
    console.log(`  Error: ${color(error, '31')}`);
  } else if (state === 'error') {
    process.title = 'GameUploader - Error';
    console.log(color('  ✗ Error', '1;31'));
    console.log(`  File:  ${file}`);
    console.log(`  Error: ${color(data.error, '31')}`);
    console.log('');
    console.log(color('  Press [Q] to close', '90'));
  }
}

async function copyToClipboard(text) {
  try {
    const clipboardy = await import('clipboardy');
    clipboardy.default.writeSync(text);
    return true;
  } catch {
    try {
      const { execSync } = require('child_process');
      execSync(`echo ${text}| clip`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

// Setup keyboard input
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

let copied = false;
let lastState = null;
let doneBeep = false;

process.stdin.on('keypress', async (str, key) => {
  if (key.ctrl && key.name === 'c') process.exit();

  const data = readProgress();
  const state = data?.state;

  if ((key.name === 'c' || str === 'c') && state === 'done' && data?.url) {
    copied = await copyToClipboard(data.url);
    render(data, copied);
  }

  if ((key.name === 'q' || str === 'q') && (state === 'done' || state === 'error')) {
    process.exit();
  }
});

// Main render loop
setInterval(() => {
  const data = readProgress();
  const state = data?.state;

  if (state !== lastState) {
    copied = false;
    if (state === 'done' && !doneBeep) {
      doneBeep = true;
    }
    lastState = state;
  }

  render(data, copied);
}, 500);
