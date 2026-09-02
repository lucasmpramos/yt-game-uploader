'use strict';
// Tests for resumable.js against a local mock of the YouTube resumable upload endpoint.
// Run with:  node --test test/

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { resumableUpload } = require('../resumable.js');

const MiB = 1024 * 1024;
const FAST = { _backoffBaseMs: 5 };

// ---------------------------------------------------------------------------
// Mock server
// ---------------------------------------------------------------------------

/**
 * Minimal YouTube-style resumable endpoint.
 *   POST /upload           -> 200 + Location: /session/<id>
 *   PUT  /session/<id>     -> status query (bytes * / total) or chunk (bytes a-b/total)
 * Options:
 *   faults: inject (a) a dropped socket after fully reading the 2nd chunk, (b) a 503 on the 4th chunk
 *   postStatus / postBody: force the session POST to answer with a fixed status + JSON body
 */
function createMockServer({ faults = false, postStatus = null, postBody = null } = {}) {
  const state = {
    sessions: new Map(),      // id -> { total, chunks: Buffer[], received }
    postCount: 0,
    chunkPuts: 0,             // chunk PUTs seen (excluding status queries)
    statusQueries: 0,
    totalAppended: 0,         // bytes ever appended across all sessions (to detect duplicates)
    socketDropFired: 0,
    fault503Fired: 0,
    violations: 0,            // 400s returned for a start != received
  };

  function readAll(req) {
    return new Promise((resolve, reject) => {
      const parts = [];
      req.on('data', c => parts.push(c));
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/upload') {
        state.postCount++;
        await readAll(req);
        if (postStatus) {
          res.writeHead(postStatus, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(postBody || {}));
        }
        if (!req.headers.authorization) { res.writeHead(401); return res.end('{"error":{"message":"no auth"}}'); }
        const id = crypto.randomBytes(6).toString('hex');
        const total = Number(req.headers['x-upload-content-length']);
        state.sessions.set(id, { total, chunks: [], received: 0 });
        const { port } = server.address();
        res.writeHead(200, { Location: `http://127.0.0.1:${port}/session/${id}` });
        return res.end();
      }

      const m = /^\/session\/([a-f0-9]+)$/.exec(url.pathname);
      if (req.method === 'PUT' && m) {
        const s = state.sessions.get(m[1]);
        if (!s) { await readAll(req); res.writeHead(404); return res.end('{"error":{"message":"session not found"}}'); }
        const cr = String(req.headers['content-range'] || '');

        // --- status query ---------------------------------------------------
        const q = /^bytes \*\/(\d+)$/.exec(cr);
        if (q) {
          state.statusQueries++;
          await readAll(req);
          if (s.received >= s.total) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ id: 'TESTVIDEO' }));
          }
          const h = {};
          if (s.received > 0) h.Range = `bytes=0-${s.received - 1}`;
          res.writeHead(308, h);
          return res.end();
        }

        // --- chunk -----------------------------------------------------------
        const c = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
        if (!c) { await readAll(req); res.writeHead(400); return res.end('{"error":{"message":"bad Content-Range"}}'); }
        const start = Number(c[1]);
        state.chunkPuts++;
        const n = state.chunkPuts;
        const body = await readAll(req);

        if (start !== s.received) {
          state.violations++;
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: `protocol violation: start ${start} != received ${s.received}` } }));
        }

        // Fault B: 4th chunk PUT -> 503, bytes discarded.
        if (faults && n === 4 && state.fault503Fired === 0) {
          state.fault503Fired++;
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end('{"error":{"message":"backend error"}}');
        }

        s.chunks.push(body);
        s.received += body.length;
        state.totalAppended += body.length;

        // Fault A: 2nd chunk PUT -> bytes stored, but the connection dies before any response.
        if (faults && n === 2 && state.socketDropFired === 0) {
          state.socketDropFired++;
          req.socket.destroy();
          return;
        }

        if (s.received >= s.total) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: 'TESTVIDEO', snippet: { title: 'x' } }));
        }
        res.writeHead(308, { Range: `bytes=0-${s.received - 1}` });
        return res.end();
      }

      await readAll(req);
      res.writeHead(404);
      res.end();
    } catch (e) {
      try { res.writeHead(500); res.end(String(e)); } catch { /* socket gone */ }
    }
  });

  return {
    server,
    state,
    assembled(id) {
      const s = id ? state.sessions.get(id) : [...state.sessions.values()].pop();
      return s ? Buffer.concat(s.chunks) : Buffer.alloc(0);
    },
    listen() {
      return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
    },
    close() {
      server.closeAllConnections?.();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resumable-test-'));
}

function writeRandomFile(dir, name, bytes) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, crypto.randomBytes(bytes));
  return p;
}

