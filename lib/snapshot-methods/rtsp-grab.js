import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// Reolink (and most ONVIF cameras) keep two separate session pools: one for the
// HTTP API and one for RTSP. When the HTTP pool is saturated by other clients
// (the Reolink app, an NVR, the desktop client), our snapshot calls get
// "max session" forever — but RTSP often still has open slots. This method
// asks ffmpeg to connect to RTSP, decode one frame, encode it as JPEG, exit.
//
// Tradeoff vs HTTP snapshot:
//   - Slower (~1-3s first frame, depending on the camera's GOP)
//   - Heavier (spawns a process per call)
//   + Works when HTTP sessions are saturated
//   + Works when the HTTP API password is locked-out but RTSP creds are fine

let ffmpegPathCache = null;
function findFfmpeg() {
  if (ffmpegPathCache !== null) return ffmpegPathCache;
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']) {
    if (p === 'ffmpeg' || existsSync(p)) { ffmpegPathCache = p; return p; }
  }
  ffmpegPathCache = null;
  return null;
}

export function isAvailable() {
  return !!findFfmpeg();
}

export function rtspGrab(camera, res) {
  return new Promise((resolve, reject) => {
    const bin = findFfmpeg();
    if (!bin) return reject(new Error('ffmpeg not installed'));
    if (!camera.rtsp_url) return reject(new Error('no rtsp_url'));

    // Prefer the sub-stream for speed if the camera looks like Reolink — it
    // has a much shorter GOP so we get to a keyframe ~3× faster.
    const url = preferSubStream(camera.rtsp_url);

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', url,
      '-frames:v', '1',
      '-q:v', '5',
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ];

    const ff = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks = [];
    let stderrBuf = '';
    let resolved = false;
    const finish = (err) => {
      if (resolved) return;
      resolved = true;
      try { ff.kill('SIGKILL'); } catch {}
      if (err) reject(err);
    };

    const killTimer = setTimeout(() => finish(new Error('rtsp-grab timeout (12s)')), 12000);

    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { stderrBuf += c.toString(); });
    ff.on('error', (err) => finish(new Error('ffmpeg spawn: ' + err.message)));
    ff.on('close', (code) => {
      clearTimeout(killTimer);
      if (resolved) return;
      if (code !== 0) {
        resolved = true;
        return reject(new Error(`ffmpeg exit ${code}: ${stderrBuf.slice(0, 200).trim() || 'no stderr'}`));
      }
      const buf = Buffer.concat(chunks);
      // Sanity-check JPEG signature so we never send broken bytes to the client.
      if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) {
        resolved = true;
        return reject(new Error('ffmpeg produced ' + buf.length + ' bytes, not a JPEG'));
      }
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
      resolved = true;
      resolve();
    });
  });
}

function preferSubStream(rtspUrl) {
  // Reolink pattern is `h264Preview_01_main` → `h264Preview_01_sub`.
  return rtspUrl.replace(/h264Preview_(\d+)_main/, 'h264Preview_$1_sub');
}
