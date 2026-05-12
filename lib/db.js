import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      host         TEXT    NOT NULL,
      port         INTEGER NOT NULL DEFAULT 80,
      username     TEXT,
      password     TEXT,
      rtsp_url     TEXT,
      snapshot_url TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      poll_ms      INTEGER NOT NULL DEFAULT 400,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cameras_sort ON cameras(sort_order);
  `);
  // Schema migrations: ALTER TABLE ADD COLUMN is the safest way to extend an
  // existing DB without breaking installs that pre-date the new columns.
  for (const stmt of [
    "ALTER TABLE cameras ADD COLUMN vendor TEXT",
  ]) {
    try { db.exec(stmt); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  return db;
}

export function listCameras(db) {
  return db.prepare('SELECT * FROM cameras ORDER BY sort_order ASC, id ASC').all();
}

export function getCamera(db, id) {
  return db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
}

export function insertCamera(db, cam) {
  const stmt = db.prepare(`
    INSERT INTO cameras (name, host, port, username, password, rtsp_url, snapshot_url, enabled, sort_order, poll_ms, vendor)
    VALUES (@name, @host, @port, @username, @password, @rtsp_url, @snapshot_url, @enabled, @sort_order, @poll_ms, @vendor)
  `);
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM cameras').get().m;
  const row = {
    name: cam.name,
    host: cam.host,
    port: cam.port ?? 80,
    username: cam.username ?? null,
    password: cam.password ?? null,
    rtsp_url: cam.rtsp_url ?? null,
    snapshot_url: cam.snapshot_url ?? null,
    enabled: cam.enabled === false ? 0 : 1,
    sort_order: cam.sort_order ?? max + 1,
    poll_ms: cam.poll_ms ?? 400,
    vendor: cam.vendor ?? null,
  };
  const info = stmt.run(row);
  return getCamera(db, info.lastInsertRowid);
}

export function updateCamera(db, id, patch) {
  const cur = getCamera(db, id);
  if (!cur) return null;
  const merged = { ...cur, ...patch };
  if ('enabled' in patch) merged.enabled = patch.enabled ? 1 : 0;
  db.prepare(`
    UPDATE cameras SET
      name = @name, host = @host, port = @port,
      username = @username, password = @password,
      rtsp_url = @rtsp_url, snapshot_url = @snapshot_url,
      enabled = @enabled, sort_order = @sort_order, poll_ms = @poll_ms,
      vendor = @vendor
    WHERE id = @id
  `).run({ ...merged, id });
  return getCamera(db, id);
}

export function deleteCamera(db, id) {
  return db.prepare('DELETE FROM cameras WHERE id = ?').run(id).changes > 0;
}

export function reorderCameras(db, orderedIds) {
  const stmt = db.prepare('UPDATE cameras SET sort_order = ? WHERE id = ?');
  const tx = db.transaction((ids) => {
    ids.forEach((id, idx) => stmt.run(idx, id));
  });
  tx(orderedIds);
}
