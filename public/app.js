// mobile-cfy web UI. No framework, no build step - the server is plain Node.

const $ = (id) => document.getElementById(id);

/**
 * Wiring that survives the markup being edited. A plain `$('x').onclick =`
 * throws when `x` is absent, and because this is a module, one uncaught
 * top-level error aborts *everything after it* - commenting a button out in
 * index.html silently killed the settings tab and the boot sequence.
 */
const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
const setDisabled = (id, v) => { const el = $(id); if (el) el.disabled = v; };
const setHidden = (id, v) => { const el = $(id); if (el) el.hidden = !v; };
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v ?? ''; };
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    ...opts,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!res.ok) {
    const e = new Error(body?.error || `${res.status} ${res.statusText}`);
    e.errors = body?.errors;
    e.status = res.status;
    throw e;
  }
  return body;
};

const state = {
  cfg: null,
  slots: [null, null, null, null],   // null | { uploadId } | { ref }
  slotUrls: [null, null, null, null],
  job: null,                          // the job the detail panel is showing
  jobs: new Map(),                    // every job we know about, by id
  es: null,
  gallery: [],
  history: [],
  collapsed: new Set(),          // gallery job ids folded away, from localStorage
  bindingTitles: new Map(),
};

const MAX_SLOTS = 4;

// ------------------------------------------------------------------ chrome
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function showError(msg) {
  const el = $('genErr');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

/**
 * Copy text to the clipboard.
 *
 * navigator.clipboard only exists in a SECURE CONTEXT, and this page is normally
 * opened over plain http on a LAN IP from the phone's browser - where it is
 * simply undefined. The textarea + execCommand path is the old trick that still
 * works there, so it is the primary implementation rather than a fallback.
 */
async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* fall through - a denied clipboard prompt is not fatal */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    // Off-screen but still focusable; display:none would make the selection,
    // and therefore the copy, fail.
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function refreshHealth() {
  const dot = $('healthDot');
  const text = $('healthText');
  try {
    const h = await api('/api/health');
    const c = h.comfy;
    if (c.state === 'ok') {
      dot.className = 'dot ok';
      text.textContent = `ComfyUI ${h.comfy.info?.comfyui_version ?? ''}`.trim();
    } else if (c.state === 'unauthorized') {
      dot.className = 'dot bad';
      text.textContent = 'auth failed';
    } else if (c.state === 'no-token') {
      dot.className = 'dot bad';
      text.textContent = 'no token';
    } else {
      dot.className = 'dot warn';
      text.textContent = c.state;
    }
    $('healthBtn').title = c.error || `${c.host}:${c.port}`;
  } catch (e) {
    dot.className = 'dot bad';
    text.textContent = 'server offline';
  }
}

// -------------------------------------------------------------------- tabs
for (const btn of document.querySelectorAll('.tabbtn')) {
  btn.onclick = () => {
    document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b === btn));
    const name = btn.dataset.tab;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === `tab-${name}`);
    if (name === 'gallery') loadGallery();
    if (name === 'history') loadHistory();
    if (name === 'settings') loadSettings();
    // A hidden textarea has no scrollHeight, so the box can only be measured
    // once its tab is actually on screen.
    if (name === 'generate') autoGrow($('prompt'));
    window.scrollTo(0, 0);
  };
}

// ------------------------------------------------------------- prompt sizing
/**
 * Grow the prompt box to fit what was typed, up to a cap. Height has to go to
 * 'auto' first, otherwise scrollHeight just reports the current (clipped) box
 * and the element can never shrink back. `chrome` re-adds the border and
 * scrollbar that box-sizing:border-box takes out of the content height.
 */
function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  const chrome = el.offsetHeight - el.clientHeight;
  const max = Math.round(window.innerHeight * 0.55);
  const wanted = el.scrollHeight + chrome;
  el.style.height = `${Math.min(wanted, max)}px`;
  el.style.overflowY = wanted > max ? 'auto' : 'hidden';
}
$('prompt').addEventListener('input', () => autoGrow($('prompt')));
window.addEventListener('resize', () => autoGrow($('prompt')));

// ------------------------------------------------------------------- slots
function renderSlots() {
  const wrap = $('slots');
  wrap.innerHTML = '';
  state.slots.forEach((slot, i) => {
    const d = document.createElement('div');
    d.className = 'slot' + (slot ? ' filled' : '');
    if (slot) {
      const img = document.createElement('img');
      img.src = state.slotUrls[i];
      img.alt = `reference ${i + 1}`;
      d.append(img);
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = i + 1;
      d.append(n);
      const x = document.createElement('button');
      x.className = 'x';
      x.type = 'button';
      x.textContent = '×';
      x.onclick = (ev) => { ev.stopPropagation(); setSlot(i, null); };
      d.append(x);
    } else {
      d.textContent = '+';
      d.onclick = () => pickFiles(i);
    }
    wrap.append(d);
  });
  const n = state.slots.filter(Boolean).length;
  $('slotPill').textContent = `${n} / ${MAX_SLOTS}`;
  syncEnhanceHint();
}

function setSlot(i, value, url) {
  state.slots[i] = value;
  state.slotUrls[i] = value ? url : null;
  renderSlots();
}

/** Attach a gallery image to the next free slot (Reference N). */
function useAsInput(entry) {
  const i = state.slots.findIndex((s) => !s);
  if (i === -1) { toast('all 4 slots are full'); return; }
  setSlot(i, { ref: entry.id }, `/api/gallery/${entry.id}/file`);
  toast(`reference ${i + 1} set`);
}

function syncEnhanceHint() {
  const hasImages = state.slots.some(Boolean);
  $('enhance').disabled = hasImages;
  $('enhanceHint').textContent = hasImages
    ? 'bypassed in reference mode - the prompt goes to the raw node'
    : 'runs the Qwen-VL enhancer';
}

let pickTarget = 0;
function pickFiles(startAt = 0) {
  pickTarget = startAt;
  $('filePick').value = '';
  $('filePick').click();
}

$('filePick').onchange = async () => {
  const files = [...$('filePick').files];
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('file', f, f.name);
  try {
    const { uploads } = await api('/api/uploads', { method: 'POST', body: fd });
    uploads.forEach((u, i) => {
      const slot = pickTarget + i;
      if (slot < MAX_SLOTS) setSlot(slot, { uploadId: u.id }, `/api/uploads/${u.id}`);
    });
    toast(`${uploads.length} image(s) attached`);
  } catch (e) {
    toast(e.message);
  }
};