const authAsObject = async () => ({ Authorization: 'Bearer test-token' });
const authAsHeaders = async () => new Headers({ Authorization: 'Bearer test-token' });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('round trip with faults (socket drop after stored chunk + 503 on a chunk)', async () => {
  const dir = makeTempDir();
  const mock = createMockServer({ faults: true });
  try {
    const base = await mock.listen();
    const filepath = writeRandomFile(dir, 'clip.mp4', 5 * MiB);
    const sessionFile = path.join(dir, 'session.json');
    const progress = [];
    let sessionFileSeen = false;

    const result = await resumableUpload({
      filepath,
      metadata: { snippet: { title: 'x' }, status: { privacyStatus: 'private' } },
      getAuthHeaders: authAsHeaders, // exercise the Headers-instance path
      uploadUrl: `${base}/upload`,
      chunkSize: 1 * MiB,
      sessionFile,
      onProgress: (ack, total) => {
        progress.push([ack, total]);
        if (fs.existsSync(sessionFile)) sessionFileSeen = true;
      },
      ...FAST,
    });

    assert.strictEqual(result.videoId, 'TESTVIDEO');
    assert.deepStrictEqual(result.body, { id: 'TESTVIDEO', snippet: { title: 'x' } });

    const original = fs.readFileSync(filepath);
    const assembled = mock.assembled();
    assert.strictEqual(assembled.length, original.length, 'server assembled byte count');
    assert.ok(assembled.equals(original), 'server assembled bytes equal the file');

    assert.ok(progress.length > 0, 'onProgress was called');
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] >= progress[i - 1][0], 'progress is non-decreasing');
    assert.strictEqual(progress[progress.length - 1][0], 5 * MiB);
    assert.ok(progress.every(([, t]) => t === 5 * MiB));

    assert.strictEqual(mock.state.socketDropFired, 1, 'socket-drop fault fired');
    assert.strictEqual(mock.state.fault503Fired, 1, '503 fault fired');
    assert.ok(mock.state.statusQueries >= 2, 'client queried status after each fault');
    assert.strictEqual(mock.state.chunkPuts, 6, '5 chunks + 1 resend of the 503 chunk');
    assert.strictEqual(mock.state.violations, 0, 'client never sent a wrong offset');
    assert.strictEqual(mock.state.totalAppended, 5 * MiB, 'no duplicate bytes were stored');

    assert.ok(sessionFileSeen, 'sessionFile existed during the upload');
    assert.ok(!fs.existsSync(sessionFile), 'sessionFile removed on success');
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resume after restart: abort mid-upload, then continue from the session file without resending', async () => {
  const dir = makeTempDir();
  const mock = createMockServer();
  try {
    const base = await mock.listen();
    const filepath = writeRandomFile(dir, 'clip.mp4', 5 * MiB);
    const sessionFile = path.join(dir, 'session.json');

    // First run: abort once the 2nd chunk has been acknowledged.
    const ac = new AbortController();
    let acks = 0;
    await assert.rejects(
      resumableUpload({
        filepath,
        metadata: { snippet: { title: 'x' } },
        getAuthHeaders: authAsObject,
        uploadUrl: `${base}/upload`,
        chunkSize: 1 * MiB,
        sessionFile,
        signal: ac.signal,
        onProgress: () => { if (++acks === 2) ac.abort(); },
        ...FAST,
      }),
      err => err.aborted === true && err.message === 'aborted',
    );
    assert.ok(fs.existsSync(sessionFile), 'sessionFile survives an abort');
    assert.strictEqual(mock.state.totalAppended, 2 * MiB, 'exactly two chunks stored before abort');
    assert.strictEqual(mock.state.sessions.size, 1);

    // Second run ("process restart"): should reuse the session and send only the remaining bytes.
    const progress = [];
    const result = await resumableUpload({
      filepath,
      metadata: { snippet: { title: 'x' } },
      getAuthHeaders: authAsObject,
      uploadUrl: `${base}/upload`,
      chunkSize: 1 * MiB,
      sessionFile,
      onProgress: (ack) => progress.push(ack),
      ...FAST,
    });

    assert.strictEqual(result.videoId, 'TESTVIDEO');
    assert.strictEqual(mock.state.postCount, 1, 'no new session was created');
    assert.strictEqual(mock.state.sessions.size, 1);
    assert.strictEqual(mock.state.totalAppended, 5 * MiB, 'server received no duplicate bytes');
    assert.strictEqual(mock.state.violations, 0);
    assert.ok(progress[0] >= 2 * MiB, 'resumed from the acknowledged offset');
    assert.ok(mock.assembled().equals(fs.readFileSync(filepath)));
    assert.ok(!fs.existsSync(sessionFile), 'sessionFile removed on success');
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fatal 4xx on session start is thrown with code + reason and is not retried', async () => {
  const dir = makeTempDir();
  const mock = createMockServer({
    postStatus: 403,
    postBody: { error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } },
  });
  try {
    const base = await mock.listen();
    const filepath = writeRandomFile(dir, 'clip.mp4', 256 * 1024);

    await assert.rejects(
      resumableUpload({
        filepath,
        metadata: {},
        getAuthHeaders: authAsObject,
        uploadUrl: `${base}/upload`,
        chunkSize: 256 * 1024,
        ...FAST,
      }),
      err => {
        assert.strictEqual(err.code, 403);
        assert.strictEqual(err.errors[0].reason, 'quotaExceeded');
        assert.match(err.message, /403/);
        assert.match(err.message, /quota/);
        return true;
      },
    );
    assert.strictEqual(mock.state.postCount, 1, 'no retries on a fatal 4xx');
    assert.strictEqual(mock.state.chunkPuts, 0);
  } finally {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chunkSize that is not a multiple of 256 KiB is rejected', async () => {
  const dir = makeTempDir();
  try {
    const filepath = writeRandomFile(dir, 'clip.mp4', 1024);
    await assert.rejects(
      resumableUpload({ filepath, metadata: {}, getAuthHeaders: authAsObject, chunkSize: 262144 + 1 }),
      /multiple of 262144/,
    );
    await assert.rejects(
      resumableUpload({ filepath, metadata: {}, getAuthHeaders: authAsObject, chunkSize: 1000000 }),
      /multiple of 262144/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
