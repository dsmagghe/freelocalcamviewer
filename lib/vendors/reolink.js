import https from 'node:https';
import http from 'node:http';

// Reolink rate-limits parallel logins per camera. With 10+ cameras polling
// snapshots every 400ms, naive per-request URL credentials quickly trigger
// "max users reached" and the camera starts dropping requests. Token-based
// auth uses a single persistent session per camera, refreshed when the lease
// is about to expire.
const tokenCache = new Map(); // host -> { token, expiresAt, refreshing? }
const TOKEN_RENEW_BUFFER_MS = 60_000;

function httpsJson({ host, port = 443, path, method = 'POST', body, timeoutMs = 6000 }) {
  return new Promise((resolve, reject) => {
    const lib = port === 80 || port === 8000 ? http : https;
    const req = lib.request(
      {
        hostname: host,
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body ? Buffer.byteLength(body) : 0,
          'Cache-Control': 'no-cache, no-store',
        },
        rejectUnauthorized: false,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`http ${res.statusCode}: ${buf.slice(0, 120)}`));
          }
          try { resolve(JSON.parse(buf)); }
          catch { reject(new Error('not JSON: ' + buf.slice(0, 120))); }
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('login timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(camera) {
  if (!camera.username) throw new Error('no credentials');
  const body = JSON.stringify([
    { cmd: 'Login', action: 0, param: { User: { userName: camera.username, password: camera.password || '' } } },
  ]);

  const json = await httpsJson({
    host: camera.host,
    port: 443,
    path: '/api.cgi?cmd=Login',
    method: 'POST',
    body,
  });

  if (!Array.isArray(json) || json[0]?.code !== 0) {
    throw new Error('login rejected: ' + JSON.stringify(json).slice(0, 160));
  }
  const tk = json[0].value?.Token;
  if (!tk?.name) throw new Error('no token in login response');
  return {
    token: tk.name,
    expiresAt: Date.now() + Math.max(60, (tk.leaseTime || 3600) - 60) * 1000,
  };
}

export async function getToken(camera) {
  const cached = tokenCache.get(camera.host);
  if (cached && cached.expiresAt > Date.now() + TOKEN_RENEW_BUFFER_MS) {
    return cached.token;
  }
  // Coalesce concurrent logins per camera so a burst of snapshot requests
  // doesn't fire 10 parallel logins (which Reolink would then rate-limit).
  if (cached?.refreshing) return cached.refreshing;
  const promise = login(camera).then(
    (fresh) => {
      tokenCache.set(camera.host, fresh);
      return fresh.token;
    },
    (err) => {
      tokenCache.delete(camera.host);
      throw err;
    }
  );
  tokenCache.set(camera.host, { ...(cached || {}), refreshing: promise });
  return promise;
}

export function invalidateToken(host) {
  tokenCache.delete(host);
}

// Returns an http.IncomingMessage streaming the JPEG, or throws.
// The caller is responsible for piping/closing it.
export function fetchSnapshot(camera) {
  return new Promise(async (resolve, reject) => {
    let token;
    try { token = await getToken(camera); }
    catch (err) { return reject(err); }

    const rs = Math.random().toString(36).slice(2, 10);
    const path = `/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=${rs}&token=${encodeURIComponent(token)}&_t=${Date.now()}`;

    const req = https.request(
      {
        hostname: camera.host,
        port: 443,
        path,
        method: 'GET',
        headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
        rejectUnauthorized: false,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`snapshot http ${res.statusCode}`));
        }
        const ct = (res.headers['content-type'] || '').toLowerCase();
        // Reolink occasionally returns 200 OK with a JSON error body when the
        // token is stale — fail fast so the caller invalidates and retries.
        if (ct.includes('json') || ct.includes('text')) {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (buf += c));
          res.on('end', () => reject(new Error('reolink JSON error: ' + buf.slice(0, 160))));
          return;
        }
        resolve(res);
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error('snapshot timeout')));
    req.on('error', reject);
    req.end();
  });
}
