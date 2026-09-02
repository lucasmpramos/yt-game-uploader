// Unit tests for the pure logic in index.js (titles, templates, overrides, lock detection).
// Run: npm test   (node --test test/)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

process.argv.push('--config', path.join(os.tmpdir(), 'gameuploader-test-config-does-not-exist.json'));
const app = require('../index.js');

test('prettyTitle parses ReLive, Steam, OBS and plain names', () => {
  assert.equal(app.prettyTitle('ARC Raiders - 2026-08-27 12-57-02 AM').title, 'ARC Raiders — Aug 27, 2026 00:57');
  assert.equal(app.prettyTitle('ARC Raiders - 2026-07-27 11-39-18 PM').title, 'ARC Raiders — Jul 27, 2026 23:39');
  assert.equal(app.prettyTitle('ARC Raiders 2026.08.27 - 12.57.02.01').game, 'ARC Raiders');
  assert.equal(app.prettyTitle('2026-08-27 12-57-02').title, 'Clip — Aug 27, 2026 12:57');
  assert.equal(app.prettyTitle('Tower_Killaz_Mad_Otto').title, 'Tower Killaz Mad Otto');
  assert.equal(app.prettyTitle('Tower_Killaz_Mad_Otto').game, '');
});

test('buildMeta applies templates and per-game overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-meta-'));
  const f = path.join(dir, 'ARC Raiders - 2026-08-27 12-57-02 AM.mp4');
  fs.writeFileSync(f, Buffer.alloc(2048));
  const saved = { ...app.CFG, games: { ...app.CFG.games } };
  try {
    Object.assign(app.CFG, { titleTemplate: '{game} · {date}', descriptionTemplate: 'Clip {file} ({size})', tags: ['gameplay'], privacy: 'unlisted', playlists: true, games: {} });
    let m = app.buildMeta(f);
    assert.equal(m.title, 'ARC Raiders · Aug 27, 2026');
    assert.equal(m.description, 'Clip ARC Raiders — Aug 27, 2026 00:57 (0 MB)');
    assert.deepEqual(m.tags, ['arc raiders', 'gameplay']);
    assert.equal(m.privacy, 'unlisted');
    assert.equal(m.playlist, 'ARC Raiders');

    app.CFG.games = { 'arc raiders': { privacy: 'public', tags: ['extraction'], playlist: 'ARC clips', titleTemplate: '[{game}] {time}' } };
    m = app.buildMeta(f);
    assert.equal(m.title, '[ARC Raiders] 00:57');
    assert.deepEqual(m.tags, ['arc raiders', 'extraction']);
    assert.equal(m.privacy, 'public');
    assert.equal(m.playlist, 'ARC clips');

    app.CFG.playlists = false;
    assert.equal(app.buildMeta(f).playlist, null);

    // No game in the filename: the cleaned filename wins over the template, no playlist.
    const plain = path.join(dir, 'Tower_Killaz_Mad_Otto.mp4');
    fs.writeFileSync(plain, Buffer.alloc(10));
    app.CFG.playlists = true;
    m = app.buildMeta(plain);
    assert.equal(m.title, 'Tower Killaz Mad Otto');
    assert.equal(m.playlist, null);
    assert.deepEqual(m.tags, ['gameplay']);
  } finally {
    Object.assign(app.CFG, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isLockedForWrite detects a file another process holds open for writing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-lock-'));
  const f = path.join(dir, 'recording.mp4');
  fs.writeFileSync(f, Buffer.alloc(1024));
  assert.equal(app.isLockedForWrite(f), false, 'unlocked file should not be reported locked');

  // Hold the file open like a recorder does (write access, share-read only) for ~3 seconds.
  const ps = spawn('powershell', ['-NoProfile', '-Command',
    `$fs=[System.IO.File]::Open('${f.replace(/'/g, "''")}','Open','Write','Read'); Write-Output LOCKED; Start-Sleep -Seconds 3; $fs.Close()`],
    { windowsHide: true });
  await new Promise((resolve, reject) => {
    ps.stdout.on('data', d => { if (String(d).includes('LOCKED')) resolve(); });
    ps.on('exit', () => reject(new Error('powershell exited before locking')));
    setTimeout(() => reject(new Error('timeout waiting for lock')), 15000);
  });
  assert.equal(app.isLockedForWrite(f), true, 'file held open by another process should be locked');
  await new Promise(resolve => ps.on('exit', resolve));
  assert.equal(app.isLockedForWrite(f), false, 'released file should be unlocked again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig tolerates a broken file and reports the error', () => {
  const { cfg, error } = app.loadConfig();
  assert.equal(error, null);
  assert.ok(cfg.watchDir);
  assert.ok(Array.isArray(cfg.extensions));
});

test('classifyError maps API errors to kinds', () => {
  assert.equal(app.classifyError({ message: 'x', errors: [{ reason: 'quotaExceeded' }], code: 403 }).kind, 'quota');
  assert.equal(app.classifyError({ message: 'invalid_grant' }).kind, 'auth');
  assert.equal(app.classifyError({ message: 'fetch failed' }).kind, 'network');
  assert.equal(app.classifyError({ message: 'ENOENT: gone' }).kind, 'gone');
});
