# FreeLocalCamViewer

A tiny, self-hosted dashboard for watching many local IP cameras at once.
Designed to run on a Raspberry Pi (or any small Linux box) on your LAN.

- Auto-discovers ONVIF cameras on the local network (WS-Discovery)
- Adds them with one click, or manually by IP
- Pulls RTSP and snapshot URLs automatically via ONVIF
- Renders 10, 15, 20+ cameras in a browser grid via MJPEG snapshot polling
  (so the Pi doesn't have to transcode anything)
- Remembers names, sort order, layout, columns — persisted in SQLite
- Drag-and-drop reordering
- No cloud, no account, no telemetry. MIT licensed.

> **Why snapshot polling instead of real-time video?**
> A Raspberry Pi cannot reasonably transcode 10+ RTSP streams to HLS.
> Snapshot polling (typically 2–4 fps) gives you a smooth, near-live grid
> for monitoring without any transcoding load.
> For true sub-second video on a beefier machine, point a separate
> [go2rtc](https://github.com/AlexxIT/go2rtc) instance at the same cameras —
> the two tools cooperate well.

## Quick start

### With Docker (recommended)

```bash
git clone https://github.com/<you>/freelocalcamviewer.git
cd freelocalcamviewer
docker compose up -d
```

Open <http://your-pi.local:8088>.

> The compose file uses `network_mode: host` so the container can send the
> ONVIF multicast probe. On non-Linux Docker hosts you can still run it,
> but you'll need to add cameras manually.

### Without Docker

Requirements: Node.js 18+ and a C toolchain for `better-sqlite3`.
Optional but recommended: `ffmpeg` (enables RTSP-grab fallback when a
camera's HTTP API session pool is saturated).

```bash
git clone https://github.com/<you>/freelocalcamviewer.git
cd freelocalcamviewer
npm install
node server.js
```

### Auto-start on macOS (LaunchAgent)

```bash
brew install node ffmpeg     # if not already installed
git clone https://github.com/<you>/freelocalcamviewer.git
cd freelocalcamviewer
npm install
scripts/install-mac.sh 8088  # port is optional, defaults to 8088
```

The app now boots with your user session, restarts on crash, and writes
logs to `data/launchd.{out,err}.log`. Re-run the installer with a
different port number to change ports. Remove with `scripts/uninstall-mac.sh`.

On a Raspberry Pi running Debian/Ubuntu:

```bash
sudo apt install -y nodejs npm build-essential
sudo mkdir -p /opt/freelocalcamviewer
sudo chown -R $USER /opt/freelocalcamviewer
git clone https://github.com/<you>/freelocalcamviewer.git /opt/freelocalcamviewer
cd /opt/freelocalcamviewer
npm install
sudo cp scripts/freelocalcamviewer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freelocalcamviewer
```

## Configuration

Environment variables:

| Name      | Default                       | Purpose                       |
|-----------|-------------------------------|-------------------------------|
| `PORT`    | `8088`                        | HTTP port                     |
| `HOST`    | `0.0.0.0`                     | Bind address                  |
| `DB_PATH` | `./data/cameras.db`           | SQLite database file          |

## How it works

```
┌────────────────────┐     ONVIF (SOAP)     ┌──────────────┐
│  FreeLocalCamViewer├─────────────────────▶│  IP camera   │
│  Node.js + Express │◀────RTSP / JPEG─────│ (ONVIF, RTSP)│
└────────┬───────────┘                      └──────────────┘
         │ HTTP + MJPEG poll
         ▼
   ┌──────────┐
   │ Browser  │
   └──────────┘
```

- ONVIF WS-Discovery sends a UDP multicast probe to `239.255.255.250:3702`.
  Compatible cameras reply with their service URL.
- For each camera we call `GetStreamUri` (RTSP) and `GetSnapshotUri` (JPEG).
- The server proxies snapshot requests so the browser never sees camera
  credentials.
- The browser polls `/api/cameras/:id/snapshot?t=<ts>` for each tile.

## API

| Method   | Path                              | Body / notes                              |
|----------|-----------------------------------|-------------------------------------------|
| `GET`    | `/api/cameras`                    | List cameras                              |
| `POST`   | `/api/cameras`                    | `{name, host, port?, username?, ...}`     |
| `PATCH`  | `/api/cameras/:id`                | Partial update                            |
| `DELETE` | `/api/cameras/:id`                | Remove camera                             |
| `POST`   | `/api/cameras/reorder`            | `{order: [id, id, …]}`                    |
| `POST`   | `/api/discover`                   | `{timeoutMs?: number}` → `[{host, port}]` |
| `POST`   | `/api/probe`                      | `{host, port?, username?, password?}`     |
| `GET`    | `/api/cameras/:id/snapshot`       | Proxied JPEG                              |

## Security

This is intended for **trusted LAN use only**. There is no built-in auth.
If you want to expose it to the internet, put it behind a reverse proxy
with HTTP basic auth, a VPN, or Tailscale.

Camera credentials are stored in plain text in the SQLite DB. Treat the
DB file as a secret.

## Roadmap / ideas

- [ ] Optional Basic Auth login
- [ ] PTZ controls (ONVIF Profile S)
- [ ] Motion-triggered fullscreen takeover
- [ ] Optional WebRTC passthrough via embedded go2rtc
- [ ] Multi-layout presets

## License

MIT — see [LICENSE](LICENSE).
