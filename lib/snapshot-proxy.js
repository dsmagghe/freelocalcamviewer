import http from 'node:http';
import https from 'node:https';
import { injectCreds } from './onvif-client.js';

const MAX_REDIRECTS = 3;

export function proxySnapshot(camera, res) {
  const withCreds = injectCreds(camera.snapshot_url, camera.username, camera.password);
  if (!withCreds) {
    res.status(404).end('no snapshot url');
    return;
  }
  followAndPipe(withCacheBust(withCreds), res, MAX_REDIRECTS);
}

// Make every snapshot request unique so neither the camera's own webserver nor
// any intermediate proxy serves a stale frame. Reolink's cmd=Snap caches by
// the `rs` query param value — regenerating it forces a fresh frame on each call.
function withCacheBust(url) {
  try {
    const u = new URL(url);
    const fresh = Math.random().toString(36).slice(2, 10);
    if (u.searchParams.has('rs')) u.searchParams.set('rs', fresh);
    u.searchParams.set('_t', Date.now().toString());
    return u.toString();
  } catch {
    return url;
  }
}

function followAndPipe(url, res, redirectsLeft) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    if (!res.headersSent) res.status(500).end('bad snapshot url');
    return;
  }
  const lib = parsed.protocol === 'https:' ? https : http;

  const headers = {
    'Cache-Control': 'no-cache, no-store',
    Pragma: 'no-cache',
  };
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
      timeout: 5000,
      rejectUnauthorized: false,
    },
    (upstream) => {
      const code = upstream.statusCode || 0;
      if (code >= 300 && code < 400 && upstream.headers.location && redirectsLeft > 0) {
        upstream.resume();
        const next = new URL(upstream.headers.location, url);
        // Preserve credentials across redirects to the same host (Reolink http→https case).
        if (parsed.username && !next.username && next.hostname === parsed.hostname) {
          next.username = parsed.username;
          next.password = parsed.password;
        }
        followAndPipe(next.toString(), res, redirectsLeft - 1);
        return;
      }
      if (code >= 400) {
        if (!res.headersSent) res.status(code).end(`upstream ${code}`);
        upstream.resume();
        return;
      }
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      upstream.pipe(res);
    }
  );
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (err) => {
    if (!res.headersSent) res.status(502).end('upstream error: ' + err.message);
  });
}
