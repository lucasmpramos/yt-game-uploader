'use strict';
// YouTube resumable upload protocol (self-contained, no dependencies).
// https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
//
// Flow:
//   1. POST uploadUrl (metadata JSON)              -> 200 + Location: <sessionUri>
//   2. PUT  sessionUri  Content-Range: bytes a-b/N -> 308 (chunk stored; Range header = bytes acknowledged so far)
//                                                  -> 200/201 (upload complete; JSON body = video resource)
//   3. on transient failure: back off, then
//      PUT  sessionUri  Content-Range: bytes */N   -> 308 (resume from Range) | 200/201 (done) | 404/410 (session dead)
//
// Only the chunk currently in flight is ever held in memory.

const fs = require('fs');

const DEFAULT_UPLOAD_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const CHUNK_GRANULARITY = 256 * 1024;           // Google requires chunk sizes to be multiples of 256 KiB
const SESSION_MAX_AGE_MS = 20 * 60 * 60 * 1000; // Google keeps a session URI for ~1 day; be conservative
const BACKOFF_CAP_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Parse a `Range: bytes=0-N` header. Returns the last acknowledged byte index (N), or null if absent/invalid. */
function parseRange(header) {
  if (!header) return null;
  const m = /bytes=(\d+)-(\d+)/i.exec(header);
  if (!m) return null;
  const end = Number(m[2]);
  return Number.isFinite(end) ? end : null;
}

/** Normalize whatever getAuthHeaders() returned (plain object or WHATWG Headers) into a plain object. */
function toPlainHeaders(h) {
  const obj = {};
  if (!h) return obj;
  if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => { obj[k] = v; });
  else if (typeof h.forEach === 'function' && typeof h.get === 'function') h.forEach((v, k) => { obj[k] = v; }); // Headers-like
  else Object.assign(obj, h);
  return obj;
}

function abortError() {
  const err = new Error('aborted');
  err.aborted = true;
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/** Exponential backoff with jitter: base, 2*base, 4*base ... capped at 60 s. */
function backoffDelay(attempt, baseMs) {
  const exp = Math.min(baseMs * Math.pow(2, Math.max(0, attempt - 1)), BACKOFF_CAP_MS);
  const jitter = Math.random() * Math.min(baseMs, 1000);
  return exp + jitter;
}

/** setTimeout as a promise that rejects immediately with an abort error if the signal fires. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isTransientStatus(status) {
  return status >= 500 || status === 429 || status === 408;
}

function isSessionDeadStatus(status) {
  return status === 404 || status === 410;
}

/** Error for a fatal 4xx. Shape mirrors googleapis errors so callers can classify it: code, status, errors[0].reason. */
function apiError(status, body, text, context) {
  const e = body && body.error;
  const apiMsg = (e && (e.message || e.status)) || (text ? String(text).slice(0, 200) : '');
  const reasonFromBody = e && Array.isArray(e.errors) && e.errors[0] && e.errors[0].reason;
  const reason = reasonFromBody || (e && e.status) || `http${status}`;
  const err = new Error(`${context}: HTTP ${status}${apiMsg ? ` - ${apiMsg}` : ''}${reasonFromBody ? ` (${reasonFromBody})` : ''}`);
  err.code = status;
  err.status = status;
  err.errors = [{ reason, message: apiMsg }];
  err.response = body;
  return err;
}

/** Error for a retryable HTTP status. */
function transientError(status, context, text) {
  const err = new Error(`${context}: HTTP ${status}${text ? ` ${String(text).slice(0, 120)}` : ''}`);
  err.code = status;
  err.transient = true;
  return err;
}

/** Drain the response body (releases the connection) and parse JSON if possible. */
async function readBody(res) {
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = null; } }
  return { text, json };
}