// drag & drop + paste onto the slots area
const slotsEl = $('slots');
slotsEl.addEventListener('dragover', (e) => e.preventDefault());
slotsEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f, i) => fd.append('file', f, `drop${i}-${f.name}`));
  try {
    const { uploads } = await api('/api/uploads', { method: 'POST', body: fd });
    uploads.forEach((u, i) => {
      const slot = state.slots.findIndex((s) => !s);
      if (slot !== -1) setSlot(slot, { uploadId: u.id }, `/api/uploads/${u.id}`);
    });
  } catch (err) { toast(err.message); }
});
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  const file = item.getAsFile();
  const fd = new FormData();
  fd.append('file', file, 'pasted.png');
  api('/api/uploads', { method: 'POST', body: fd }).then(({ uploads }) => {
    const slot = state.slots.findIndex((s) => !s);
    if (slot !== -1) setSlot(slot, { uploadId: uploads[0].id }, `/api/uploads/${uploads[0].id}`);
    toast('pasted image attached');
  }).catch((err) => toast(err.message));
});

function clearSlots() {
  state.slots = state.slots.map(() => null);
  state.slotUrls = [null, null, null, null];
  renderSlots();
}

$('clearSlots').onclick = clearSlots;

$('fillFromGallery').onclick = async () => {
  const { images } = await api('/api/gallery?limit=4');
  if (!images.length) { toast('gallery is empty'); return; }
  state.slots = [null, null, null, null];
  state.slotUrls = [null, null, null, null];
  images.slice(0, MAX_SLOTS).forEach((entry, i) => setSlot(i, { ref: entry.id }, `/api/gallery/${entry.id}/file`));
  toast(`loaded ${Math.min(images.length, MAX_SLOTS)} from gallery`);
};

$('helpRefresh').onclick = (e) => {
  e.preventDefault();
  toast("'Once per group' throws the override switch on run 1 only, so the workflow enhances the prompt once and every later image varies by seed. 'Every run' re-enhances each time - slower, but each image gets its own wording.");
};

$('helpResolution').onclick = (e) => {
  e.preventDefault();
  toast('Pixel size fed to the Qwen text encoder (workflow node 204), not the final image size - that stays on Megapixels. Blank leaves the workflow at its own default of 1024. Raising it can help the encoder read fine detail in reference images; it costs VRAM and time.');
};

// -------------------------------------------------------------- run summary
function updateRunMath() {
  const batch = Math.max(1, parseInt($('batch').value, 10) || 1);
  const shuffle = Math.max(1, parseInt($('shuffle').value, 10) || 1);
  const count = state.slots.filter(Boolean).length;
  const parts = [`${batch * shuffle} run(s)`];
  if (count) {
    parts.push(`image count ${count}`, 'enhancer bypassed');
  } else {
    // Node 68 decides whether the workflow re-enhances or reuses its memorised
    // prompt, so the wording of every image depends on this, not just the seed.
    parts.push($('refresh').value === 'everyRun'
      ? 're-enhance the prompt every run'
      : `${batch} seed(s) per group, prompt enhanced once`);
  }
  $('runMath').textContent = parts.join(' · ');
}
for (const id of ['batch', 'shuffle', 'refresh']) $(id).addEventListener('input', updateRunMath);
$('refresh').addEventListener('change', updateRunMath);

// ---------------------------------------------------------- remembered form
// Toggles and run settings survive a reload. The prompt itself does NOT - that
// is what the History tab is for, and silently restoring a stale prompt would
// be worse than an empty box. Reference images are not remembered either: the
// uploads they point at are one-shot handles from a previous session.
const FORM_KEY = 'mcfy.form.v1';
const FORM_IDS = ['enhance', 'turbo', 'collect', 'steps', 'inputResolution', 'megapixels', 'batch', 'shuffle', 'refresh'];

function saveForm() {
  const out = {};
  for (const id of FORM_IDS) {
    const el = $(id);
    if (!el) continue;
    out[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  try { localStorage.setItem(FORM_KEY, JSON.stringify(out)); } catch { /* private mode */ }
}

/** Returns true when a stored form was found and applied. */
function restoreForm() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(FORM_KEY) ?? 'null'); } catch { saved = null; }
  if (!saved || typeof saved !== 'object') return false;
  let applied = false;
  for (const id of FORM_IDS) {
    const el = $(id);
    if (!el || saved[id] === undefined || saved[id] === null) continue;
    if (el.type === 'checkbox') el.checked = Boolean(saved[id]);
    else if (el.tagName === 'SELECT') { if ([...el.options].some((o) => o.value === saved[id])) el.value = saved[id]; }
    else el.value = saved[id];
    applied = true;
  }
  return applied;
}

for (const id of FORM_IDS) {
  const el = $(id);
  if (!el) continue;
  // 'input' covers typing and swipes; 'change' covers the select and the
  // committed value of a number field. Firing twice is harmless.
  el.addEventListener('input', saveForm);
  el.addEventListener('change', saveForm);
}

// ---------------------------------------------------------------- generate
// The server already runs one job at a time and parks the rest, so Generate is
// never disabled: type the next prompt and press it again while one is running.
$('generate').onclick = async () => {
  showError(null);
  const prompt = $('prompt').value.trim();
  if (!prompt) { showError('prompt is empty'); $('prompt').focus(); return; }

  const stepsRaw = $('steps').value.trim();
  const resRaw = $('inputResolution').value.trim();
  const body = {
    prompt,
    megapixels: parseFloat($('megapixels').value) || undefined,
    batch: parseInt($('batch').value, 10) || undefined,
    shuffle: parseInt($('shuffle').value, 10) || undefined,
    promptEnhance: $('enhance').checked,
    turbo: $('turbo').checked,
    collectImages: $('collect').checked,
    stepsOverride: stepsRaw === '' ? null : parseInt(stepsRaw, 10),
    inputResolution: resRaw === '' ? null : parseInt(resRaw, 10),
    refresh: $('refresh').value,
    slots: state.slots,
  };

  try {
    const job = await api('/api/generate', { method: 'POST', body: JSON.stringify(body) });
    trackJob(job);
    // Clear the prompt, never the settings - queueing four variations of the
    // same idea should not mean retyping megapixels four times. References are
    // the exception: they belong to the prompt that was just submitted, and
    // leaving them armed would silently image-to-image the *next* one.
    const hadRefs = state.slots.some(Boolean);
    $('prompt').value = '';
    autoGrow($('prompt'));
    if (hadRefs) clearSlots();
    saveForm();
    $('prompt').focus();
    if (hadRefs) toast('references cleared');
  } catch (e) {
    showError(e.errors ? e.errors.join('\n') : e.message);
  }
};

