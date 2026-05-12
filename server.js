#!/usr/bin/env node
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  openDb,
  listCameras,
  getCamera,
  insertCamera,
  updateCamera,
  deleteCamera,
  reorderCameras,
} from './lib/db.js';
import { discoverOnLan, probeCamera } from './lib/onvif-client.js';
import { proxySnapshot, forgetCamera } from './lib/snapshot-proxy.js';
import { scanLan } from './lib/lan-scan.js';
import { VENDOR_LABELS, suggestUrls } from './lib/vendors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8088);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cameras.db');

const db = openDb(DB_PATH);
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    // Static UI is small and changes between releases — don't let browsers
    // serve stale versions when we ship fixes.
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    },
  })
);

function publicView(cam) {
  if (!cam) return null;
  return {
    id: cam.id,
    name: cam.name,
    host: cam.host,
    port: cam.port,
    enabled: !!cam.enabled,
    sort_order: cam.sort_order,
    poll_ms: cam.poll_ms,
    vendor: cam.vendor || null,
    has_credentials: !!cam.username,
    has_rtsp: !!cam.rtsp_url,
    has_snapshot: !!cam.snapshot_url,
    rtsp_url: cam.rtsp_url ? cam.rtsp_url.replace(/(rtsp:\/\/)[^@]+@/, '$1***@') : null,
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/cameras', (_req, res) => {
  res.json(listCameras(db).map(publicView));
});

// Most recently saved credentials, used to pre-fill the Add form and as the
// default for batch-add. Returning the actual password is intentional — this
// app is LAN-only and the DB already stores credentials in plain text.
app.get('/api/settings/default-credentials', (_req, res) => {
  const row = db.prepare(`
    SELECT username, password FROM cameras
    WHERE username IS NOT NULL AND username != ''
    ORDER BY id DESC LIMIT 1
  `).get();
  res.json({ username: row?.username || '', password: row?.password || '' });
});

// Bulk-create cameras using one shared credential set + vendor URL templates.
// Each item is {host, port?, vendor?, name?} — credentials apply to all.
app.post('/api/cameras/batch', (req, res) => {
  const { items, username, password, poll_ms } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  const existing = new Set(listCameras(db).map((c) => c.host));
  const created = [];
  const skipped = [];
  for (const item of items) {
    if (!item.host || existing.has(item.host)) {
      skipped.push({ host: item.host, reason: existing.has(item.host) ? 'already exists' : 'missing host' });
      continue;
    }
    const urls = item.vendor
      ? suggestUrls(item.vendor, { host: item.host, username: username || '', password: password || '' })
      : null;
    const cam = insertCamera(db, {
      name: item.name || (item.vendor ? `${VENDOR_LABELS[item.vendor] || item.vendor} ${item.host}` : item.host),
      host: item.host,
      port: item.port ? Number(item.port) : 80,
      username: username || null,
      password: password || null,
      rtsp_url: urls?.rtsp_main || null,
      snapshot_url: urls?.snapshot || null,
      poll_ms: poll_ms ? Number(poll_ms) : 400,
      vendor: item.vendor || null,
    });
    existing.add(cam.host);
    created.push(publicView(cam));
  }
  res.json({ created, skipped });
});

app.post('/api/cameras', (req, res) => {
  const { name, host, port, username, password, rtsp_url, snapshot_url, poll_ms, vendor } = req.body || {};
  if (!name || !host) return res.status(400).json({ error: 'name and host are required' });
  const cam = insertCamera(db, {
    name,
    host,
    port: port ? Number(port) : 80,
    username: username || null,
    password: password || null,
    rtsp_url: rtsp_url || null,
    snapshot_url: snapshot_url || null,
    poll_ms: poll_ms ? Number(poll_ms) : 400,
    vendor: vendor || null,
  });
  res.status(201).json(publicView(cam));
});

app.patch('/api/cameras/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = getCamera(db, id);
  const patch = {};
  for (const k of ['name', 'host', 'port', 'username', 'password', 'rtsp_url', 'snapshot_url', 'enabled', 'poll_ms', 'vendor']) {
    if (k in req.body) patch[k] = req.body[k];
  }
  // When the user sets / changes a vendor and didn't supply their own URLs,
  // fill them in from the vendor template. This makes "I just learned this
  // is a Reolink doorbell, please configure it" a one-field action.
  if (patch.vendor && patch.vendor !== before?.vendor) {
    const merged = { ...before, ...patch };
    const urls = suggestUrls(patch.vendor, {
      host: merged.host,
      username: merged.username || '',
      password: merged.password || '',
    });
    if (urls) {
      if (!('rtsp_url' in req.body) || !req.body.rtsp_url) patch.rtsp_url = urls.rtsp_main;
      if (!('snapshot_url' in req.body) || !req.body.snapshot_url) patch.snapshot_url = urls.snapshot;
    }
  }
  const cam = updateCamera(db, id, patch);
  if (!cam) return res.status(404).json({ error: 'not found' });
  forgetCamera(id, before?.host);
  res.json(publicView(cam));
});