/** Read `length` bytes at `position` from an open FileHandle into a fresh Buffer. */
async function readChunk(fh, position, length) {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new Error(`Unexpected EOF reading ${length} bytes at offset ${position}`);
    done += bytesRead;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Session file persistence (lets a restarted process pick up where it left off)
// ---------------------------------------------------------------------------

function readSessionFile(sessionFile, filepath, size, mtimeMs) {
  if (!sessionFile) return null;
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (!data || typeof data.uri !== 'string') return null;
    if (data.filepath !== filepath || data.size !== size || data.mtimeMs !== mtimeMs) return null;
    if (!Number.isFinite(data.createdAt) || Date.now() - data.createdAt > SESSION_MAX_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeSessionFile(sessionFile, data) {
  if (!sessionFile) return;
  try { fs.writeFileSync(sessionFile, JSON.stringify(data, null, 2)); } catch { /* best effort */ }
}

function deleteSessionFile(sessionFile) {
  if (!sessionFile) return;
  try { fs.unlinkSync(sessionFile); } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function resumableUpload({
  filepath,
  metadata,
  getAuthHeaders,
  uploadUrl = DEFAULT_UPLOAD_URL,
  chunkSize = 16 * 1024 * 1024,
  contentType = 'video/*',
  signal,
  onProgress,
  log,
  sessionFile,
  maxAttempts = 30,
  _backoffBaseMs = 1000, // test hook: shrink the backoff base
} = {}) {
  if (!filepath) throw new Error('resumableUpload: filepath is required');
  if (typeof getAuthHeaders !== 'function') throw new Error('resumableUpload: getAuthHeaders must be a function');
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize % CHUNK_GRANULARITY !== 0) {
    throw new Error(`resumableUpload: chunkSize must be a positive multiple of ${CHUNK_GRANULARITY} bytes (got ${chunkSize})`);
  }

  const say = typeof log === 'function' ? log : () => {};
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  const stat = await fs.promises.stat(filepath);
  const size = stat.size;
  const mtimeMs = stat.mtimeMs;

  let attempts = 0;    // transient failures so far (budget = maxAttempts)
  let restarts = 0;    // new sessions created after a 404/410 (budget = 1)
  let sessionUri = null;
  let offset = 0;      // next byte to send
  let fhPromise = null;
  const openFile = () => (fhPromise ||= fs.promises.open(filepath, 'r'));

  /** fetch wrapper: fresh auth headers on every request (so token refresh works), abort signal always attached. */
  async function requestWithAuth(url, { method, headers, body }) {
    throwIfAborted(signal);
    const auth = toPlainHeaders(await getAuthHeaders());
    try {
      return await fetch(url, { method, headers: { ...auth, ...headers }, body, signal });
    } catch (e) {
      if (signal && signal.aborted) throw abortError();
      throw e; // network-level failure (TypeError: fetch failed, ECONNRESET, ...) - callers treat as transient
    }
  }

  /** Protocol step 1: create a session and persist its URI. Throws (transient or fatal) on failure. */
  async function startSession() {
    say(`Starting resumable session for ${filepath} (${size} bytes)`);
    const res = await requestWithAuth(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': contentType,
      },
      body: JSON.stringify(metadata || {}),
    });
    const { text, json } = await readBody(res);
    if (isTransientStatus(res.status)) throw transientError(res.status, 'Session start', text);
    if (!res.ok) throw apiError(res.status, json, text, 'Session start');
    const uri = res.headers.get('location');
    if (!uri) throw new Error('Session start: HTTP 200 without a Location header');
    writeSessionFile(sessionFile, { filepath, size, mtimeMs, uri, createdAt: Date.now() });
    return uri;
  }

  /**
   * Interpret a response to a session PUT (chunk or status query).
   * Returns { kind: 'ack', offset } | { kind: 'done', body } | { kind: 'dead' } | { kind: 'transient', err }.
   * Throws for fatal 4xx. `fallbackOffset` is used when a 308 carries no Range header (nothing stored yet).
   */
  async function interpret(res, fallbackOffset, context) {
    const { text, json } = await readBody(res);
    if (res.status === 308) {
      const last = parseRange(res.headers.get('range'));
      return { kind: 'ack', offset: last === null ? fallbackOffset : last + 1 };
    }
    if (res.status === 200 || res.status === 201) return { kind: 'done', body: json };
    if (isSessionDeadStatus(res.status)) return { kind: 'dead' };
    if (isTransientStatus(res.status)) return { kind: 'transient', err: transientError(res.status, context, text) };
    throw apiError(res.status, json, text, context);
  }

  /** Protocol step 3: ask the server how many bytes it already has. */
  async function queryStatus(uri) {
    let res;
    try {
      res = await requestWithAuth(uri, {
        method: 'PUT',
        headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` },
      });
    } catch (e) {
      if (e.aborted) throw e;
      return { kind: 'transient', err: e };
    }
    return interpret(res, 0, 'Status query');
  }

  /** Protocol step 2: send one chunk starting at `start`. */
  async function sendChunk(uri, start) {
    const end = Math.min(start + chunkSize, size) - 1;
    const len = size === 0 ? 0 : end - start + 1;
    const buf = len === 0 ? Buffer.alloc(0) : await readChunk(await openFile(), start, len);
    let res;
    try {
      res = await requestWithAuth(uri, {
        method: 'PUT',
        headers: {
          'Content-Length': String(len),
          'Content-Type': contentType,
          'Content-Range': size === 0 ? 'bytes */0' : `bytes ${start}-${end}/${size}`,
        },
        body: buf,
      });
    } catch (e) {
      if (e.aborted) throw e;
      return { kind: 'transient', err: e };
    }
    return interpret(res, start, `Chunk ${start}-${end}`);
  }

  /** Count a transient failure against the budget, then wait (abortable). Throws the error once the budget is spent. */
  async function backoff(err) {
    attempts += 1;
    if (attempts > maxAttempts) {
      say(`Giving up after ${maxAttempts} transient failures: ${err && err.message}`);
      throw err;
    }
    const ms = backoffDelay(attempts, _backoffBaseMs);
    say(`Transient failure (${err && err.message}); retry ${attempts}/${maxAttempts} in ${Math.round(ms)} ms`);
    await sleep(ms, signal);
  }

  /** Session is gone (404/410): forget it and, once per upload, start over from byte 0. */
  function replaceDeadSession() {
    deleteSessionFile(sessionFile);
    if (restarts >= 1) {
      const err = new Error('Upload session expired or was not found (404/410) and the replacement session also died');
      err.code = 410; err.status = 410; err.errors = [{ reason: 'sessionDead' }];
      throw err;
    }
    restarts += 1;
    say('Upload session is dead; starting a new one from byte 0');
    sessionUri = null;
    offset = 0;
  }

  function finish(body) {
    deleteSessionFile(sessionFile);
    progress(size, size);
    const videoId = body && body.id;
    say(`Upload complete${videoId ? `: video ${videoId}` : ''}`);
    return { videoId, body };
  }

  /** After a transient failure: back off, then query status until we know where to resume. Returns { body } if done. */
  async function recover(err) {
    await backoff(err);
    for (;;) {
      const st = await queryStatus(sessionUri);
      if (st.kind === 'ack') { offset = st.offset; progress(offset, size); return undefined; }
      if (st.kind === 'done') return { body: st.body };
      if (st.kind === 'dead') { replaceDeadSession(); return undefined; }
      await backoff(st.err);
    }
  }

  try {
    // --- Resume a persisted session if it still matches this exact file ------------------------
    const saved = readSessionFile(sessionFile, filepath, size, mtimeMs);
    if (saved) {
      say(`Found saved session for ${filepath}; querying its status`);
      for (;;) {
        const st = await queryStatus(saved.uri);
        if (st.kind === 'ack') { sessionUri = saved.uri; offset = st.offset; say(`Resuming at byte ${offset}`); break; }
        if (st.kind === 'done') return finish(st.body);
        if (st.kind === 'dead') { say('Saved session is no longer valid'); deleteSessionFile(sessionFile); break; }
        await backoff(st.err);
      }
    }

    // --- Main loop -----------------------------------------------------------------------------
    for (;;) {
      throwIfAborted(signal);

      if (!sessionUri) {
        try {
          sessionUri = await startSession();
          offset = 0;
        } catch (e) {
          if (e.aborted) throw e;
          const transient = e.transient || (e.code === undefined && !e.errors); // network errors carry no HTTP code
          if (!transient) throw e;
          await backoff(e);
          continue;
        }
      }

      const r = await sendChunk(sessionUri, offset);
      if (r.kind === 'ack') { offset = r.offset; progress(offset, size); continue; }
      if (r.kind === 'done') return finish(r.body);
      if (r.kind === 'dead') { replaceDeadSession(); continue; }

      const done = await recover(r.err); // transient
      if (done) return finish(done.body);
    }
  } finally {
    if (fhPromise) { try { await (await fhPromise).close(); } catch { /* ignore */ } }
  }
}

module.exports = { resumableUpload, DEFAULT_UPLOAD_URL, parseRange };