$('cancelJob').onclick = async () => {
  if (!state.job) return;
  try { await api(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' }); } catch { /* already gone */ }
};

/**
 * One EventSource for every job. Opening a stream per job would exhaust the
 * browser's ~6 connections per origin on HTTP/1.1, which is exactly what a phone
 * browser serving this page will do.
 */
function connectEvents() {
  state.es?.close();
  const es = new EventSource('/api/events');
  state.es = es;
  es.onmessage = (ev) => onJobUpdate(JSON.parse(ev.data));
  es.onerror = () => {
    // SSE drops are normal when the phone sleeps; fall back to polling.
    es.close();
    state.es = null;
    setTimeout(connectEvents, 4000);
    pollJobs();
  };
}

function onJobUpdate(snap) {
  const known = state.jobs.has(snap.id);
  state.jobs.set(snap.id, snap);
  if (!known) toast(snap.status === 'queued' ? 'queued' : `job ${snap.status}`);
  renderQueue();
  // The detail panel follows whatever is actually running, so queueing three
  // jobs does not leave you staring at the finished one.
  const active = pickActive();
  if (active && (active.id !== state.job?.id || snap.id === active.id)) {
    state.job = active;
    renderJob(active);
  }
  if (['done', 'error', 'cancelled'].includes(snap.status)) {
    loadGallery();
    refreshHealth();
  }
}

/** Running first, then queued (in order), then the most recent finished. */
function pickActive() {
  const all = [...state.jobs.values()];
  return (
    all.find((j) => j.status === 'running')
    ?? all.find((j) => j.status === 'queued')
    ?? all.slice().reverse().find((j) => ['done', 'error', 'cancelled'].includes(j.status))
    ?? null
  );
}

const inFlight = (j) => j.status === 'queued' || j.status === 'running';

function renderQueue() {
  const wrap = $('queueList');
  const jobs = [...state.jobs.values()];
  const busy = jobs.filter(inFlight);
  const rows = busy.slice();

  // The most recent finished job that is not the one on screen. Queueing three
  // jobs means the detail panel follows whatever is running, so without this
  // the results of the job that just completed would only exist in the gallery.
  const shown = state.job?.id;
  const recent = jobs
    .filter((j) => ['done', 'error', 'cancelled'].includes(j.status) && j.id !== shown)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
  if (recent) rows.push(recent);

  wrap.innerHTML = '';
  wrap.hidden = rows.length === 0;

  for (const j of rows) {
    const finished = !inFlight(j);
    const row = document.createElement('div');
    row.className = 'qrow' + (j.status === 'running' ? ' running' : finished ? ' finished' : '');
    const dot = document.createElement('span');
    dot.textContent = j.status === 'running' ? '▶' : finished ? '✓' : '⏳';
    const text = document.createElement('span');
    text.className = 'qtext';
    text.textContent = truncate(j.spec?.prompt ?? '(no prompt)', 42);
    text.title = 'tap to show this job';
    text.onclick = () => { state.job = j; renderJob(j); renderQueue(); };
    const meta = document.createElement('span');
    meta.className = 'qmeta';
    if (finished) {
      meta.textContent = `${j.status} · ${j.summary.images} img`;
      row.append(dot, text, meta);
    } else if (j.status === 'running') {
      const cur = j.runs.find((r) => r.status === 'running') ?? j.runs[j.summary.current];
      meta.textContent = `${j.summary.done}/${j.summary.total} runs · ${j.summary.images} img`;
      row.append(dot, text, meta);
      if (cur) {
        const bar = document.createElement('div');
        bar.className = 'qbar';
        const fill = document.createElement('i');
        fill.style.width = `${cur.progress ?? 0}%`;
        bar.append(fill);
        row.append(bar);
      }
    } else {
      meta.textContent = j.queuePosition
        ? `queued ${j.queuePosition} of ${j.queueLength}`
        : 'queued';
      row.append(dot, text, meta);
    }
    if (!finished) {
      const x = document.createElement('button');
      x.className = 'qx';
      x.type = 'button';
      x.textContent = '×';
      x.title = 'cancel this job';
      x.onclick = async () => {
        try { await api(`/api/jobs/${j.id}/cancel`, { method: 'POST' }); } catch (e) { toast(e.message); }
      };
      row.append(x);
    }
    wrap.append(row);
  }

  const hint = $('queueHint');
  const behind = busy.length - 1;
  hint.hidden = behind === 0;
  if (behind > 0) {
    hint.textContent = `${behind} job${behind > 1 ? 's' : ''} queued — keep typing and press Generate to add more`;
  }
  $('generate').textContent = busy.length ? 'Add to queue' : 'Generate';
}

let pollTimer = null;
async function pollJobs() {
  clearTimeout(pollTimer);
  if (state.es) return;
  try {
    const { jobs } = await api('/api/jobs');
    for (const snap of jobs) state.jobs.set(snap.id, snap);
    renderQueue();
    const active = pickActive();
    if (active) { state.job = active; renderJob(active); }
    if (jobs.some(inFlight)) pollTimer = setTimeout(pollJobs, 3000);
  } catch {
    pollTimer = setTimeout(pollJobs, 5000);
  }
}

function trackJob(job) {
  trackSnapshot(job);
  connectEvents();
}

function trackSnapshot(snap) {
  state.jobs.set(snap.id, snap);
  renderQueue();
  state.job = pickActive() ?? snap;
  renderJob(state.job);
}

function runDuration(r) {
  if (!r.startedAt) return '';
  const end = r.endedAt ? Date.parse(r.endedAt) : Date.now();
  return `${Math.max(0, Math.round((end - Date.parse(r.startedAt)) / 1000))}s`;
}

function renderJob(job) {
  $('jobPanel').hidden = false;
  const s = $('jobStatus');
  s.textContent = `${job.status} · ${job.summary.done}/${job.summary.total} runs · ${job.summary.images} images`;
  s.className = `status ${job.status}`;

  const cur = job.runs.find((r) => r.status === 'running') ?? job.runs[job.summary.current];
  const pct = cur?.progress ?? 0;
  $('jobBar').style.width = `${job.status === 'done' ? 100 : pct}%`;

  const bits = [];
  if (job.status === 'queued') bits.push('waiting for the running job to finish');
  if (cur) {
    bits.push(`run ${cur.index + 1} of ${job.summary.total}`);
    if (cur.queue != null && cur.queue > 0) bits.push(`queue +${cur.queue}`);
    if (cur.node != null) bits.push(`node ${cur.node}`);
    if (cur.seed != null) bits.push(`seed ${cur.seed}`);
  }
  if (job.authFailed) bits.push('auth failed - reload the token in Settings');
  if (job.error) bits.push(job.error);
  $('jobLine').textContent = bits.join(' · ');

  const ul = $('runList');
  ul.innerHTML = '';
  for (const r of job.runs) {
    const li = document.createElement('li');
    if (r.error) li.className = 'err';
    li.innerHTML = `<b>run ${r.index + 1}</b><span></span>`;
    const detail = r.error
      ? r.error
      : [r.status, r.seed != null ? `seed ${r.seed}` : null, r.progress ? `${r.progress}%` : null, runDuration(r)]
          .filter(Boolean).join(' · ');
    li.lastChild.textContent = detail;
    if (r.promptId) li.title = `ComfyUI prompt ${r.promptId}`;
    ul.append(li);
  }

  const thumbs = $('jobThumbs');
  thumbs.innerHTML = '';
  const all = [];
  for (const r of job.runs) for (const entry of r.images ?? []) all.push(entry);
  for (const entry of all) {
    const img = document.createElement('img');
    img.src = `/api/gallery/${entry.id}/file`;
    img.loading = 'lazy';
    img.onclick = () => openLightbox(entry, all);
    img.title = entry.localName ?? entry.comfyFilename;
    thumbs.append(img);
  }
}

// ----------------------------------------------------------------- gallery
async function loadGallery() {
  try {
    const { images } = await api('/api/gallery?limit=300');
    state.gallery = images;
    renderGallery();
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------- collapsed groups
// Which job cards are folded away is remembered across reloads. The old "last 4"
// button is gone: the per-image "⟳ use as input" below each thumbnail covers the
// same need one image at a time, and the header is better spent on folding.
const COLLAPSE_KEY = 'mcfy.collapsedJobs.v1';

function loadCollapsed() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]'); } catch { v = null; }
  state.collapsed = new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
}

function saveCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...state.collapsed])); } catch { /* private mode */ }
}

