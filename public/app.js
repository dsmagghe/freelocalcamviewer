const grid = document.getElementById('grid');
const camCount = document.getElementById('cam-count');
const colsSel = document.getElementById('cols');

const state = {
  cameras: [],
  editing: false,
  timers: new Map(),
};

const COLS_KEY = 'flcv:cols';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

function setCols(n) {
  grid.className = 'grid cols-' + n;
  localStorage.setItem(COLS_KEY, String(n));
}

function startTile(cam) {
  stopTile(cam.id);
  if (!cam.enabled) return;
  const img = document.getElementById(`img-${cam.id}`);
  if (!img) return;
  const tick = () => {
    img.src = `/api/cameras/${cam.id}/snapshot?t=${Date.now()}`;
  };
  tick();
  const handle = setInterval(tick, cam.poll_ms || 400);
  state.timers.set(cam.id, handle);
}

function stopTile(id) {
  const h = state.timers.get(id);
  if (h) clearInterval(h);
  state.timers.delete(id);
}

function renderGrid() {
  for (const id of state.timers.keys()) stopTile(id);
  grid.innerHTML = '';
  state.cameras.forEach((cam) => grid.appendChild(tileEl(cam)));
  camCount.textContent = `${state.cameras.length} camera${state.cameras.length === 1 ? '' : 's'}`;
  state.cameras.forEach(startTile);
}

function tileEl(cam) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = cam.id;
  tile.draggable = false;
  tile.innerHTML = `
    <img id="img-${cam.id}" alt="${escapeHtml(cam.name)}" />
    <div class="label"><span class="dot ${cam.enabled ? 'ok' : ''}"></span>${escapeHtml(cam.name)}</div>
    <div class="tools">
      <button data-act="toggle">${cam.enabled ? 'Pause' : 'Play'}</button>
      <button data-act="edit">Edit</button>
      <button data-act="delete" class="danger">Del</button>
    </div>
  `;
  tile.querySelector('[data-act="edit"]').addEventListener('click', () => openEdit(cam));
  tile.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
    const next = await api(`/api/cameras/${cam.id}`, { method: 'PATCH', body: { enabled: !cam.enabled } });
    Object.assign(cam, { enabled: next.enabled });
    renderGrid();
  });
  tile.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    if (!confirm(`Remove ${cam.name}?`)) return;
    await api(`/api/cameras/${cam.id}`, { method: 'DELETE' });
    await loadCameras();
  });
  attachDnd(tile);
  return tile;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function attachDnd(tile) {
  tile.addEventListener('dragstart', (e) => {
    if (!state.editing) return;
    tile.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tile.dataset.id);
  });
  tile.addEventListener('dragend', () => tile.classList.remove('dragging'));
  tile.addEventListener('dragover', (e) => {
    if (!state.editing) return;
    e.preventDefault();
    tile.classList.add('drop-target');
  });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop-target'));
  tile.addEventListener('drop', async (e) => {
    e.preventDefault();
    tile.classList.remove('drop-target');
    const srcId = Number(e.dataTransfer.getData('text/plain'));
    const tgtId = Number(tile.dataset.id);
    if (!srcId || srcId === tgtId) return;
    const ids = state.cameras.map((c) => c.id);
    const srcIdx = ids.indexOf(srcId);
    const tgtIdx = ids.indexOf(tgtId);
    ids.splice(srcIdx, 1);
    ids.splice(tgtIdx, 0, srcId);
    state.cameras.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    renderGrid();
    await api('/api/cameras/reorder', { method: 'POST', body: { order: ids } });
  });
}

function toggleEditMode() {
  state.editing = !state.editing;
  document.body.classList.toggle('editing', state.editing);
  document.querySelectorAll('.tile').forEach((t) => (t.draggable = state.editing));
  document.getElementById('btn-edit-mode').textContent = state.editing ? 'Done' : 'Edit layout';
}

async function loadCameras() {
  state.cameras = await api('/api/cameras');
  renderGrid();
}

// --- Discover modal ---
const mDiscover = document.getElementById('m-discover');
const discoverList = document.getElementById('discover-list');
const discoverStatus = document.getElementById('discover-status');

let lastDevices = [];
const filterCheckbox = document.getElementById('filter-cameras');
filterCheckbox.addEventListener('change', renderDiscoverList);

function renderDiscoverList() {
  discoverList.innerHTML = '';
  const onlyCams = filterCheckbox.checked;
  const visible = lastDevices.filter((d) => !onlyCams || d.likely_camera || d.onvif);
  visible.forEach((d) => {
    const li = document.createElement('li');
    const title = d.name || (d.vendor_label ? `${d.vendor_label} @ ${d.host}` : d.host);
    const badges = [
      d.vendor_label ? `<span class="badge vendor">${escapeHtml(d.vendor_label)}</span>` : '',
      d.onvif ? `<span class="badge onvif">ONVIF</span>` : '',
      d.mac ? `<span class="badge" title="${escapeHtml(d.mac)}">${escapeHtml(d.mac.slice(0,8))}…</span>` : '',
    ].join('');
    const portList = d.open_ports?.length ? `ports ${d.open_ports.join(',')}` : `port ${d.port}`;
    li.innerHTML = `
      <div class="info">
        <div><strong>${escapeHtml(title)}</strong>${badges}</div>
        <div class="meta">${escapeHtml(d.host)} · ${portList}${d.hardware ? ' · ' + escapeHtml(d.hardware) : ''}</div>
      </div>
      <button class="primary">Add</button>
    `;
    li.querySelector('button').addEventListener('click', () => {
      mDiscover.hidden = true;
      openEdit({
        name: title,
        host: d.host,
        port: d.port || 80,
        _vendor: d.vendor || null,
      });
    });
    discoverList.appendChild(li);
  });
  const hidden = lastDevices.length - visible.length;
  if (hidden > 0 && onlyCams) {
    const li = document.createElement('li');
    li.className = 'meta';
    li.style.justifyContent = 'center';
    li.textContent = `${hidden} other device(s) hidden — uncheck "Cameras only" to show all.`;
    discoverList.appendChild(li);
  }
}

