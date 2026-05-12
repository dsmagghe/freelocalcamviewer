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
import { proxySnapshot } from './lib/snapshot-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8088);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'cameras.db');

const db = openDb(DB_PATH);
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

app.post('/api/cameras', (req, res) => {
  const { name, host, port, username, password, rtsp_url, snapshot_url, poll_ms } = req.body || {};
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
  });
  res.status(201).json(publicView(cam));
});

app.patch('/api/cameras/:id', (req, res) => {
  const id = Number(req.params.id);
  const patch = {};
  for (const k of ['name', 'host', 'port', 'username', 'password', 'rtsp_url', 'snapshot_url', 'enabled', 'poll_ms']) {
    if (k in req.body) patch[k] = req.body[k];
  }
  const cam = updateCamera(db, id, patch);
  if (!cam) return res.status(404).json({ error: 'not found' });
  res.json(publicView(cam));
});

app.delete('/api/cameras/:id', (req, res) => {
  const ok = deleteCamera(db, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'not found' });
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