function toggleGroup(jobId) {
  if (state.collapsed.has(jobId)) state.collapsed.delete(jobId);
  else state.collapsed.add(jobId);
  saveCollapsed();
  renderGallery();
}

function renderGallery() {
  const wrap = $('galleryList');
  wrap.innerHTML = '';
  if (!state.gallery.length) {
    wrap.innerHTML = '<p class="note">No images yet. Generate something, or pull a past image back from ComfyUI.</p>';
    return;
  }

  const groups = new Map();
  for (const entry of state.gallery) {
    const key = entry.jobId ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  // Drop remembered folds for jobs that are no longer on screen, or the stored
  // list grows forever and a job id that comes back stays mysteriously folded.
  let pruned = false;
  for (const id of [...state.collapsed]) {
    if (!groups.has(id)) { state.collapsed.delete(id); pruned = true; }
  }
  if (pruned) saveCollapsed();

  for (const [jobId, entries] of groups) {
    const collapsed = state.collapsed.has(jobId);
    const g = document.createElement('div');
    g.className = collapsed ? 'group collapsed' : 'group';
    const hd = document.createElement('div');
    hd.className = 'group-hd';
    const when = new Date(entries[0].at).toLocaleString();
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'g-head';
    head.setAttribute('aria-expanded', String(!collapsed));
    head.title = collapsed ? 'show images' : 'hide images';
    head.innerHTML =
      `<span class="g-label"><b>${escapeHtml(truncate(entries[0].prompt ?? '(no prompt)', 70))}</b>`
      + `${escapeHtml(when)} · ${entries.length} image(s) · job ${escapeHtml(jobId.slice(0, 8))}</span>`;
    const chev = document.createElement('span');
    chev.className = 'g-chev';
    chev.textContent = collapsed ? '▸ show' : '▾ hide';
    head.append(chev);
    head.onclick = () => toggleGroup(jobId);
    hd.append(head);
    g.append(hd);

    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.hidden = collapsed;
    for (const entry of entries) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const img = document.createElement('img');
      img.src = `/api/gallery/${entry.id}/file`;
      img.loading = 'lazy';
      img.alt = truncate(entry.prompt ?? '', 60);
      img.onclick = () => openLightbox(entry, state.gallery);
      const acts = document.createElement('div');
      acts.className = 'acts';
      const bUse = document.createElement('button');
      bUse.textContent = '⟳ use as input';
      bUse.onclick = () => useAsInput(entry);
      // No save button: every image is already written to the download folder
      // as its run finishes, so a second copy is noise.
      acts.append(bUse);
      cell.append(img, acts);
      grid.append(cell);
    }
    g.append(grid);
    wrap.append(g);
  }
}

async function saveEntry(entry) {
  // Nothing in the UI calls this any more - every image is already written to
  // the download folder as its run finishes - but the route stays reachable for
  // the one case the button could not fix: a download that failed mid-job.
  return api(`/api/gallery/${entry.id}/save`, { method: 'POST', body: '{}' });
}

$('reloadGallery').onclick = loadGallery;
$('clearGallery').onclick = async () => {
  if (!confirm('Clear the gallery index? Files already downloaded stay on disk.')) return;
  await api('/api/gallery', { method: 'DELETE' });
  await loadGallery();
};

// ------------------------------------------------------------------ history
async function loadHistory() {
  try {
    const { entries } = await api('/api/history?limit=100');
    state.history = entries;
    renderHistory();
  } catch (e) { toast(e.message); }
}

const fmtMP = (mp) => (mp ? `${Number(mp).toFixed(Number(mp) < 1 ? 2 : 1)} MP` : 'default size');

