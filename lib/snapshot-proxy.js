import http from 'node:http';
import https from 'node:https';
import { injectCreds } from './onvif-client.js';
import * as reolink from './vendors/reolink.js';

const MAX_REDIRECTS = 3;

// Per-camera "what worked last time" cache. When a method succeeds we record
// it and try that first on the next request. When it fails twice in a row we
// reset and walk the full ladder again. Stored in-memory — re-derived on boot.
const lastWorking = new Map(); // cameraId -> { method, failCount }

export async function proxySnapshot(camera, res) {
  const attempts = await runLadder(camera, res);
  if (attempts._served) return;
  // Log every full-failure so the user can see *why* a tile shows "failed".
  console.warn(`[snapshot] cam=${camera.id} (${camera.host}) all methods failed:`, attempts);
  res.status(502).json({ error: 'all snapshot methods failed', attempts });
}

// Returns either {_served:true} after piping a successful response, or
// an array-shaped result with per-attempt errors.
async function runLadder(camera, res) {
  const vendor = inferVendor(camera);
  const ladder = methodsFor(vendor, camera);
  const remembered = lastWorking.get(camera.id)?.method;
  if (remembered) {
    // Move the remembered method to the front of the ladder.
    const idx = ladder.findIndex((m) => m.id === remembered);
    if (idx > 0) ladder.unshift(...ladder.splice(idx, 1));
  }

  const attempts = [];
  for (const method of ladder) {
    try {
      await method.run(camera, res);
      lastWorking.set(camera.id, { method: method.id, failCount: 0 });
      attempts._served = true;
      return attempts;
    } catch (err) {
      attempts.push({ method: method.id, error: err.message });
      // Per-method cleanup after failure so the next attempt starts clean.
      if (method.id === 'reolink-token') reolink.invalidateToken(camera.host);
      if (res.headersSent) {
        // Shouldn't happen — methods are expected to throw before sending
        // headers. If it does, stop the ladder to avoid corrupt responses.
        return attempts;
      }
    }
  }
  const prev = lastWorking.get(camera.id);
  lastWorking.set(camera.id, { method: prev?.method, failCount: (prev?.failCount || 0) + 1 });
  return attempts;
}

function inferVendor(cam) {
  if (cam.vendor) return cam.vendor;
  const url = cam.snapshot_url || '';
  if (/api\.cgi.*cmd=Snap/i.test(url)) return 'reolink';
  if (/ISAPI\/Streaming/i.test(url)) return 'hikvision';
  if (/snapshot\.cgi/i.test(url)) return 'dahua';
  if (/axis-cgi/i.test(url)) return 'axis';
  return null;
}

function methodsFor(vendor, camera) {
  const out = [];
  if (vendor === 'reolink' && camera.username) {
    out.push({ id: 'reolink-token', run: runReolinkToken });
  }
  if (camera.snapshot_url) {
    out.push({ id: 'url-creds', run: runUrlCreds });
  }
  // Future: 'onvif-snapshot', 'rtsp-grab' via ffmpeg
  return out;
}

async function runReolinkToken(camera, res) {
  const upstream = await reolink.fetchSnapshot(camera);
  res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  await pipeWithError(upstream, res);
}

async function runUrlCreds(camera, res) {
  const target = withCacheBust(injectCreds(camera.snapshot_url, camera.username, camera.password));
  await followAndPipe(target, res, MAX_REDIRECTS);
}

function withCacheBust(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('rs')) u.searchParams.set('rs', Math.random().toString(36).slice(2, 10));
    u.searchParams.set('_t', Date.now().toString());
    return u.toString();
  } catch {
    return url;
  }
}

function followAndPipe(url, res, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { return reject(new Error('bad snapshot url')); }
    const lib = parsed.protocol === 'https:' ? https : http;

    const headers = { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' };
    if (parsed.username) {
      const user = decodeURIComponent(parsed.username);
      const pass = decodeURIComponent(parsed.password || '');
      headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    }

    const req = lib.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
        timeout: 6000,
        rejectUnauthorized: false,
      },
      (upstream) => {
        const code = upstream.statusCode || 0;
        if (code >= 300 && code < 400 && upstream.headers.location && redirectsLeft > 0) {
          upstream.resume();
          const next = new URL(upstream.headers.location, url);
          if (parsed.username && !next.username && next.hostname === parsed.hostname) {
            next.username = parsed.username;
            next.password = parsed.password;
          }
          followAndPipe(next.toString(), res, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (code >= 400) {
          upstream.resume();
          return reject(new Error(`http ${code}`));
        }
        const ct = (upstream.headers['content-type'] || '').toLowerCase();
        if (ct.includes('json') || ct.includes('text/html')) {
          let buf = '';
          upstream.setEncoding('utf8');
          upstream.on('data', (c) => (buf += c));
          upstream.on('end', () => reject(new Error('non-image response: ' + buf.slice(0, 120))));
          return;
        }
        res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        pipeWithError(upstream, res).then(resolve, reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
  });
}

function pipeWithError(upstream, res) {
  return new Promise((resolve, reject) => {
    upstream.on('error', reject);
    res.on('error', reject);
    upstream.on('end', resolve);
    upstream.pipe(res);
  });
}

export function forgetCamera(id, host) {
  lastWorking.delete(id);
  if (host) reolink.invalidateToken(host);
}
