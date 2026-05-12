import https from 'node:https';
import http from 'node:http';

// Active vendor fingerprinting for hosts whose MAC-OUI didn't match our table.
// Reolink for example ships some doorbells and newer cameras with OUIs we don't
// know yet — but their HTTP API is unmistakable: every request to /api.cgi
// returns a JSON array, even when unauthenticated.

export async function detectVendor(host, openPorts = []) {
  if (await detectReolink(host)) return 'reolink';
  // Hikvision/Dahua probes can be added the same way when needed.
  return null;
}

async function detectReolink(host) {
  const body = JSON.stringify([{ cmd: 'GetDevInfo', action: 0, param: {} }]);
  for (const proto of ['https', 'http']) {
    const text = await tryPost(proto, host, '/api.cgi', body).catch(() => null);
    if (text && /^\s*\[.*"cmd"/s.test(text)) return true;
  }
  return false;
}

function tryPost(proto, host, path, body) {
  return new Promise((resolve, reject) => {
    const lib = proto === 'https' ? https : http;
    const port = proto === 'https' ? 443 : 80;
    const req = lib.request(
      {
        hostname: host,
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        rejectUnauthorized: false,
      },
      (res) => {
        let buf = '';
        let bytes = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          bytes += c.length;
          // Defensive: don't accumulate huge non-JSON HTML responses.
          if (bytes > 8192) req.destroy(new Error('response too large'));
        });
        res.on('end', () => resolve(buf));
        res.on('error', reject);
      }
    );
    req.setTimeout(2500, () => req.destroy(new Error('probe timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