function renderHistory() {
  const wrap = $('historyList');
  wrap.innerHTML = '';
  if (!state.history.length) {
    wrap.innerHTML = '<p class="note">Nothing yet. Prompts show up here the moment you submit one.</p>';
    return;
  }

  for (const entry of state.history) {
    const card = document.createElement('div');
    card.className = 'hrow tap';

    const top = document.createElement('div');
    top.className = 'hrow-top';
    const p = document.createElement('div');
    p.className = 'hrow-prompt';
    p.textContent = entry.prompt || '(empty prompt)';
    const x = document.createElement('button');
    x.className = 'hrow-x';
    x.type = 'button';
    x.textContent = '×';
    x.title = 'forget this prompt';
    x.onclick = async (ev) => {
      ev.stopPropagation();
      try {
        await api(`/api/history/${entry.id}`, { method: 'DELETE' });
        loadHistory();
      } catch (e) { toast(e.message); }
    };
    top.append(p, x);
    card.append(top);

    const s = entry.settings ?? {};
    const meta = document.createElement('div');
    meta.className = 'hrow-meta';
    const when = new Date(entry.lastUsedAt).toLocaleString();
    const bits = [when];
    if (entry.uses > 1) bits.push(`used ${entry.uses}×`);
    if (entry.results) bits.push(`${entry.results} image${entry.results > 1 ? 's' : ''}`);
    const refs = (entry.slots ?? []).filter(Boolean).length;
    if (refs) bits.push(`${refs} reference${refs > 1 ? 's' : ''}`);
    meta.textContent = bits.join(' · ');
    card.append(meta);

    const chips = document.createElement('div');
    chips.className = 'chips';
    const chip = (label, on) => {
      const c = document.createElement('span');
      c.className = on ? 'chip on' : 'chip';
      c.textContent = label;
      chips.append(c);
    };
    chip(`enhance ${s.promptEnhance === false ? 'off' : 'on'}`, s.promptEnhance !== false);
    chip(s.turbo ? 'turbo' : 'full model', s.turbo);
    if (s.stepsOverride) chip(`${s.stepsOverride} steps`, true);
    if (s.inputResolution) chip(`${s.inputResolution}px encoder`, true);
    chip(fmtMP(s.megapixels), false);
    chip(`${s.batch ?? 1}×${s.shuffle ?? 1} shuffle`, false);
    if (s.refresh === 'everyRun') chip('refresh every run', true);
    if (s.collectImages === false) chip('no downloads', false);
    card.append(chips);

    const imgs = (entry.slots ?? []).filter(Boolean);
    if (imgs.length) {
      const strip = document.createElement('div');
      strip.className = 'hrow-slots';
      for (const slot of imgs) {
        if (slot.available && slot.url) {
          const img = document.createElement('img');
          img.src = slot.url;
          img.alt = 'reference';
          img.loading = 'lazy';
          strip.append(img);
        } else {
          const gone = document.createElement('span');
          gone.className = 'gone';
          gone.textContent = '?';
          gone.title = 'this image is no longer on disk';
          strip.append(gone);
        }
      }
      card.append(strip);
    }

    // --- what the text encoder was actually handed ---------------------------
    // Node 181 "Save Text" sits on the same wire as the text encoder, so this is
    // the real prompt behind the images - not what we submitted. There is one per
    // run, because every time the enhancer refreshes it re-words differently, so
    // a batch of six can legitimately come back six ways. Outer box = all of
    // them, inner box = one run's wording.
    const captures = entry.promptTexts ?? [];
    if (captures.length) {
      const box = document.createElement('div');
      box.className = 'hrow-textbox';

      const bar = document.createElement('div');
      bar.className = 'hrow-textbar';

      const allRaw = captures.every((c) => c.source === 'raw');
      const tag = document.createElement('span');
      tag.className = allRaw ? 'chip warn' : 'chip on';
      tag.textContent = allRaw ? 'raw prompt (enhancer bypassed)' : 'captured prompts';
      bar.append(tag);

      const count = document.createElement('span');
      count.className = 'hrow-textcount';
      count.textContent = captures.length === 1 ? '1' : String(captures.length);
      count.title = `${captures.length} capture${captures.length > 1 ? 's' : ''}`;
      bar.append(count);

      const spacer = document.createElement('span');
      spacer.className = 'flex1';
      bar.append(spacer);

      const mkBtn = (label, title, fn, extraClass) => {
        const b = document.createElement('button');
        b.className = extraClass ? `mini ${extraClass}` : 'mini';
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.onclick = (ev) => { ev.stopPropagation(); fn(); };
        return b;
      };

      // One collapsible per capture, nested inside this one.
      const list = document.createElement('div');
      list.className = 'hrow-textlist';
      for (const cap of captures) {
        const sub = document.createElement('div');
        sub.className = 'hrow-sub';

        const subBar = document.createElement('div');
        subBar.className = 'hrow-subbar';

        const subTag = document.createElement('span');
        subTag.className = cap.source === 'raw' ? 'chip warn' : 'chip on';
        subTag.textContent = cap.source === 'raw' ? 'raw prompt' : 'enhanced prompt';
        subBar.append(subTag);

        const label = document.createElement('span');
        label.className = 'hrow-sublabel';
        label.textContent = cap.runIndex > 0 ? `run ${cap.runIndex + 1}` : 'run 1';
        if (cap.seed !== null && cap.seed !== undefined) {
          label.textContent += ` · seed ${cap.seed}`;
        }
        subBar.append(label);

        const subSpacer = document.createElement('span');
        subSpacer.className = 'flex1';
        subBar.append(subSpacer);

        const subBody = document.createElement('pre');
        subBody.className = 'hrow-text';
        subBody.textContent = cap.text;

        const subToggle = mkBtn('▾', 'show this prompt', () => {
          const open = sub.classList.toggle('open');
          subToggle.textContent = open ? '▴' : '▾';
          subBody.hidden = !open;
        }, 'hrow-caret');

        subBar.append(
          mkBtn('copy', 'copy to clipboard', async () => {
            toast(await copyText(cap.text) ? 'prompt copied' : 'copy blocked by the browser');
          }),
          mkBtn('use as prompt', 'put this in the prompt box and turn the enhancer off', () => {
            useEnhancedAsPrompt(cap.text);
          }),
          subToggle,
        );

        subBody.hidden = true;
        sub.append(subBar, subBody);
        list.append(sub);
      }

      const toggle = mkBtn('▾ show', 'expand the captured prompts', () => {
        const open = box.classList.toggle('open');
        toggle.textContent = open ? '▴ hide' : '▾ show';
        list.hidden = !open;
      }, 'hrow-toggle');

      bar.append(toggle);

      list.hidden = true;
      box.append(bar, list);
      card.append(box);
    }

    card.onclick = () => restoreHistory(entry);
    wrap.append(card);
  }
}

/**
 * Adopt the workflow's enhanced wording as the new raw prompt.
 *
 * This is the whole point of capturing it: re-wording is a lottery, so once a run
 * comes back with wording you like, the sane follow-up is to keep that exact text
 * and stop paying for the enhancer on every future run.
 */
function useEnhancedAsPrompt(text) {
  if (!text) return;
  const box = $('prompt');
  box.value = text;
  autoGrow(box);
  $('enhance').checked = false;
  saveForm();
  document.querySelector('.tabbtn[data-tab="generate"]').click();
  window.scrollTo(0, 0);
  toast('enhanced prompt loaded - enhancer turned off');
}

