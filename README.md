# FreeLocalCamViewer

A tiny, self-hosted dashboard for watching many local IP cameras at once.
Designed to run on a Raspberry Pi, a Mac, or any small Linux box on your LAN.

- Auto-discovers ONVIF cameras on the local network (WS-Discovery)
- TCP/ARP/OUI scan + active HTTP fingerprinting catches cameras that
  don't speak WS-Discovery (Reolink, including doorbells)
- Pulls RTSP and snapshot URLs automatically once you pick a vendor
- Multi-select "Add all" with one shared credential entry
- Renders 10, 15, 20+ cameras in a browser grid
- Custom layouts: equal grids, "1 large + grid", "Cinema", …
- Inline rename, drag-and-drop reorder, per-camera poll rate
- Double-click any tile for a fullscreen zoom view
- Reolink token-auth + RTSP frame-grab fallback (works even when the
  HTTP API session pool is saturated by other clients)
- Remembers layout, names, sort order — persisted in SQLite
- No cloud, no account, no telemetry. MIT licensed.

---

## Table of contents

- [Install on macOS (auto-start)](#install-on-macos-auto-start)
- [Install on Raspberry Pi / Linux](#install-on-raspberry-pi--linux)
- [Install with Docker](#install-with-docker)
- [First run: adding cameras](#first-run-adding-cameras)
- [Configuration](#configuration)
- [Security & credentials](#security--credentials)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [API reference](#api-reference)
- [How snapshots work](#how-snapshots-work)

---

## Install on macOS (auto-start)

```bash
# Prerequisites
brew install node ffmpeg

# Clone + install
git clone https://github.com/dsmagghe/freelocalcamviewer.git
cd freelocalcamviewer
npm install

# Register as a LaunchAgent — boots with the user session,
# restarts on crash. Port argument is optional (defaults to 8088).
scripts/install-mac.sh 8088
```

Open <http://localhost:8088>.

**What this does:**
- Writes `~/Library/LaunchAgents/be.openview.freelocalcamviewer.plist`
- Loads it with `launchctl` so the app starts on every login
- Logs to `data/launchd.out.log` and `data/launchd.err.log`

**Change the port:** re-run the installer with a new port argument.
```bash
scripts/install-mac.sh 9099
```

**Uninstall:**
```bash
scripts/uninstall-mac.sh
```

`ffmpeg` is technically optional but strongly recommended — it enables
the RTSP-grab fallback that keeps snapshots working when a camera's
HTTP API sessions are all taken by other clients (the Reolink app,
an NVR, …).

---

## Install on Raspberry Pi / Linux

```bash
sudo apt update
sudo apt install -y nodejs npm build-essential ffmpeg
sudo mkdir -p /opt/freelocalcamviewer
sudo chown -R "$USER" /opt/freelocalcamviewer

git clone https://github.com/dsmagghe/freelocalcamviewer.git /opt/freelocalcamviewer
cd /opt/freelocalcamviewer
npm install

sudo cp scripts/freelocalcamviewer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freelocalcamviewer
```

Open `http://<pi-ip>:8088`.

**Tail logs:** `sudo journalctl -u freelocalcamviewer -f`
**Restart:** `sudo systemctl restart freelocalcamviewer`
**Change port:** edit `Environment=PORT=...` in the unit file and `sudo systemctl daemon-reload && sudo systemctl restart freelocalcamviewer`

On a Pi 4 the grid handles ~15–20 cameras at the default 400 ms poll
without trouble. If you push past that, raise `poll_ms` per camera
(2000 ms is a comfortable monitoring rate).

---

## Install with Docker

```bash
git clone https://github.com/dsmagghe/freelocalcamviewer.git
cd freelocalcamviewer
docker compose up -d
```

The compose file uses `network_mode: host` so the container can send
the ONVIF WS-Discovery multicast probe and reach LAN cameras directly.
On Linux this works out of the box; on Docker Desktop (Mac/Windows)
host networking is limited — auto-discovery may not return results,
but you can still add cameras manually with their IP.

The DB is mounted from `./data/` so your camera list survives container
rebuilds.

---

## First run: adding cameras

1. Open the app, click **Scan LAN**.
2. The scan combines three methods:
   - ONVIF WS-Discovery (multicast, ~5 s)
   - TCP probe of every IP in your `/24` on common camera ports
   - ARP + OUI lookup, plus an active HTTP probe of unknown-vendor hosts
3. Click **Select all** in the scan modal, then **Add selected**.
4. Enter your camera username and password — once. They are reused for
   every selected camera.
5. The vendor template fills in RTSP + snapshot URLs automatically;
   tiles light up within a few seconds.

For cameras already in the list that you want to rename: click the
name in the tile, type a new name, press Enter. Done.

For grid layout: pick from the **Layout** dropdown (equal grids
1–6 columns, or featured layouts where the first N tiles are bigger).
Reorder which camera gets the big slot with **Edit layout** + drag.

---

## Configuration

All settings are environment variables:

| Variable  | Default               | Purpose                                  |
|-----------|-----------------------|------------------------------------------|
| `PORT`    | `8088`                | HTTP port                                |
| `HOST`    | `0.0.0.0`             | Bind address (`127.0.0.1` for local-only)|
| `DB_PATH` | `./data/cameras.db`   | SQLite database file                     |

The LaunchAgent and systemd unit both set these — edit the unit file
or re-run the installer to change them.

Per-camera settings live in the DB:
- `name`, `host`, `port`, `username`, `password`
- `rtsp_url`, `snapshot_url`
- `vendor` (drives the auth strategy)
- `enabled` (Pause/Play button on each tile)
- `sort_order` (drag-and-drop)
- `poll_ms` (per-camera refresh rate, default 400 ms)

---

## Security & credentials

> This app is intended for **trusted LAN use only**. There is **no
> built-in authentication**. Anyone on your LAN who can reach the port
> can see every camera.

**What is stored where:**
- Camera credentials are kept in plain text in `data/cameras.db`.
- The `data/` directory is in `.gitignore` so accidental
  `git add -A` does not push your password to a public repo.
- Logs (`*.log`, `launchd.*.log`) are also gitignored, because Node
  occasionally prints an URL with credentials on error.

**To expose it beyond the LAN, do not just port-forward.** Use one of:
- Tailscale or another mesh VPN
- A reverse proxy with HTTP Basic Auth in front (Caddy, nginx)
- An SSH tunnel from the client device

**Treat `data/cameras.db` as a secret file.** Back it up encrypted,
chmod it 600, don't share it.

---

## Updating

```bash
cd /opt/freelocalcamviewer   # or wherever you cloned it
git pull
npm install                  # in case dependencies changed
# macOS LaunchAgent:
launchctl unload ~/Library/LaunchAgents/be.openview.freelocalcamviewer.plist
launchctl load   ~/Library/LaunchAgents/be.openview.freelocalcamviewer.plist
# systemd:
sudo systemctl restart freelocalcamviewer
# Docker:
docker compose up -d --build
```

Schema migrations are additive and run automatically on boot.

---

## Troubleshooting

### Scan finds nothing
- If you're connected to a VPN, the multicast probe is likely going
  out the tunnel. Disconnect the VPN, scan again.
- The TCP-probe step works regardless of VPN, so you should still see
  raw hosts. If even that finds nothing, check that you're on the same
  Wi-Fi as your cameras.

### A tile shows "× failed"
The stamp text shows the actual upstream error. Common ones:

| Error                              | Meaning                                                |
|------------------------------------|--------------------------------------------------------|
| `please login first` / `rspCode -6`| Token-auth failed or expired. Backs off, retries.      |
| `max session` / `rspCode -5`       | The camera's HTTP API session pool is full of other clients. RTSP-grab via ffmpeg kicks in as fallback. |
| `auth_warning_info` / `remain_time`| Account is temporarily locked after wrong passwords. Wait or power-cycle the camera. |
| `Connection refused`               | Camera is offline or in defensive lockout. Power-cycle. |
| `password wrong`                   | The credentials on this camera really are different. Click Edit to fix.    |

### Snapshot is slow (5–7 s per frame)
That's the RTSP-grab fallback. Raise the camera's `poll_ms` to
something more relaxed (e.g. 2000 ms) — or fix whichever client is
holding all the HTTP sessions and the faster reolink-token path will
take over again.

### ONVIF camera but unknown vendor
Open **Edit** on the camera, set Vendor to `reolink` / `hikvision` /
`dahua` / etc. — the server fills in RTSP + snapshot URL from the
template automatically when vendor changes.

---

## API reference

| Method   | Path                              | Notes                                     |
|----------|-----------------------------------|-------------------------------------------|
| `GET`    | `/api/cameras`                    | List                                      |
| `POST`   | `/api/cameras`                    | Create one                                |
| `PATCH`  | `/api/cameras/:id`                | Partial update; changing `vendor` re-fills URLs |
| `DELETE` | `/api/cameras/:id`                | Remove                                    |
| `POST`   | `/api/cameras/batch`              | Multi-create with one shared credential set |
| `POST`   | `/api/cameras/reorder`            | `{order: [id, id, …]}`                    |
| `POST`   | `/api/scan`                       | Combined ONVIF + TCP + ARP/OUI + HTTP probe |
| `POST`   | `/api/discover`                   | ONVIF WS-Discovery only (legacy)          |
| `POST`   | `/api/probe`                      | ONVIF probe a known IP                    |
| `POST`   | `/api/vendor-template`            | Return suggested URLs for a vendor + host |
| `GET`    | `/api/cameras/:id/snapshot`       | Proxied JPEG (or 502 with JSON attempt log)|
| `GET`    | `/api/settings/default-credentials`| Returns the most-recent username/password |

---

## How snapshots work

Each tile polls `/api/cameras/:id/snapshot`. Under the hood the proxy
walks a method ladder until one succeeds:

```
reolink-token  ─┐
url-creds      ─┴── http-api auth class  (uses camera's HTTP session pool)
rtsp-grab      ──── rtsp auth class      (uses ffmpeg, separate pool)
```

The winning method is cached per camera so subsequent polls go
straight to it. Failures are tracked per auth-class — so when the
HTTP API is rate-limited, RTSP-grab still runs.

```
┌────────────────────┐   ONVIF / api.cgi / RTSP   ┌──────────────┐
│  FreeLocalCamViewer├────────────────────────────▶│  IP camera   │
│  Node.js + Express │◀───── JPEG / H264 ─────────│              │
└────────┬───────────┘                             └──────────────┘
         │ HTTP poll (no transcoding)
         ▼
   ┌──────────┐
   │ Browser  │
   └──────────┘
```

---

## License

MIT — see [LICENSE](LICENSE).