async function openDiscover() {
  discoverList.innerHTML = '';
  lastDevices = [];
  discoverStatus.textContent = 'Scanning ONVIF (multicast) + TCP-probing your local subnet…';
  mDiscover.hidden = false;
  try {
    const { devices, onvif_error, lan_error } = await api('/api/scan', {
      method: 'POST',
      body: { onvifTimeoutMs: 4000, tcpTimeoutMs: 600 },
    });
    lastDevices = devices;
    const msgs = [];
    msgs.push(devices.length ? `Found ${devices.length} device(s).` : 'No devices found.');
    if (onvif_error) msgs.push(`ONVIF: ${onvif_error}`);
    if (lan_error) msgs.push(`Scan: ${lan_error}`);
    discoverStatus.textContent = msgs.join(' · ');
    renderDiscoverList();
  } catch (err) {
    discoverStatus.textContent = 'Error: ' + err.message;
  }
}

// --- Edit modal ---
const mEdit = document.getElementById('m-edit');
const editForm = document.getElementById('edit-form');
const editStatus = document.getElementById('edit-status');
const editTitle = document.getElementById('edit-title');

let pendingVendor = null;

function openEdit(cam) {
  editTitle.textContent = cam.id ? 'Edit camera' : 'Add camera';
  editStatus.textContent = '';
  editForm.reset();
  for (const [k, v] of Object.entries(cam)) {
    const el = editForm.elements[k];
    if (el && v != null) el.value = v;
  }
  if (!cam.poll_ms) editForm.elements.poll_ms.value = 400;
  if (!cam.port) editForm.elements.port.value = 80;
  pendingVendor = cam._vendor || null;
  if (pendingVendor) {
    editStatus.textContent = `Detected as ${pendingVendor.toUpperCase()} — enter credentials and the RTSP & snapshot URLs will be filled in for you.`;
  }
  mEdit.hidden = false;
}

async function applyVendorTemplate() {
  if (!pendingVendor) return;
  const data = Object.fromEntries(new FormData(editForm).entries());
  if (!data.host) return;
  try {
    const urls = await api('/api/vendor-template', {
      method: 'POST',
      body: {
        vendor: pendingVendor,
        host: data.host,
        username: data.username || '',
        password: data.password || '',
      },
    });
    if (urls.rtsp_main && !editForm.elements.rtsp_url.value) {
      editForm.elements.rtsp_url.value = urls.rtsp_main;
    }
    if (urls.snapshot && !editForm.elements.snapshot_url.value) {
      editForm.elements.snapshot_url.value = urls.snapshot;
    }
  } catch (err) {
    // Silent — template suggestion is best-effort.
  }
}

['username', 'password', 'host'].forEach((n) => {
  editForm.elements[n].addEventListener('blur', applyVendorTemplate);
});

document.getElementById('btn-probe').addEventListener('click', async () => {
  const data = Object.fromEntries(new FormData(editForm).entries());
  editStatus.textContent = 'Probing via ONVIF…';
  try {
    const r = await api('/api/probe', {
      method: 'POST',
      body: { host: data.host, port: Number(data.port) || 80, username: data.username, password: data.password },
    });
    if (r.rtspUrl) editForm.elements.rtsp_url.value = r.rtspUrl;
    if (r.snapshotUrl) editForm.elements.snapshot_url.value = r.snapshotUrl;
    editStatus.textContent = `OK · ${r.info?.manufacturer || ''} ${r.info?.model || ''}`.trim();
  } catch (err) {
    editStatus.textContent = 'Probe failed: ' + err.message;
  }
});

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(editForm).entries());
  const id = data.id ? Number(data.id) : null;
  delete data.id;
  data.port = Number(data.port) || 80;
  data.poll_ms = Number(data.poll_ms) || 400;
  for (const k of ['username', 'password', 'rtsp_url', 'snapshot_url']) if (!data[k]) data[k] = null;
  try {
    if (id) await api(`/api/cameras/${id}`, { method: 'PATCH', body: data });
    else await api('/api/cameras', { method: 'POST', body: data });
    mEdit.hidden = true;
    await loadCameras();
  } catch (err) {
    editStatus.textContent = 'Save failed: ' + err.message;
  }
});

document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', (e) => e.target.closest('.modal').hidden = true)
);

document.getElementById('btn-discover').addEventListener('click', openDiscover);
document.getElementById('btn-add').addEventListener('click', () => openEdit({}));
document.getElementById('btn-edit-mode').addEventListener('click', toggleEditMode);

colsSel.addEventListener('change', () => setCols(colsSel.value));
const storedCols = localStorage.getItem(COLS_KEY) || '3';
colsSel.value = storedCols;
setCols(storedCols);

loadCameras().catch((err) => {
  grid.innerHTML = `<div style="padding:24px;color:var(--danger)">Failed to load: ${escapeHtml(err.message)}</div>`;
});