/**
 * Put a remembered prompt back on the Generate tab: text, every setting, and
 * the reference images. Reference images that were pruned from disk are
 * reported rather than dropped silently.
 */
function restoreHistory(entry) {
  const s = entry.settings ?? {};
  $('prompt').value = entry.prompt ?? '';
  if (s.megapixels) $('megapixels').value = s.megapixels;
  if (s.batch) $('batch').value = s.batch;
  if (s.shuffle) $('shuffle').value = s.shuffle;
  if (s.refresh) $('refresh').value = s.refresh;
  $('steps').value = s.stepsOverride ?? '';
  $('inputResolution').value = s.inputResolution ?? '';
  $('turbo').checked = s.turbo === true;
  $('collect').checked = s.collectImages !== false;
  $('enhance').checked = s.promptEnhance !== false;

  let restored = 0;
  let lost = 0;
  state.slots = [null, null, null, null];
  state.slotUrls = [null, null, null, null];
  for (const slot of entry.slots ?? []) {
    const i = restored + lost;
    if (i >= MAX_SLOTS) break;
    if (!slot) { state.slots[i] = null; continue; }
    if (!slot.available) { lost += 1; continue; }
    state.slots[i] = slot.kind === 'upload' ? { uploadId: slot.uploadId } : { ref: slot.ref };
    state.slotUrls[i] = slot.url;
    restored += 1;
  }
  renderSlots();
  updateRunMath();
  saveForm();
  showError(null);
  document.querySelector('.tabbtn[data-tab="generate"]').click();  // re-sizes the prompt box
  window.scrollTo(0, 0);
  toast(lost ? `loaded - ${lost} reference image(s) are gone` : 'loaded into Generate');
}

$('reloadHistory').onclick = loadHistory;
$('clearHistory').onclick = async () => {
  if (!confirm('Forget every remembered prompt? Images already generated stay on disk.')) return;
  await api('/api/history', { method: 'DELETE' });
  await loadHistory();
};

/* -------------------------------------------------------------- lightbox */
let lbList = [];
let lbIndex = 0;
let lbEntry = null;

// Zoom state. `transform` is translate(x, y) scale(s) about the image centre,
// so panning and pinch-zoom are two independent writes to the same string.
const lbZoom = { s: 1, x: 0, y: 0 };
const LB_MIN = 1;
const LB_MAX = 8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function applyZoom() {
  const img = $('lightboxImg');
  img.style.transform = `translate(${lbZoom.x}px, ${lbZoom.y}px) scale(${lbZoom.s})`;
  const at = lbZoom.s > 1.01;
  setDisabled('lbZoomOut', !at);
  setDisabled('lbZoomIn', lbZoom.s >= LB_MAX);
  setDisabled('lbReset', !at);
}

/** Keep the image from being flung off screen: at most half of the overflow. */
function clampPan() {
  if (lbZoom.s <= 1) { lbZoom.x = 0; lbZoom.y = 0; return; }
  const img = $('lightboxImg');
  // offsetWidth/Height ignore the transform, so this is the image's laid-out
  // size - the same as its container, because the grid stretches it to fill.
  const maxX = (img.offsetWidth * (lbZoom.s - 1)) / 2;
  const maxY = (img.offsetHeight * (lbZoom.s - 1)) / 2;
  lbZoom.x = clamp(lbZoom.x, -maxX, maxX);
  lbZoom.y = clamp(lbZoom.y, -maxY, maxY);
}

function setZoom(s, x = lbZoom.x, y = lbZoom.y) {
  lbZoom.s = clamp(s, LB_MIN, LB_MAX);
  lbZoom.x = x;
  lbZoom.y = y;
  clampPan();
  applyZoom();
}

function resetZoom() {
  lbZoom.s = 1;
  lbZoom.x = 0;
  lbZoom.y = 0;
  applyZoom();
}

// --- back button ----------------------------------------------------------
// On Android the hardware/gesture back would otherwise leave the page while the
// lightbox is open. Pushing a history entry per open makes the first back press
// pop it and close the overlay instead. `lbPushed` is the guard that stops the
// two paths fighting: a close-button press calls history.back(), and the
// resulting popstate must not try to close an already-closed lightbox.
let lbPushed = false;
function pushLightboxState() {
  if (lbPushed) return;              // paging must not stack entries
  lbPushed = true;
  try { history.pushState({ mcfyLb: true }, ''); } catch { lbPushed = false; }
}
function popLightboxState() {
  if (!lbPushed) return;
  lbPushed = false;                  // cleared first, so popstate no-ops
  try { history.back(); } catch { /* no history to pop */ }
}
window.addEventListener('popstate', () => {
  if (!lbPushed) return;
  lbPushed = false;
  if (!$('lightbox').hidden) closeLightbox();
});

function openLightbox(entry, list) {
  lbList = list?.length ? list : [entry];
  lbIndex = Math.max(0, lbList.findIndex((e) => e.id === entry.id));
  showLightbox();
}

function showLightbox() {
  const entry = lbList[lbIndex];
  lbEntry = entry ?? null;
  $('lightboxImg').src = lbEntry ? `/api/gallery/${lbEntry.id}/file` : '';
  $('lightbox').hidden = false;
  // The local download name is what the user can actually go and find in
  // ~/storage/downloads/mobile-cfy, so it beats ComfyUI's internal filename.
  setText('lbName', lbEntry ? (lbEntry.localName ?? lbEntry.comfyFilename ?? '') : '');
  $('lbCount').textContent = lbList.length > 1
    ? `${lbIndex + 1} / ${lbList.length}`
    : '';
  setDisabled('lbPrev', lbList.length < 2);
  setDisabled('lbNext', lbList.length < 2);
  resetZoom();
  pushLightboxState();
}

/** Step through the list. `dir` is -1 or 1; wrapping keeps it endless. */
function stepLightbox(dir) {
  if (lbList.length < 2) return;
  lbIndex = (lbIndex + dir + lbList.length) % lbList.length;
  showLightbox();
}

const closeLightbox = () => {
  $('lightbox').hidden = true;
  $('lightboxImg').src = '';
  setText('lbName', '');
  resetZoom();
  popLightboxState();
};
$('lbClose').onclick = closeLightbox;
$('lightbox').onclick = (e) => { if (e.target === $('lightbox')) closeLightbox(); };
$('lbPrev').onclick = () => stepLightbox(-1);
$('lbNext').onclick = () => stepLightbox(1);
on('lbZoomIn', () => setZoom(lbZoom.s * 1.5));
on('lbZoomOut', () => setZoom(lbZoom.s / 1.5));
on('lbReset', resetZoom);
on('lbUse', () => {
  useAsInput(lbEntry);
  closeLightbox();
  document.querySelector('.tabbtn[data-tab="generate"]').click();
});

