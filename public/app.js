const grid = document.getElementById('grid');
const camCount = document.getElementById('cam-count');
const layoutSel = document.getElementById('layout');

const state = {
  cameras: [],
  editing: false,
  timers: new Map(),
};

const LAYOUT_KEY = 'flcv:layout';

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

function setLayout(name) {
  grid.className = 'grid ' + name;
  localStorage.setItem(LAYOUT_KEY, name);
}

function startTile(cam) {
  stopTile(cam.id);
  if (!cam.enabled) return;
  const img   = document.getElementById(`img-${cam.id}`);
  const stamp = document.getElementById(`stamp-${cam.id}`);
  if (!img) return;

  const baseMs = cam.poll_ms || 400;
  // After consecutive failures, slow down so we don't hammer a camera that's
  // refusing us (rate-limited, offline, bad creds). Reset on first success.
  const BACKOFFS = [baseMs * 5, 5_000, 15_000, 30_000, 60_000];

  let stopped = false;
  let pending = null;
  let failures = 0;

  const schedule = (delay) => {
    if (stopped) return;
    pending = setTimeout(tick, delay);
  };

  const tick = () => {
    pending = null;
    if (stopped) return;
    const url = `/api/cameras/${cam.id}/snapshot?t=${Date.now()}`;
    img.onload = () => {
      failures = 0;
      img.classList.remove('stale');
      if (stamp) stamp.textContent = new Date().toLocaleTimeString();
      schedule(baseMs);
    };
    img.onerror = async () => {
      failures += 1;
      img.classList.add('stale');
      if (stamp) {
        try {
          const r = await fetch(url);
          const body = await r.json();
          const first = body.attempts?.[0];
          const detail = first?.error?.match(/"detail"\s*:\s*"([^"]+)"/)?.[1] || first?.error || 'failed';
          stamp.textContent = `× ${String(detail).slice(0, 50)}`;
        } catch {
          stamp.textContent = '× failed';
        }
      }
      const delay = BACKOFFS[Math.min(failures - 1, BACKOFFS.length - 1)];
      schedule(delay);
    };
    img.src = url;
  };

  state.timers.set(cam.id, {
    stop: () => { stopped = true; if (pending) clearTimeout(pending); },
  });
  tick();
}

