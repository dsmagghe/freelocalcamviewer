// OUI lookup + per-vendor URL templates. Keep this list deliberate, not encyclopedic —
// we only care about MAC prefixes for IP cameras and NVRs commonly found on home LANs.
const OUIS = {
  'ec:71:db': 'reolink',
  'b0:4a:6a': 'reolink',
  '94:e1:ac': 'reolink',
  '28:57:be': 'hikvision',
  '4c:bd:8f': 'hikvision',
  '44:19:b6': 'hikvision',
  'c0:51:7e': 'hikvision',
  'f8:4d:fc': 'hikvision',
  'bc:51:fe': 'dahua',
  '38:af:29': 'dahua',
  '3c:ef:8c': 'dahua',
  'a0:bd:1d': 'dahua',
  '00:62:6e': 'amcrest',
  '9c:8e:cd': 'amcrest',
  '00:1b:a9': 'axis',
  'ac:cc:8e': 'axis',
  'b8:a4:4f': 'axis',
  '00:80:f0': 'panasonic',
  '00:12:5f': 'tplink',
  'cc:32:e5': 'tplink',
  'a0:e4:53': 'ezviz',
  '24:7f:20': 'ezviz',
};

export function vendorFromMac(mac) {
  if (!mac) return null;
  const oui = mac.slice(0, 8).toLowerCase();
  return OUIS[oui] || null;
}

export const VENDOR_LABELS = {
  reolink: 'Reolink',
  hikvision: 'Hikvision',
  dahua: 'Dahua',
  amcrest: 'Amcrest',
  axis: 'Axis',
  panasonic: 'Panasonic',
  tplink: 'TP-Link',
  ezviz: 'EZVIZ',
};

// Templates take {host, username, password} and return URLs.
// User is responsible for filling in credentials (we keep them out of the discovery payload).
export const TEMPLATES = {
  reolink: {
    rtsp_main: ({ host, username = '', password = '' }) => buildRtsp(host, 554, `h264Preview_01_main`, username, password),
    rtsp_sub:  ({ host, username = '', password = '' }) => buildRtsp(host, 554, `h264Preview_01_sub`,  username, password),
    snapshot:  ({ host, username = '', password = '' }) => {
      const u = new URL(`https://${host}/cgi-bin/api.cgi`);
      u.searchParams.set('cmd', 'Snap');
      u.searchParams.set('channel', '0');
      u.searchParams.set('rs', Math.random().toString(36).slice(2, 10));
      if (username) {
        u.searchParams.set('user', username);
        u.searchParams.set('password', password);
      }
      return u.toString();
    },
  },
  hikvision: {
    rtsp_main: ({ host, username = '', password = '' }) => buildRtsp(host, 554, 'Streaming/Channels/101', username, password),
    rtsp_sub:  ({ host, username = '', password = '' }) => buildRtsp(host, 554, 'Streaming/Channels/102', username, password),
    snapshot:  ({ host, username = '', password = '' }) => `http://${host}/ISAPI/Streaming/channels/101/picture`,
  },
  dahua: {
    rtsp_main: ({ host, username = '', password = '' }) => buildRtsp(host, 554, 'cam/realmonitor?channel=1&subtype=0', username, password),
    rtsp_sub:  ({ host, username = '', password = '' }) => buildRtsp(host, 554, 'cam/realmonitor?channel=1&subtype=1', username, password),
    snapshot:  ({ host })                                => `http://${host}/cgi-bin/snapshot.cgi?channel=1`,
  },
  amcrest: {
    rtsp_main: ({ host, username = '', password = '' }) => buildRtsp(host, 554, 'cam/realmonitor?channel=1&subtype=0', username, password),
    snapshot:  ({ host })                                => `http://${host}/cgi-bin/snapshot.cgi?channel=1`,
  },
  axis: {
    rtsp_main: ({ host, username = '', password = '' }) => buildRtsp(host, 554, 'axis-media/media.amp', username, password),
    snapshot:  ({ host })                                => `http://${host}/axis-cgi/jpg/image.cgi`,
  },
};

function buildRtsp(host, port, path, username, password) {
  const creds = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';
  return `rtsp://${creds}${host}:${port}/${path}`;
}

export function suggestUrls(vendor, params) {
  const t = TEMPLATES[vendor];
  if (!t) return null;
  const out = {};
  for (const [k, fn] of Object.entries(t)) {
    try { out[k] = fn(params); } catch { /* skip */ }
  }
  return out;
}