document.addEventListener('keydown', (e) => {
  if ($('lightbox').hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') stepLightbox(-1);
  else if (e.key === 'ArrowRight') stepLightbox(1);
  else if (e.key === '+' || e.key === '=') setZoom(lbZoom.s * 1.5);
  else if (e.key === '-') setZoom(lbZoom.s / 1.5);
  else if (e.key === '0') resetZoom();
});

// --- pinch / drag / wheel ------------------------------------------------
// Pointer events cover touch, mouse and stylus in one path. Two live pointers
// means a pinch (scale by the ratio of finger distances, pan by the midpoint
// delta); one means a drag.
const lbImg = $('lightboxImg');
const pointers = new Map();
let pinch = null;   // { d, x, y } midpoint+distance from the previous move
let drag = null;    // { x, y } last position of the single tracked pointer
let swipe = null;   // { x, y, t } where a swipe would start, for step-on-swipe
let lastTap = 0;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

lbImg.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  lbImg.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  lbImg.classList.add('dragging');

  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: dist(a, b), ...mid(a, b) };
    drag = null;
    swipe = null;
  } else {
    drag = { x: e.clientX, y: e.clientY };
    // A swipe only makes sense on a fitted image; once zoomed, the same gesture
    // has to mean "pan" or it fights the user.
    swipe = lbZoom.s <= 1.01 ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
    // Double tap toggles between fit and a close look.
    const now = Date.now();
    if (now - lastTap < 300) {
      if (lbZoom.s > 1.01) resetZoom();
      else setZoom(2.5);
      lastTap = 0;
    } else {
      lastTap = now;
    }
  }
  e.preventDefault();
});

lbImg.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = dist(a, b);
    const m = mid(a, b);
    if (pinch && pinch.d > 0 && d > 0) {
      setZoom(lbZoom.s * (d / pinch.d), lbZoom.x + (m.x - pinch.x), lbZoom.y + (m.y - pinch.y));
    }
    pinch = { d, ...m };
  } else if (drag) {
    lbZoom.x += e.clientX - drag.x;
    lbZoom.y += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    clampPan();
    applyZoom();
  }
  e.preventDefault();
});

lbImg.addEventListener('pointerup', (e) => {
  if (swipe && pointers.size === 1) {
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - swipe.t < 600) {
      stepLightbox(dx < 0 ? 1 : -1);
    }
  }
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  // Lifting one finger off a pinch hands the remaining finger a clean drag
  // origin, instead of jumping by the distance it had already travelled.
  const rest = [...pointers.values()][0] ?? null;
  drag = rest ? { x: rest.x, y: rest.y } : null;
  if (pointers.size === 0) {
    swipe = null;
    lbImg.classList.remove('dragging');
  }
});
lbImg.addEventListener('pointercancel', (e) => {
  pointers.delete(e.pointerId);
  pinch = null;
  const rest = [...pointers.values()][0] ?? null;
  drag = rest ? { x: rest.x, y: rest.y } : null;
  if (pointers.size === 0) { swipe = null; lbImg.classList.remove('dragging'); }
});

// The browser's own double-tap-to-zoom would fight ours; the gesture is ours.
lbImg.addEventListener('dblclick', (e) => e.preventDefault());

lbImg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = lbImg.getBoundingClientRect();
  // The centre of the transformed image, so the cursor offset is in screen px.
  const cx = e.clientX - (rect.left + rect.width / 2);
  const cy = e.clientY - (rect.top + rect.height / 2);
  const next = clamp(lbZoom.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), LB_MIN, LB_MAX);
  const k = next / lbZoom.s;
  // Hold the point under the cursor still: x' = x + (x - cursorOffset) * (k - 1).
  setZoom(next, lbZoom.x + (lbZoom.x - cx) * (k - 1), lbZoom.y + (lbZoom.y - cy) * (k - 1));
}, { passive: false });

// ---------------------------------------------------------------- settings
async function loadSettings() {
  try {
    const body = await api('/api/config');
    state.cfg = body.config;
    $('cfgHost').value = body.config.comfy.host ?? '';
    $('cfgPort').value = body.config.comfy.port ?? '';
    $('cfgDl').value = body.config.downloadDir ?? '';
    $('cfgTpl').value = body.config.filenameTemplate ?? '';
    $('cfgNodes').value = (body.config.collectNodes ?? []).join(', ');
    $('cfgTextNodes').value = (body.config.promptTextNodes ?? []).join(', ');
    $('envNote').textContent = `token file: ${body.envFile}`;
    renderBindings(body.config.bindings ?? {});
  } catch (e) { toast(e.message); }
}

const BIND_LABELS = {
  promptEnhanced: 'Prompt (enhance on)',
  promptRaw: 'Prompt (enhance off)',
  enhanceSwitch: 'Enhance switch',
  imageCount: 'Image count',
  shuffleSwitch: 'Shuffle override',
  turboSwitch: 'Turbo switch',
  stepsTurbo: 'Steps (turbo)',
  stepsFull: 'Steps (full)',
  seed: 'Seed',
  megapixels: 'Megapixels',
  inputResolution: 'Encoder resolution',
  enhanceSeed: 'Enhancer seed',
  images: 'Reference images',
};

function renderBindings(bindings) {
  const wrap = $('bindings');
  wrap.innerHTML = '';
  const row = (label, value, key, slot) => {
    const d = document.createElement('div');
    d.className = 'bind';
    d.dataset.key = key;
    d.dataset.slot = slot ?? '';
    const l = document.createElement('label');
    l.textContent = label;
    const n = document.createElement('input');
    n.type = 'text';
    n.value = value?.node ?? '';
    n.placeholder = 'node';
    n.dataset.role = 'node';
    const i = document.createElement('input');
    i.type = 'text';
    i.value = value?.input ?? '';
    i.placeholder = 'input';
    i.dataset.role = 'input';
    d.append(l, n, i);

    const title = state.bindingTitles.get(`${key}${slot ?? ''}`);
    if (title) {
      const t = document.createElement('div');
      t.className = 'bind-title';
      t.innerHTML = `<span class="ok">✓</span> <b>${escapeHtml(title.title ?? '')}</b> ${escapeHtml(title.classType ?? '')}`;
      d.append(t);
    }
    wrap.append(d);
    return d;
  };

  for (const [key, value] of Object.entries(bindings)) {
    if (key === 'images') {
      (value ?? []).forEach((b, i) => row(`Reference ${i + 1}`, b, key, i + 1));
    } else {
      row(BIND_LABELS[key] ?? key, value, key, null);
    }
  }
}