function stopTile(id) {
  const h = state.timers.get(id);
  if (h) h.stop();
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
    <img id="img-${cam.id}" alt="${escapeHtml(cam.name)}" draggable="false" />
    <div class="label">
      <span class="dot ${cam.enabled ? 'ok' : ''}"></span>
      <span class="name" contenteditable="${state.editing ? 'false' : 'true'}" spellcheck="false">${escapeHtml(cam.name)}</span>
    </div>
    <div class="stamp" id="stamp-${cam.id}">—</div>
    <div class="tools">
      <button data-act="toggle">${cam.enabled ? 'Pause' : 'Play'}</button>
      <button data-act="edit">Edit</button>
      <button data-act="delete" class="danger">Del</button>
    </div>
  `;
  const nameEl = tile.querySelector('.name');
  nameEl.addEventListener('click', (e) => e.stopPropagation());
  nameEl.addEventListener('dblclick', (e) => e.stopPropagation());
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = cam.name; nameEl.blur(); }
  });
  nameEl.addEventListener('blur', async () => {
    const next = nameEl.textContent.trim();
    if (!next || next === cam.name) { nameEl.textContent = cam.name; return; }
    try {
      const updated = await api(`/api/cameras/${cam.id}`, { method: 'PATCH', body: { name: next } });
      cam.name = updated.name;
    } catch (err) {
      nameEl.textContent = cam.name;
      alert('Rename failed: ' + err.message);
    }
  });
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
  tile.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    openZoom(cam);
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
  // In edit-layout mode, disable contenteditable so the name field doesn't
  // swallow mousedowns into text-selection (which would block drag-start).
  document.querySelectorAll('.tile .name').forEach((n) => {
    n.contentEditable = state.editing ? 'false' : 'true';
  });
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
let selectedHosts = new Set();
const filterCheckbox  = document.getElementById('filter-cameras');
const selectAllBox    = document.getElementById('select-all');
const btnBatchAdd     = document.getElementById('btn-batch-add');
const btnRescan       = document.getElementById('btn-rescan');
const discoverMeta    = document.getElementById('discover-meta');

filterCheckbox.addEventListener('change', renderDiscoverList);
selectAllBox.addEventListener('change', () => {
  const visible = visibleDevices();
  if (selectAllBox.checked) visible.forEach((d) => selectedHosts.add(d.host));
  else visible.forEach((d) => selectedHosts.delete(d.host));
  renderDiscoverList();
});
btnRescan.addEventListener('click', openDiscover);
btnBatchAdd.addEventListener('click', openBatchAdd);

function existingHosts() {
  return new Set(state.cameras.map((c) => c.host));
}

function visibleDevices() {
  const onlyCams = filterCheckbox.checked;
  const existing = existingHosts();
  return lastDevices.filter((d) => {
    if (existing.has(d.host)) return false;
    if (onlyCams && !d.likely_camera && !d.onvif) return false;
    return true;
  });
}

function updateBatchButton() {
  const n = selectedHosts.size;
  btnBatchAdd.disabled = n === 0;
  btnBatchAdd.textContent = n ? `Add selected (${n})` : 'Add selected';
}

function renderDiscoverList() {
  discoverList.innerHTML = '';
  const existing = existingHosts();
  const visible = visibleDevices();

  visible.forEach((d) => {
    const li = document.createElement('li');
    const title = d.name || (d.vendor_label ? `${d.vendor_label} @ ${d.host}` : d.host);
    const badges = [
      d.vendor_label ? `<span class="badge vendor">${escapeHtml(d.vendor_label)}</span>` : '',
      d.onvif ? `<span class="badge onvif">ONVIF</span>` : '',
      d.mac ? `<span class="badge" title="${escapeHtml(d.mac)}">${escapeHtml(d.mac.slice(0,8))}…</span>` : '',
    ].join('');
    const portList = d.open_ports?.length ? `ports ${d.open_ports.join(',')}` : `port ${d.port}`;
    const checked = selectedHosts.has(d.host) ? 'checked' : '';
    li.innerHTML = `
      <input type="checkbox" data-host="${escapeHtml(d.host)}" ${checked} />
      <div class="info">
        <div><strong>${escapeHtml(title)}</strong>${badges}</div>
        <div class="meta">${escapeHtml(d.host)} · ${portList}${d.hardware ? ' · ' + escapeHtml(d.hardware) : ''}</div>
      </div>
      <button class="primary" data-act="add">Add</button>
    `;
    const cb = li.querySelector('input[type=checkbox]');
    cb.addEventListener('change', () => {
      if (cb.checked) selectedHosts.add(d.host);
      else selectedHosts.delete(d.host);
      updateBatchButton();
      syncSelectAll();
    });
    li.querySelector('[data-act="add"]').addEventListener('click', async () => {
      mDiscover.hidden = true;
      const creds = await fetchDefaultCreds();
      openEdit({
        name: title,
        host: d.host,
        port: d.port || 80,
        username: creds.username,
        password: creds.password,
        _vendor: d.vendor || null,
      });
    });
    discoverList.appendChild(li);
  });

  const hiddenAdded = lastDevices.filter((d) => existing.has(d.host)).length;
  const hiddenFilter = lastDevices.length - visible.length - hiddenAdded;
  const parts = [];
  if (hiddenAdded)  parts.push(`${hiddenAdded} already added`);
  if (hiddenFilter) parts.push(`${hiddenFilter} non-camera hidden`);
  discoverMeta.textContent = parts.length ? `(${parts.join(' · ')})` : '';
  syncSelectAll();
  updateBatchButton();
}

function syncSelectAll() {
  const visible = visibleDevices();
  selectAllBox.checked = visible.length > 0 && visible.every((d) => selectedHosts.has(d.host));
}

let _credsCache = null;
async function fetchDefaultCreds() {
  if (_credsCache) return _credsCache;
  try { _credsCache = await api('/api/settings/default-credentials'); }
  catch { _credsCache = { username: '', password: '' }; }
  return _credsCache;
}
function invalidateCredsCache() { _credsCache = null; }

async function openDiscover() {
  discoverList.innerHTML = '';
  lastDevices = [];
  selectedHosts = new Set();
  updateBatchButton();
  discoverStatus.textContent = 'Scanning ONVIF (multicast) + TCP-probing your local subnet…';
  discoverMeta.textContent = '';
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

// --- Batch add modal ---
const mBatch = document.getElementById('m-batch');
const batchForm = document.getElementById('batch-form');
const batchCount = document.getElementById('batch-count');
const batchStatus = document.getElementById('batch-status');

async function openBatchAdd() {
  if (!selectedHosts.size) return;
  const items = lastDevices.filter((d) => selectedHosts.has(d.host));
  batchCount.textContent = items.length;
  batchStatus.textContent = '';
  batchForm.reset();
  batchForm.elements.poll_ms.value = 400;
  const creds = await fetchDefaultCreds();
  batchForm.elements.username.value = creds.username || '';
  batchForm.elements.password.value = creds.password || '';
  mBatch.hidden = false;
}

batchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(batchForm).entries());
  const items = lastDevices
    .filter((d) => selectedHosts.has(d.host))
    .map((d) => ({
      host: d.host,
      port: d.port || 80,
      vendor: d.vendor || null,
      name: d.name || (d.vendor_label ? `${d.vendor_label} ${d.host}` : d.host),
    }));
  batchStatus.textContent = `Adding ${items.length}…`;
  try {
    const result = await api('/api/cameras/batch', {
      method: 'POST',
      body: {
        items,
        username: data.username || null,
        password: data.password || null,
        poll_ms: Number(data.poll_ms) || 400,
      },
    });
    invalidateCredsCache();
    mBatch.hidden = true;
    mDiscover.hidden = true;
    selectedHosts = new Set();
    await loadCameras();
    if (result.skipped?.length) {
      alert(`Added ${result.created.length}, skipped ${result.skipped.length} (already existed).`);
    }
  } catch (err) {
    batchStatus.textContent = 'Failed: ' + err.message;
  }
});

// --- Edit modal ---
const mEdit = document.getElementById('m-edit');
const editForm = document.getElementById('edit-form');
const editStatus = document.getElementById('edit-status');
const editTitle = document.getElementById('edit-title');

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
  // _vendor is the detected vendor from the scan; for an existing camera the
  // vendor field is set directly from cam.vendor by the loop above.
  if (cam._vendor && !editForm.elements.vendor.value) {
    editForm.elements.vendor.value = cam._vendor;
    editStatus.textContent = `Detected as ${cam._vendor.toUpperCase()} — enter credentials and the RTSP & snapshot URLs will be filled in for you.`;
  }
  mEdit.hidden = false;
}

async function applyVendorTemplate() {
  const data = Object.fromEntries(new FormData(editForm).entries());
  if (!data.vendor || !data.host) return;
  try {
    const urls = await api('/api/vendor-template', {
      method: 'POST',
      body: {
        vendor: data.vendor,
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
  } catch {
    // Best-effort — server also regenerates URLs on save when vendor changes.
  }
}

['username', 'password', 'host', 'vendor'].forEach((n) => {
  editForm.elements[n].addEventListener('blur', applyVendorTemplate);
});
editForm.elements.vendor.addEventListener('change', applyVendorTemplate);

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
    invalidateCredsCache();
    mEdit.hidden = true;
    await loadCameras();
  } catch (err) {
    editStatus.textContent = 'Save failed: ' + err.message;
  }
});

// --- Zoom modal (double-click a tile to inspect) ---
const mZoom     = document.getElementById('m-zoom');
const zoomImg   = document.getElementById('zoom-img');
const zoomName  = document.getElementById('zoom-name');
const zoomStamp = document.getElementById('zoom-stamp');
let zoomTimer   = null;

function openZoom(cam) {
  zoomName.textContent = cam.name;
  zoomStamp.textContent = '—';
  zoomImg.src = '';
  zoomImg.classList.remove('stale');
  mZoom.hidden = false;

  let inflight = false;
  const tick = () => {
    if (inflight) return;
    inflight = true;
    const url = `/api/cameras/${cam.id}/snapshot?t=${Date.now()}&zoom=1`;
    zoomImg.onload = () => {
      inflight = false;
      zoomImg.classList.remove('stale');
      zoomStamp.textContent = new Date().toLocaleTimeString();
    };
    zoomImg.onerror = () => {
      inflight = false;
      zoomImg.classList.add('stale');
      zoomStamp.textContent = '× failed';
    };
    zoomImg.src = url;
  };
  tick();
  zoomTimer = setInterval(tick, cam.poll_ms || 400);
}

function closeZoom() {
  if (zoomTimer) clearInterval(zoomTimer);
  zoomTimer = null;
  zoomImg.onload = zoomImg.onerror = null;
  zoomImg.src = '';
  mZoom.hidden = true;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !mZoom.hidden) closeZoom();
});
mZoom.addEventListener('click', (e) => {
  // Clicking the dark backdrop closes too.
  if (e.target === mZoom) closeZoom();
});

document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', (e) => {
    const modal = e.target.closest('.modal');
    if (modal === mZoom) return closeZoom();
    modal.hidden = true;
  })
);

document.getElementById('btn-discover').addEventListener('click', openDiscover);
document.getElementById('btn-add').addEventListener('click', async () => {
  const creds = await fetchDefaultCreds();
  openEdit({ username: creds.username || '', password: creds.password || '' });
});
document.getElementById('btn-edit-mode').addEventListener('click', toggleEditMode);

layoutSel.addEventListener('change', () => setLayout(layoutSel.value));
const storedLayout = localStorage.getItem(LAYOUT_KEY) || 'cols-3';
// Defensive: fall back to cols-3 if the stored value isn't one of the options
// (e.g. someone migrated from a version that only knew "3").
if ([...layoutSel.options].some((o) => o.value === storedLayout)) {
  layoutSel.value = storedLayout;
  setLayout(storedLayout);
} else {
  layoutSel.value = 'cols-3';
  setLayout('cols-3');
}

loadCameras().catch((err) => {
  grid.innerHTML = `<div style="padding:24px;color:var(--danger)">Failed to load: ${escapeHtml(err.message)}</div>`;
});
