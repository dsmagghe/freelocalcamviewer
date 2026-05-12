import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { vendorFromMac } from './vendors.js';
import { detectVendor } from './vendor-probe.js';

const execFileP = promisify(execFile);

// Network interfaces to skip — VPN tunnels, loopback, link-local, virtual.
const SKIP_IF = /^(utun|tun|tap|lo|awdl|llw|bridge|anpi|ap\d|gif|stf|vboxnet|docker|veth)/i;

const CAMERA_PORTS = [80, 443, 554, 8000, 8080, 8443, 9000];

export function localSubnets() {
  const ifs = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifs)) {
    if (SKIP_IF.test(name)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // RFC1918 only — public IPs should never be scanned.
      const ip = addr.address;
      if (!(ip.startsWith('192.168.') || ip.startsWith('10.') ||
            /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip))) continue;
      const [a, b, c] = ip.split('.');
      const base = `${a}.${b}.${c}`;
      if (out.some((s) => s.base === base)) continue;
      out.push({ name, ip, base });
    }
  }
  return out;
}

function tcpProbe(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, ip);
  });
}

async function probeHost(ip, timeoutMs) {
  // First port to respond marks the host as alive. We also record which ports are open.
  const open = [];
  await Promise.all(
    CAMERA_PORTS.map(async (p) => {
      if (await tcpProbe(ip, p, timeoutMs)) open.push(p);
    })
  );
  return open;
}

async function readArp() {
  // macOS, Linux, BSD all support `arp -an`. We don't fail the scan if it's unavailable.
  try {
    const { stdout } = await execFileP('arp', ['-an'], { timeout: 3000 });
    const map = new Map();
    for (const line of stdout.split('\n')) {
      const m = line.match(/\(([\d.]+)\)\s+at\s+([0-9a-f:]+)/i);
      if (!m) continue;
      const ip = m[1];
      const macRaw = m[2];
      if (macRaw === '(incomplete)' || !macRaw.includes(':')) continue;
      const mac = macRaw
        .split(':')
        .map((b) => b.padStart(2, '0'))
        .join(':')
        .toLowerCase();
      map.set(ip, mac);
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function scanLan({ timeoutMs = 600, includeArp = true } = {}) {
  const subnets = localSubnets();
  const found = new Map();

  await Promise.all(
    subnets.flatMap((sub) =>
      Array.from({ length: 254 }, (_, i) => {
        const ip = `${sub.base}.${i + 1}`;
        if (ip === sub.ip) return null;
        return probeHost(ip, timeoutMs).then((open) => {
          if (open.length) found.set(ip, { ip, open_ports: open, interface: sub.name });
        });
      }).filter(Boolean)
    )
  );

  if (includeArp) {
    const arp = await readArp();
    for (const host of found.values()) {
      const mac = arp.get(host.ip);
      if (mac) {
        host.mac = mac;
        host.vendor = vendorFromMac(mac);
      }
    }
  }

  // A device is "likely a camera" if we recognise the vendor OUI OR if it has the
  // typical RTSP/Baichuan ports open. This is heuristic but cheap — frontend uses
  // it to default-hide routers, phones, laptops etc.
  for (const host of found.values()) {
    host.likely_camera = !!host.vendor
      || host.open_ports.includes(554)
      || host.open_ports.includes(9000);
  }

  // Active fingerprinting: hosts that look like cameras but have no OUI match
  // get an HTTP probe. Catches Reolink doorbells & newer hardware on OUIs we
  // don't have, and any Reolink camera the user moved between LANs.
  const probeTargets = [...found.values()].filter(
    (h) => !h.vendor && h.likely_camera
  );
  await Promise.all(
    probeTargets.map(async (h) => {
      const vendor = await detectVendor(h.ip, h.open_ports);
      if (vendor) h.vendor = vendor;
    })
  );

  return [...found.values()].sort((a, b) => {
    if (a.likely_camera !== b.likely_camera) return a.likely_camera ? -1 : 1;
    return ipNum(a.ip) - ipNum(b.ip);
  });
}

function ipNum(ip) {
  return ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
}
