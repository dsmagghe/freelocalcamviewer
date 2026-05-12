import http from 'node:http';
import https from 'node:https';
import { injectCreds } from './onvif-client.js';

export function proxySnapshot(camera, res) {
  const target = injectCreds(camera.snapshot_url, camera.username, camera.password);
  if (!target) {
    res.status(404).end('no snapshot url');
    return;
  }
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.status(500).end('bad snapshot url');
    return;
  }
  const lib = parsed.protocol === 'https:' ? https : http;

  const headers = {};
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
      if (upstream.statusCode && upstream.statusCode >= 400) {
        res.status(upstream.statusCode).end(`upstream ${upstream.statusCode}`);
        upstream.resume();
        return;
      }
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      upstream.pipe(res);
    }
  );
  req.on('timeout', () => {
    req.destroy(new Error('timeout'));
  });
  req.on('error', (err) => {
    if (!res.headersSent) res.status(502).end('upstream error: ' + err.message);
  });
}
