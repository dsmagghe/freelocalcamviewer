import onvif from 'onvif';

const { Cam, Discovery } = onvif;

export function discoverOnLan({ timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const timer = setTimeout(() => {
      Discovery.removeAllListeners('device');
      resolve([...found.values()]);
    }, timeoutMs);

    Discovery.on('device', (cam, rinfo, xml) => {
      const key = `${cam.hostname}:${cam.port}`;
      if (found.has(key)) return;
      found.set(key, {
        host: cam.hostname,
        port: cam.port,
        urn: cam.urn,
        name: cam.name || cam.hardware || cam.hostname,
        hardware: cam.hardware || null,
        xaddrs: cam.xaddrs || [],
      });
    });

    Discovery.probe({ timeout: timeoutMs, resolve: false }, (err) => {
      if (err) {
        clearTimeout(timer);
        Discovery.removeAllListeners('device');
        resolve([...found.values()]);
      }
    });
  });
}

export function probeCamera({ host, port = 80, username, password, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const cam = new Cam(
      {
        hostname: host,
        port,
        username: username || undefined,
        password: password || undefined,
        timeout: timeoutMs,
      },
      function onConnect(err) {
        if (err) return reject(err);
        const tasks = [];
        tasks.push(
          new Promise((res) => {
            this.getStreamUri({ protocol: 'RTSP' }, (e, stream) => {
              res(e ? null : stream?.uri || null);
            });
          })
        );
        tasks.push(
          new Promise((res) => {
            this.getSnapshotUri({}, (e, snap) => {
              res(e ? null : snap?.uri || null);
            });
          })
        );
        tasks.push(
          new Promise((res) => {
            this.getDeviceInformation((e, info) => {
              res(e ? null : info || null);
            });
          })
        );
        Promise.all(tasks).then(([rtsp, snap, info]) => {
          resolve({
            rtspUrl: rtsp,
            snapshotUrl: snap,
            info,
          });
        });
      }
    );
  });
}

export function injectCreds(url, username, password) {
  if (!url) return url;
  if (!username) return url;
  try {
    const u = new URL(url);
    u.username = encodeURIComponent(username);
    if (password) u.password = encodeURIComponent(password);
    return u.toString();
  } catch {
    return url;
  }
}