app.delete('/api/cameras/:id', (req, res) => {
  const cam = getCamera(db, Number(req.params.id));
  const ok = deleteCamera(db, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'not found' });
  if (cam) forgetCamera(cam.id, cam.host);
  res.status(204).end();
});

app.post('/api/cameras/reorder', (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of ids' });
  reorderCameras(db, order.map(Number));
  res.json({ ok: true });
});

app.post('/api/discover', async (req, res) => {
  const timeoutMs = Number(req.body?.timeoutMs || 5000);
  try {
    const devices = await discoverOnLan({ timeoutMs });
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Combined scan: ONVIF WS-Discovery + TCP-probe of local /24 + ARP/OUI lookup.
// Runs both in parallel and merges results by IP so users see one unified list.
app.post('/api/scan', async (req, res) => {
  const onvifTimeoutMs = Number(req.body?.onvifTimeoutMs || 4000);
  const tcpTimeoutMs   = Number(req.body?.tcpTimeoutMs   || 600);

  const [onvifResult, lanResult] = await Promise.allSettled([
    discoverOnLan({ timeoutMs: onvifTimeoutMs }),
    scanLan({ timeoutMs: tcpTimeoutMs }),
  ]);

  const byIp = new Map();
  if (lanResult.status === 'fulfilled') {
    for (const h of lanResult.value) {
      byIp.set(h.ip, {
        host: h.ip,
        port: pickHttpPort(h.open_ports),
        open_ports: h.open_ports,
        mac: h.mac || null,
        vendor: h.vendor || null,
        vendor_label: h.vendor ? VENDOR_LABELS[h.vendor] || h.vendor : null,
        likely_camera: !!h.likely_camera,
        source: 'lan-scan',
        name: null,
        hardware: null,
      });
    }
  }
  if (onvifResult.status === 'fulfilled') {
    for (const d of onvifResult.value) {
      const existing = byIp.get(d.host);
      const merged = {
        ...(existing || {}),
        host: d.host,
        port: d.port || existing?.port || 80,
        name: d.name || existing?.name || null,
        hardware: d.hardware || existing?.hardware || null,
        onvif: true,
        likely_camera: true,
        source: existing ? 'lan-scan+onvif' : 'onvif',
      };
      byIp.set(d.host, merged);
    }
  }

  res.json({
    devices: [...byIp.values()],
    onvif_error: onvifResult.status === 'rejected' ? onvifResult.reason?.message : null,
    lan_error:   lanResult.status   === 'rejected' ? lanResult.reason?.message   : null,
  });
});

function pickHttpPort(open) {
  if (!open?.length) return 80;
  for (const p of [80, 8080, 8000, 443, 8443]) if (open.includes(p)) return p;
  return open[0];
}

// Returns suggested RTSP/snapshot URLs for a known vendor — used by the frontend
// to pre-fill the add-camera form once the user types their credentials.
app.post('/api/vendor-template', (req, res) => {
  const { vendor, host, username, password } = req.body || {};
  if (!vendor || !host) return res.status(400).json({ error: 'vendor and host required' });
  const urls = suggestUrls(vendor, { host, username: username || '', password: password || '' });
  if (!urls) return res.status(404).json({ error: 'unknown vendor' });
  res.json(urls);
});

app.post('/api/probe', async (req, res) => {
  const { host, port, username, password } = req.body || {};
  if (!host) return res.status(400).json({ error: 'host required' });
  try {
    const info = await probeCamera({
      host,
      port: port ? Number(port) : 80,
      username: username || null,
      password: password || null,
    });
    res.json(info);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/cameras/:id/snapshot', (req, res) => {
  const cam = getCamera(db, Number(req.params.id));
  if (!cam || !cam.enabled) return res.status(404).end();
  proxySnapshot(cam, res);
});

app.listen(PORT, HOST, () => {
  console.log(`FreeLocalCamViewer listening on http://${HOST}:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