function collectBindings() {
  const out = {};
  const images = [];
  for (const el of document.querySelectorAll('#bindings .bind')) {
    const key = el.dataset.key;
    const slot = el.dataset.slot;
    const node = el.querySelector('[data-role=node]').value.trim();
    const input = el.querySelector('[data-role=input]').value.trim();
    const value = { node, input };
    if (key === 'images') images[Number(slot) - 1] = value;
    else out[key] = value;
  }
  if (images.length) out.images = images;
  return out;
}

$('saveBindings').onclick = async () => {
  $('bindMsg').textContent = 'saving…';
  try {
    const body = await api('/api/config', { method: 'PUT', body: JSON.stringify({ bindings: collectBindings() }) });
    state.cfg = body.config;
    $('bindMsg').textContent = 'saved';
    await checkBindings();
  } catch (e) { $('bindMsg').textContent = e.message; }
};

$('checkBindings').onclick = checkBindings;

async function checkBindings() {
  const msg = $('bindMsg');
  msg.textContent = 'checking…';
  try {
    const { bindings, ok } = await api('/api/config/validate', { method: 'POST' });
    state.bindingTitles = new Map();
    let bad = 0;
    for (const r of bindings) {
      state.bindingTitles.set(`${r.binding}${r.slot ?? ''}`, { title: r.title, classType: r.classType });
      if (!r.ok) bad++;
    }
    for (const el of document.querySelectorAll('#bindings .bind')) {
      const key = el.dataset.key;
      const slot = el.dataset.slot === '' ? null : Number(el.dataset.slot);
      const rec = bindings.find((b) => b.binding === key && (b.slot ?? null) === slot);
      el.classList.toggle('bad', !!rec && !rec.ok);
      let mark = el.querySelector('.bind-title');
      if (!mark) {
        mark = document.createElement('div');
        mark.className = 'bind-title';
        el.append(mark);
      }
      if (!rec || rec.disabled) mark.innerHTML = '<span class="ok">–</span> <b>disabled</b>';
      else if (rec.ok) mark.innerHTML = `<span class="ok">✓</span> <b>${escapeHtml(rec.title ?? '')}</b> ${escapeHtml(rec.classType ?? '')}`;
      else mark.innerHTML = `<span class="no">✗</span> <b>${escapeHtml(rec.reason ?? '')}</b>`;
    }
    msg.textContent = ok ? 'all bindings ok' : `${bad} problem(s)`;
    if (state.cfg) renderBindings(state.cfg.bindings);
  } catch (e) { msg.textContent = e.message; }
}

$('saveConfig').onclick = async () => {
  const msg = $('cfgMsg');
  msg.textContent = 'saving…';
  const patch = {
    comfy: {
      host: $('cfgHost').value.trim(),
      port: Number($('cfgPort').value) || 8188,
    },
    downloadDir: $('cfgDl').value.trim(),
    filenameTemplate: $('cfgTpl').value.trim(),
    collectNodes: $('cfgNodes').value.split(',').map((s) => s.trim()).filter(Boolean),
    promptTextNodes: $('cfgTextNodes').value.split(',').map((s) => s.trim()).filter(Boolean),
  };
  try {
    const body = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
    state.cfg = body.config;
    msg.textContent = 'saved · download folder now ' + body.resolved.downloadDir;
  } catch (e) { msg.textContent = e.message; }
};

$('checkPath').onclick = async () => {
  const out = $('pathResult');
  try {
    const r = await api('/api/paths/check', { method: 'POST', body: JSON.stringify({ dir: $('cfgDl').value.trim() }) });
    if (!r.exists) out.textContent = 'missing - it will be created on first download';
    else if (!r.writable) out.textContent = 'exists but not writable (check termux-setup-storage)';
    else out.textContent = `writable${r.isSharedStorage ? ' · shared storage' : ''}`;
  } catch (e) { out.textContent = e.message; }
};

$('reloadToken').onclick = async () => {
  try {
    const r = await api('/api/auth/reload', { method: 'POST' });
    toast(r.tokenConfigured ? 'token reloaded' : 'no token found in ' + r.file);
    await refreshHealth();
  } catch (e) { toast(e.message); }
};

$('wfUpload').onchange = async () => {
  const file = $('wfUpload').files[0];
  if (!file) return;
  try {
    const workflow = JSON.parse(await file.text());
    const r = await api('/api/workflow', { method: 'PUT', body: JSON.stringify({ workflow }) });
    $('wfMsg').textContent = `saved ${r.nodes} nodes`;
    renderNodeList(workflow);
    await checkBindings();
  } catch (e) { $('wfMsg').textContent = e.message; }
};

function renderNodeList(wf) {
  const ul = $('nodeList');
  ul.innerHTML = '';
  const rows = Object.entries(wf).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [id, node] of rows) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.textContent = id;
    const b = document.createElement('span');
    b.textContent = `${node._meta?.title ?? ''} · ${node.class_type ?? ''}`;
    li.append(a, b);
    ul.append(li);
  }
}

// -------------------------------------------------------------------- util
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function truncate(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

// -------------------------------------------------------------------- boot
loadCollapsed();
// Applied synchronously, before the config fetch, so the form never flashes the
// HTML defaults and then jumps to what the user actually left set.
const hadSavedForm = restoreForm();
renderSlots();
updateRunMath();
autoGrow($('prompt'));
renderQueue();
refreshHealth();
connectEvents();
setInterval(refreshHealth, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refreshHealth();
  // A stream that died while the phone slept reopens on wake.
  if (!state.es) connectEvents();
  else loadGallery();
});

(async () => {
  try {
    // The user's own remembered settings beat the server defaults - config.json
    // is the fallback for a first run, not something that overwrites a choice
    // the user has already made on this device.
    if (hadSavedForm) return;
    const { defaults } = await api('/api/config');
    const d = defaults?.defaults ?? {};
    if (d.megapixels) $('megapixels').value = d.megapixels;
    $('enhance').checked = d.promptEnhance !== false;
    if (d.batch) $('batch').value = d.batch;
    if (d.shuffle) $('shuffle').value = d.shuffle;
    if (d.shuffleRefresh) $('refresh').value = d.shuffleRefresh;
    if (d.inputResolution) $('inputResolution').value = d.inputResolution;
    updateRunMath();
  } catch { /* the server may still be booting */ }
})();