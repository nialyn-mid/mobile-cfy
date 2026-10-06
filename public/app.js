// mobile-cfy web UI. No framework, no build step - the server is plain Node.

import { bindingMark } from './bindmark.js';
import { durationBetween } from './durfmt.js';
import { zoomAboutPoint } from './zoommath.js';
import { describeUpscaleSize, planUpscaleSize, warnUpscaleSize } from './upmath.js';

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
    e.bindings = body?.bindings;
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
  // The queue's own state: paused, why, and how many prompts are sitting in
  // ComfyUI waiting to be watched. Kept apart from the jobs because a paused
  // queue changes no job at all - only the button and the banner care.
  queue: { paused: false, reason: null, waiting: 0, running: 0, submitted: 0 },
  es: null,
  gallery: [],
  galleryLoaded: false,          // the gallery is only read when its tab is opened
  history: [],
  collapsed: new Set(),          // gallery job ids folded away, from localStorage
  bindingTitles: new Map(),
  // The Upscale tab has one image of its own: the upscale workflow has a single
  // LoadImage, so sharing the four generate slots would mean picking which job a
  // picture belongs to.
  upImage: null,                  // null | { uploadId } | { ref }
  upImageUrl: null,
  // The picked image's own pixel size, read off the thumbnail the browser has
  // already decoded. null until it has loaded - which is why the note under the
  // image fills in a moment after the image appears rather than with it.
  upDims: null,
  // The last GET /api/health answer. Kept so the Settings tab can print the
  // whole report - state, address, the server's own error text and the hint -
  // instead of leaving it in a tooltip nobody on a phone will ever see.
  health: null,
  // The savedAt of the queue recovery this page has already announced. Not
  // persisted: a fresh page load is entitled to say it once, and a page left
  // open overnight is not entitled to say it again in the morning.
  restoredShown: null,
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

let resumeOffered = false;

async function refreshHealth() {
  const dot = $('healthDot');
  const text = $('healthText');
  try {
    const h = await api('/api/health');
    const c = h.comfy;
    state.health = c;
    if (h.queue) applyQueue(h.queue);
    if (c.state === 'ok') {
      // ComfyUI answers again while a queue is still held for the network. Say
      // so once - the resume stays a deliberate tap, because building a queue
      // offline is a normal thing to do here and a health blip should not
      // quietly start four generations.
      if (state.queue?.paused && state.queue.reason === 'connection') {
        dot.className = 'dot warn';
        text.textContent = 'back online';
        if (!resumeOffered) {
          resumeOffered = true;
          toast('ComfyUI is back — press resume');
        }
      } else {
        dot.className = 'dot ok';
        text.textContent = `ComfyUI ${h.comfy.info?.comfyui_version ?? ''}`.trim();
      }
    } else if (c.state === 'unauthorized') {
      dot.className = 'dot bad';
      text.textContent = 'auth failed';
    } else if (c.state === 'no-token') {
      dot.className = 'dot bad';
      text.textContent = 'no token';
    } else {
      dot.className = 'dot warn';
      // The classifier's own word, not a vague one: "not comfyui" and
      // "bad address" send you to the right box, "unreachable" sends you to
      // the router.
      text.textContent = c.state;
    }
    $('healthBtn').title = c.error || c.problem || `${c.host}:${c.port}`;
    renderHealthDetail();
  } catch (e) {
    dot.className = 'dot bad';
    text.textContent = stopping ? 'server stopped' : 'server offline';
  }
}

/**
 * The whole "what did the server see" report, in the open.
 *
 * The error used to live only in the dot's `title` attribute, which no phone
 * ever shows and no thumb can hover. Every one of these faults is a settings
 * problem, and the Settings tab is where settings live - so the detail belongs
 * there, written out, copyable, next to the two boxes that cause most of them.
 */
function healthReportText() {
  const c = state.health;
  if (!c) return 'not checked yet';
  const bits = [`${c.host ?? '?'}:${c.port ?? '?'} — ${c.state}`];
  if (c.state === 'ok') {
    const i = c.info ?? {};
    bits.push(`ComfyUI ${i.comfyui ?? '?'}${i.devices?.length ? ` on ${i.devices.join(', ')}` : ''}`);
  }
  if (c.problem) bits.push(c.problem);
  if (c.error) bits.push(c.error);
  if (c.hint) bits.push(c.hint);
  bits.push(`checked ${new Date(c.checkedAt ?? Date.now()).toLocaleTimeString()}`);
  return bits.join('\n');
}

function renderHealthDetail() {
  const el = $('healthDetail');
  if (!el) return;
  const c = state.health;
  el.textContent = healthReportText();
  // A wrong box is worth shouting about; an idle server is not.
  el.classList.toggle('bad', Boolean(c) && c.state !== 'ok');
  el.classList.toggle('warn', Boolean(c) && c.state === 'ok');
}

// -------------------------------------------------------------------- tabs
for (const btn of document.querySelectorAll('.tabbtn')) {
  btn.onclick = () => {
    document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b === btn));
    const name = btn.dataset.tab;
    // A section may declare `data-for="a b"` to be SHARED: the queue strip and
    // the job panel belong to Generate and Upscale alike, and they cannot simply
    // be duplicated because element ids must stay unique. So they live in one
    // section that opens on whichever of the named tabs was pressed.
    for (const t of document.querySelectorAll('.tab')) {
      const names = (t.dataset.for ?? '').split(/\s+/).filter(Boolean);
      t.classList.toggle('active', names.length ? names.includes(name) : t.id === `tab-${name}`);
    }
    if (name === 'gallery') loadGallery();
    if (name === 'history') loadHistory();
    if (name === 'settings') loadSettings();
    // A hidden textarea has no scrollHeight, so the box can only be measured
    // once its tab is actually on screen.
    if (name === 'generate') { autoGrow($('prompt')); autoGrow($('postprompt')); }
    if (name === 'upscale') autoGrow($('upGuidance'));
    window.scrollTo(0, 0);
  };
}

/** Open a tab by name (used when a gallery or history action lands elsewhere). */
function showTab(name) {
  const btn = [...document.querySelectorAll('.tabbtn')].find((b) => b.dataset.tab === name);
  if (btn) btn.click();
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
$('postprompt').addEventListener('input', () => autoGrow($('postprompt')));
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
  // Reference images no longer bypass the enhancer: node 226 reads the images
  // itself, so an image job is enhanced like any other. The only thing the
  // enhancer switches off is the suggested aspect, and syncAspectUi owns that.
  const hasImages = state.slots.filter(Boolean).length;
  $('enhanceHint').textContent = hasImages
    ? 'reads the reference images too'
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

// ------------------------------------------------------------ upscale tab
/** Which tab is on screen - the queue is shared, the forms are not. */
function isTab(name) {
  return document.querySelector('section.tab.active')?.id === `tab-${name}`;
}

function renderUpSlot() {
  const wrap = $('upSlot');
  wrap.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'slot' + (state.upImage ? ' filled' : '');
  if (state.upImage) {
    const url = state.upImageUrl;
    const img = document.createElement('img');
    img.alt = 'image to upscale';
    // The browser has to decode this image to show it anyway, and the decoded
    // size is the answer to "how big is the thing I picked" - so no second
    // request and no server-side header parsing, for uploads and gallery picks
    // alike. The handler is attached BEFORE src: a cached image can finish
    // loading before the next line runs.
    img.onload = () => {
      if (state.upImageUrl !== url) return; // a different image won the race
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      state.upDims = w > 0 && h > 0 ? { width: w, height: h } : null;
      // Deliberately not renderUpSlot() here: that would build another <img>,
      // which would load again, which would call this again.
      updateUpMath();
    };
    img.onerror = () => {
      if (state.upImageUrl !== url) return;
      // A gallery entry whose download never landed has no bytes to measure.
      // Saying nothing beats printing a size that was never read.
      state.upDims = null;
      updateUpMath();
    };
    img.src = url;
    d.append(img);
    const x = document.createElement('button');
    x.className = 'x';
    x.type = 'button';
    x.textContent = '×';
    x.onclick = (ev) => { ev.stopPropagation(); setUpImage(null); };
    d.append(x);
  } else {
    d.textContent = '+';
    d.onclick = () => { $('upFilePick').value = ''; $('upFilePick').click(); };
  }
  wrap.append(d);
  updateUpMath();
}

function setUpImage(value, url) {
  state.upImage = value ?? null;
  state.upImageUrl = value ? url : null;
  // The old size belongs to the old picture. Leaving it up would print one
  // image's dimensions under another's thumbnail for as long as the tab stayed
  // open - and the next upscale would be aimed at the wrong size.
  state.upDims = null;
  renderUpSlot();
}

/** The gallery entry the upscale will load, as the value the server expects. */
function useAsUpInput(entry) {
  setUpImage({ ref: entry.id }, `/api/gallery/${entry.id}/file`);
  toast(`${entry.localName || entry.comfyFilename || 'image'} ready to upscale`);
}

// The event helpers take the id and the handler only; anything but a click uses
// addEventListener, which is safe on a missing element on its own.
const listen = (id, type, fn) => $(id)?.addEventListener(type, fn);

on('upClear', () => setUpImage(null));

listen('upFilePick', 'change', async () => {
  const file = $('upFilePick').files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file, file.name);
  try {
    const { uploads } = await api('/api/uploads', { method: 'POST', body: fd });
    if (!uploads.length) return;
    setUpImage({ uploadId: uploads[0].id }, `/api/uploads/${uploads[0].id}`);
    toast('image ready to upscale');
  } catch (e) {
    toast(e.message);
  }
});

// drag & drop straight onto the upscale slot
$('upSlot').addEventListener('dragover', (e) => e.preventDefault());
$('upSlot').addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file, file.name);
  try {
    const { uploads } = await api('/api/uploads', { method: 'POST', body: fd });
    setUpImage({ uploadId: uploads[0].id }, `/api/uploads/${uploads[0].id}`);
  } catch (err) { toast(err.message); }
});

// A grid of recent images, because the usual case is "upscale the one I just
// made" and picking a file from the phone's storage manager is much more work.
on('upPickGallery', async () => {
  try {
    if (!state.galleryLoaded) await loadGallery();
  } catch { /* loadGallery already told the user */ }
  const list = $('pickList');
  list.innerHTML = '';
  const images = (state.gallery ?? []).slice(0, 36);
  if (!images.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'the gallery is empty';
    list.append(p);
  }
  for (const entry of images) {
    const b = document.createElement('button');
    b.className = 'pickbtn';
    b.type = 'button';
    b.title = entry.localName || entry.comfyFilename || 'image';
    const img = document.createElement('img');
    img.src = `/api/gallery/${entry.id}/file`;
    img.alt = b.title;
    img.loading = 'lazy';
    b.append(img);
    b.onclick = () => {
      useAsUpInput(entry);
      closePickModal();
    };
    list.append(b);
  }
  setHidden('pickModal', false);
});

function closePickModal() {
  setHidden('pickModal', true);
  $('pickList').innerHTML = '';
}
on('pickCancel', closePickModal);

// Pasting a screenshot works on whichever tab asks for it.
window.addEventListener('paste', (e) => {
  if (e.defaultPrevented) return;
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  const file = item.getAsFile();
  const fd = new FormData();
  fd.append('file', file, 'pasted.png');
  e.preventDefault();
  api('/api/uploads', { method: 'POST', body: fd }).then(({ uploads }) => {
    if (isTab('upscale')) {
      setUpImage({ uploadId: uploads[0].id }, `/api/uploads/${uploads[0].id}`);
      toast('pasted image ready to upscale');
      return;
    }
    const slot = state.slots.findIndex((s) => !s);
    if (slot !== -1) setSlot(slot, { uploadId: uploads[0].id }, `/api/uploads/${uploads[0].id}`);
    toast('pasted image attached');
  }).catch((err) => toast(err.message));
});

/**
 * The Size card's two states. With the switch off the target numbers are dead
 * weight - the workflow never reads them - so they are disabled rather than
 * quietly ignored.
 */
function syncUpUi() {
  const toDim = $('upScaleToDim').checked;
  for (const id of ['upTargetWidth', 'upTargetHeight']) setDisabled(id, !toDim);
  setDisabled('upScale', toDim);
  updateUpMath();
}

/** What the workflow will actually do, in one line under the inputs. */
function updateUpMath() {
  const scale = parseFloat($('upScale').value);
  const w = parseInt($('upTargetWidth').value, 10);
  const h = parseInt($('upTargetHeight').value, 10);
  const toDim = $('upScaleToDim').checked;
  const seedRaw = $('upSeed').value.trim();
  const batch = parseInt($('upBatch').value, 10);
  const n = Number.isInteger(batch) && batch > 1 ? batch : 1;
  const bits = [];
  if (!state.upImage) bits.push('pick an image first');
  if (toDim && Number.isFinite(w) && Number.isFinite(h)) {
    // The graph multiplies BOTH sides by one factor k = min(4, sqrt(targetW*targetH/(W*H))),
    // so the result has the box's AREA and the source's shape. It does NOT fit
    // inside the box - it can come out wider or taller than the box on one side.
    bits.push(`the box's ${w} × ${h} worth of pixels, in the original's shape, never more than 4× a side`);
  } else if (Number.isFinite(scale) && scale > 0) {
    bits.push(`each side ×${trimNum(scale)}`);
  }
  if (seedRaw) bits.push(`seed ${seedRaw} pinned`);
  if (n > 1) bits.push(`${n} images from one pass`);
  const out = [];
  out.push(bits.join(' · ') || 'one image in, one image out');
  if (toDim && Number.isFinite(w) && Number.isFinite(h)) {
    out.push('A multiplier of ' + trimNum(scale) + ' is not used while the target size is on.');
  }
  if (n > 1) {
    out.push(`The ${n} are sampled together, so the noise is different for each - but they all sit in memory at the target size at once, so a big size and a big batch together can run the card out of memory.`);
  }
  setText('upMath', out.join(' '));

  // The numbers themselves, now that the source size is known. Under the
  // thumbnail rather than folded into the sentence above, because it is the one
  // thing on this tab that changes the moment a different picture is picked.
  const note = describeUpscaleSize(state.upDims, { scale, toDim, targetWidth: w, targetHeight: h });
  setText('upSlotNote', note);
  setHidden('upSlotNote', !note);

  // ...and a result nobody can be sure will fit, said plainly rather than left
  // to be discovered twenty minutes into a run.
  const plan = state.upDims
    ? planUpscaleSize(state.upDims.width, state.upDims.height, { scale, toDim, targetWidth: w, targetHeight: h })
    : null;
  const warn = warnUpscaleSize(plan);
  setText('upSizeNote', warn);
  setHidden('upSizeNote', !warn);
}

function trimNum(n) {
  return String(Number(Number(n).toFixed(2)));
}

for (const id of ['upScale', 'upTargetWidth', 'upTargetHeight', 'upSeed', 'upBatch']) {
  $(id).addEventListener('input', updateUpMath);
  $(id).addEventListener('change', updateUpMath);
}
$('upScaleToDim').addEventListener('change', syncUpUi);

on('helpUpScale', (e) => {
  e.preventDefault();
  toast('each side of the image is multiplied by this - 2 means a 1000px image comes back at 2000px');
});
on('helpUpW', (e) => {
  e.preventDefault();
  toast('the workflow scales by ONE factor until the picture has this many pixels, so the shape never changes');
});
on('helpUpGuidance', (e) => {
  e.preventDefault();
  toast('appended after the workflow\'s own instruction - "keep it a pencil drawing", "no added detail" and so on');
});
on('helpUpSeed', (e) => {
  e.preventDefault();
  toast('blank picks a fresh seed - pin one to get the same upscale again');
});
on('helpUpBatch', (e) => {
  e.preventDefault();
  toast('how many images one pass produces - the graph samples them together, so 4 costs about the same wall clock as 1 but four times the VRAM at the target size');
});

on('upscale', async () => {
  showError(null);
  setDisabled('upscale', true);
  const seedRaw = $('upSeed').value.trim();
  try {
    const job = await api('/api/upscale', {
      method: 'POST',
      body: JSON.stringify({
        slots: state.upImage ? [state.upImage] : [],
        scale: $('upScale').value === '' ? null : parseFloat($('upScale').value),
        scaleToDim: $('upScaleToDim').checked,
        targetWidth: $('upTargetWidth').value === '' ? null : parseInt($('upTargetWidth').value, 10),
        targetHeight: $('upTargetHeight').value === '' ? null : parseInt($('upTargetHeight').value, 10),
        guidance: $('upGuidance').value.trim(),
        // The string goes up untouched so the server can refuse junk with a real
        // message, instead of this page quietly rounding it into a number.
        seed: seedRaw === '' ? null : seedRaw,
        batch: $('upBatch').value,
        collectImages: $('upDownload').checked,
      }),
    });
    trackJob(job);
    // The same rule as the Generate tab, one field over: clear what belongs to
    // THIS job, keep the settings. The picture is the upscale's prompt - the
    // thing being worked on - so it must not still be armed when the next one
    // is submitted, and the guidance is a note about that same picture. The
    // scale, the target size, the batch and the download toggle are settings:
    // upscaling the next photo at the same settings is the whole point.
    const cleared = [];
    if (state.upImage) {
      setUpImage(null);
      cleared.push('image');
    }
    if ($('upGuidance').value.trim() !== '') {
      $('upGuidance').value = '';
      autoGrow($('upGuidance'));
      cleared.push('guidance');
    }
    saveForm();
    if (cleared.length) toast(`${cleared.join(' and ')} cleared`);
  } catch (e) {
    if (!showBindingError(e)) showError(e.errors ? e.errors.join('\n') : e.message);
  } finally {
    setDisabled('upscale', false);
  }
});

$('helpRefresh').onclick = (e) => {
  e.preventDefault();
  toast("'Once per group' throws the override switch on run 1 only, so the workflow enhances the prompt once and every later image varies by seed. 'Every run' re-enhances each time - slower, but each image gets its own wording.");
};

$('helpResolution').onclick = (e) => {
  e.preventDefault();
  toast('Pixel size fed to the Qwen text encoder (workflow node 204), not the final image size - that stays on Megapixels. Blank leaves the workflow at its own default of 1024. Raising it can help the encoder read fine detail in reference images; it costs VRAM and time.');
};

$('helpPostprompt').onclick = (e) => {
  e.preventDefault();
  toast('Joined onto your prompt by the workflow with no space between, AFTER the enhancer has run (node 257), so it reaches the model as part of the prompt and shows up in the saved prompt text. Blank leaves the workflow at its own value. Start it with a blank line if you want it on its own line.');
};

$('helpAspect').onclick = (e) => {
  e.preventDefault();
  toast('The prompt enhancer returns an aspect ratio of its own. Turn this on to use it - it needs Prompt enhance, because without the enhancer there is nothing to suggest. Turned off, the dropdown below is what node 9 uses.');
};

$('helpSeed').onclick = (e) => {
  e.preventDefault();
  toast('Blank = a fresh random seed for every run. Type a number to pin it: every run of that job then uses that exact seed, so the same prompt gives you the same image again. The History tab lists the seeds each prompt actually used, and copies them to the clipboard.');
};

// A pinned seed with more than one run means the same seed twice, so the runs
// are only different images if the prompt itself changes (the enhancer
// re-wording, or a different reference image). Say so instead of quietly
// producing N copies of one picture.
function syncSeedUi() {
  const raw = $('seed').value.trim();
  const note = $('seedNote');
  const pinned = raw !== '';
  const runs = Math.max(1, parseInt($('batch').value, 10) || 1) * Math.max(1, parseInt($('shuffle').value, 10) || 1);
  note.hidden = !(pinned && runs > 1);
  if (!note.hidden) {
    note.textContent = `seed ${raw} is pinned - all ${runs} run(s) use it, so runs with the same prompt give the same image`;
  }
}
$('seed').addEventListener('input', () => { syncSeedUi(); updateRunMath(); });
$('seed').addEventListener('change', syncSeedUi);

// The aspect dropdown only has meaning when the enhancer is NOT choosing.
// Node 233 is forced off without the enhancer server-side too; hiding it here
// keeps the page from showing a switch that would quietly do nothing.
function syncAspectUi() {
  const suggested = $('useSuggestedAspect').checked;
  const available = suggested && $('enhance').checked;
  $('aspectField').hidden = available;
  $('useSuggestedAspect').disabled = !$('enhance').checked;
  $('aspectHint').textContent = !$('enhance').checked
    ? 'needs Prompt enhance'
    : suggested ? 'the enhancer picks the shape' : 'off - the dropdown below is used';
  if ($('useSuggestedAspect').disabled) $('useSuggestedAspect').checked = false;
}
$('useSuggestedAspect').addEventListener('change', () => { syncAspectUi(); updateRunMath(); });
$('enhance').addEventListener('change', () => { syncAspectUi(); syncEnhanceHint(); updateRunMath(); });

// -------------------------------------------------------------- run summary
function updateRunMath() {
  const batch = Math.max(1, parseInt($('batch').value, 10) || 1);
  const shuffle = Math.max(1, parseInt($('shuffle').value, 10) || 1);
  const count = state.slots.filter(Boolean).length;
  const parts = [`${batch * shuffle} run(s)`];
  const shape = $('useSuggestedAspect').checked && $('enhance').checked
    ? 'enhancer picks the aspect'
    : $('aspectRatio').value.split(' ')[0];
  parts.push(shape);
  if ($('consistency').checked) parts.push('consistency LoRA');
  const seedRaw = $('seed').value.trim();
  if (seedRaw) parts.push(`seed ${seedRaw} pinned`);
  if (count) {
    parts.push(`${count} reference image(s) fed to the enhancer`);
  } else {
    // Node 68 decides whether the workflow re-enhances or reuses its memorised
    // prompt, so the wording of every image depends on this, not just the seed.
    parts.push($('refresh').value === 'everyRun'
      ? 're-enhance the prompt every run'
      : seedRaw
        // With a pinned seed there are no fresh seeds per group to talk about.
        ? `prompt enhanced once per group, every run on seed ${seedRaw}`
        : `${batch} seed(s) per group, prompt enhanced once`);
  }
  $('runMath').textContent = parts.join(' · ');
}
for (const id of ['batch', 'shuffle', 'refresh', 'aspectRatio', 'consistency', 'seed']) $(id).addEventListener('input', updateRunMath);
for (const id of ['batch', 'shuffle', 'refresh', 'aspectRatio', 'consistency', 'seed']) $(id).addEventListener('change', updateRunMath);
// The pinned-seed warning depends on how many runs the job will make, so it has
// to follow Batch and Shuffle as well as the Seed box itself.
for (const id of ['batch', 'shuffle']) {
  $(id).addEventListener('input', syncSeedUi);
  $(id).addEventListener('change', syncSeedUi);
}

// ---------------------------------------------------------- remembered form
// Toggles and run settings survive a reload. The prompt itself does NOT - that
// is what the History tab is for, and silently restoring a stale prompt would
// be worse than an empty box. Reference images are not remembered either: the
// uploads they point at are one-shot handles from a previous session. The SEED is
// not remembered for the same reason as the prompt, one step harder: a pinned
// seed that survived a reload would re-apply itself to the next, unrelated
// prompt. History restores it, because tapping an entry means "run this again".
const FORM_KEY = 'mcfy.form.v1';
const FORM_IDS = [
  'enhance', 'turbo', 'consistency', 'collect', 'steps', 'inputResolution',
  'megapixels', 'batch', 'shuffle', 'refresh', 'useSuggestedAspect', 'aspectRatio',
  // The postprompt is deliberately NOT remembered: it is text that belongs to one
  // prompt, and a page reload is not a request to run an old idea again. History
  // brings it back, because tapping an entry means "run this again".
  //
  // The upscale tab's settings live in the same stored form, and deliberately
  // leave out the same things: the seed and the guidance belong to one image, and
  // a pinned seed that survives a reload would quietly re-use itself on the next
  // picture.
  'upScale', 'upScaleToDim', 'upTargetWidth', 'upTargetHeight', 'upDownload', 'upBatch',
];

// The workflow's own combo values for node 9 "Resolution Selector". A COMBO
// rejects anything else by falling back to its first entry, so this list is the
// only place the page invents text for it.
const ASPECT_RATIOS = [
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
];
{
  const sel = $('aspectRatio');
  sel.innerHTML = ASPECT_RATIOS.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
}

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
  const seedRaw = $('seed').value.trim();
  const body = {
    prompt,
    // Sent verbatim, whitespace and leading newlines included: the workflow
    // concatenates this onto the prompt with no delimiter, so the text the user
    // typed is the text the model reads.
    postprompt: $('postprompt').value,
    megapixels: parseFloat($('megapixels').value) || undefined,
    batch: parseInt($('batch').value, 10) || undefined,
    shuffle: parseInt($('shuffle').value, 10) || undefined,
    promptEnhance: $('enhance').checked,
    turbo: $('turbo').checked,
    consistency: $('consistency').checked,
    collectImages: $('collect').checked,
    stepsOverride: stepsRaw === '' ? null : parseInt(stepsRaw, 10),
    inputResolution: resRaw === '' ? null : parseInt(resRaw, 10),
    // The string goes up untouched so the server can reject junk with a real
    // message, instead of this page quietly rounding it into a number.
    seed: seedRaw === '' ? null : seedRaw,
    useSuggestedAspect: $('useSuggestedAspect').checked,
    aspectRatio: $('aspectRatio').value,
    refresh: $('refresh').value,
    slots: state.slots,
  };

  try {
    const job = await api('/api/generate', { method: 'POST', body: JSON.stringify(body) });
    trackJob(job);
    // Clear the prompt, never the settings - queueing four variations of the
    // same idea should not mean retyping megapixels four times. References and
    // the postprompt are the exception: both belong to the prompt that was just
    // submitted, and leaving them armed would silently change the *next* one.
    const cleared = [];
    $('prompt').value = '';
    autoGrow($('prompt'));
    if ($('postprompt').value.trim() !== '') {
      $('postprompt').value = '';
      autoGrow($('postprompt'));
      cleared.push('postprompt');
    }
    if (state.slots.some(Boolean)) {
      clearSlots();
      cleared.push('references');
    }
    saveForm();
    // Let go of the prompt box. Refocusing it (or simply leaving it focused)
    // threw the on-screen keyboard straight back up over the queue and the job
    // that was just submitted, and this app is mostly used one-handed while
    // something is generating - the next prompt can wait for a scroll-up.
    if (document.activeElement === $('prompt')) $('prompt').blur();
    if (cleared.length) toast(`${cleared.join(' and ')} cleared`);
  } catch (e) {
    if (!showBindingError(e)) showError(e.errors ? e.errors.join('\n') : e.message);
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
    // A shutdown in progress is the other reason the stream ends, and there is
    // nothing left to reconnect to.
    if (stopping) return;
    setTimeout(connectEvents, 4000);
    pollJobs();
  };
}

function onJobUpdate(snap) {
  // Queue messages share this stream and carry no job id - they are about the
  // queue itself (paused, resumed, something handed to ComfyUI).
  if (snap?.type === 'queue') {
    applyQueue(snap.queue);
    return;
  }
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

/** Running first, then paused (it owns the connection problem), then queued. */
function pickActive() {
  const all = [...state.jobs.values()];
  return (
    all.find((j) => j.status === 'running')
    ?? all.find((j) => j.status === 'paused')
    ?? all.find((j) => j.status === 'queued')
    ?? all.slice().reverse().find((j) => ['done', 'error', 'cancelled'].includes(j.status))
    ?? null
  );
}

const inFlight = (j) => j.status === 'queued' || j.status === 'running' || j.status === 'paused';

/** Runs waiting in ComfyUI that nobody is watching yet. */
const unsubmitted = (j) => j.runs?.some((r) => !r.promptId && ['pending', 'queued'].includes(r.status));

function renderQueue() {
  const wrap = $('queueList');
  const jobs = [...state.jobs.values()];
  const busy = jobs.filter(inFlight);
  const rows = busy.slice();
  const q = state.queue ?? {};
  const paused = q.paused === true;
  // How many runs could still be handed over: the running job's tail plus
  // everything queued behind it.
  const handoff = jobs.filter((j) => inFlight(j) && unsubmitted(j)).length;

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
    dot.textContent =
      j.status === 'running' ? '▶' : finished ? '✓' : j.status === 'paused' ? '⏸' : '⏳';
    const text = document.createElement('span');
    text.className = 'qtext';
    // One queue holds both kinds of work, so a row says which it is: an upscale
    // has no prompt, and its label is built from the image and the scale.
    text.textContent = (j.kind === 'upscale' || j.spec?.kind === 'upscale' ? '⤒ ' : '')
      + truncate(j.spec?.prompt ?? '(no prompt)', 42);
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
    } else if (j.status === 'paused') {
      // Say what it is waiting for, not just that it is stopped: a run already
      // in ComfyUI's queue is still being worked on up there, and this app is
      // only waiting to start watching it again.
      const submitted = j.runs.filter((r) => r.promptId && r.status !== 'done' && r.status !== 'error').length;
      // A row that says only "paused" makes the user guess. The two holds have
      // very different meanings - the network, or somebody else's job in
      // ComfyUI - and the full sentence lives in the strip below the list.
      meta.textContent = (/busy/i.test(j.error ?? '') ? `paused · waiting for ComfyUI's queue` : 'paused')
        + ` · ${j.summary.done}/${j.summary.total} runs`
        + (submitted ? ` · ${submitted} at ComfyUI` : '');
      row.append(dot, text, meta);
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

  // The controls only exist while there is a queue to control. A paused queue
  // always shows them, even with nothing behind it: the resume button is the
  // only way back from a pause, and hiding it over an empty queue would trap
  // the next Generate in a pause nobody can see.
  const bar = $('queueBar');
  bar.hidden = busy.length === 0 && !paused;
  const toggle = $('queueToggle');
  toggle.textContent = paused ? '▶ resume queue' : 'pause queue';
  toggle.classList.toggle('primary', paused);
  toggle.classList.toggle('ghost', !paused);
  toggle.title = paused && q.reason === 'busy'
    ? 'try now - it will hold again if ComfyUI is still busy (it starts by itself anyway)'
    : '';
  const send = $('queueSubmitAll');
  // A hold for ComfyUI's OWN queue is the one pause "send all" is the answer to -
  // handing the work over is precisely what the hold was avoiding - so the button
  // has to stay live there. It stays dead for a lost connection, where sending
  // would fail anyway.
  const busyHold = paused && q.reason === 'busy';
  send.disabled = handoff === 0 || (paused && !busyHold);
  send.title = handoff === 0
    ? 'nothing left to hand over'
    : busyHold
      ? 'skip the wait and queue this behind ComfyUI\'s current work'
      : `submit every remaining run of ${handoff} job${handoff > 1 ? 's' : ''} to ComfyUI now`;

  const note = $('queuePaused');
  note.hidden = !paused;
  if (paused) {
    note.textContent = q.reason === 'connection'
      ? `paused — ComfyUI is not answering (${q.message || 'no connection'}). ${q.waiting ?? 0} job(s) held here; press resume when you are back on the network.`
      : busyHold
        ? `held — ${q.message || 'ComfyUI is busy with work this app did not send'}. ${q.waiting ?? 0} job(s) wait here and start on their own as soon as it is free — or press send all to queue up behind it now.`
        : `paused — ${q.waiting ?? 0} job(s) held here. Press resume to carry on.`;
  }
  // The queue is written to data/queue.json on every change, so a restart resumes
  // it. If that write is failing the promise is broken, and a full card or a
  // read-only data folder is exactly the situation where you would find out at
  // the worst moment - so it is said out loud instead of hoped for.
  const saved = $('queueSaved');
  const unsaved = Boolean(q.saveError) && (busy.length > 0 || q.waiting > 0 || paused);
  saved.hidden = !unsaved;
  if (unsaved) {
    saved.textContent =
      `⚠ the queue is not being saved to disk — ${q.saveError}. ` +
      'A restart would lose it. Free some space, or check that data/ is writable.';
  }
  // Both submit buttons offer the queue, because both share it.
  setText('generate', busy.length ? 'Add to queue' : 'Generate');
  setText('upscale', busy.length ? 'Add to queue' : 'Upscale');
}

on('queueToggle', async () => {
  const resuming = state.queue?.paused === true;
  setDisabled('queueToggle', true);
  try {
    state.queue = await api(resuming ? '/api/queue/resume' : '/api/queue/pause', { method: 'POST' });
    renderQueue();
    toast(resuming ? 'queue resumed' : 'queue paused');
  } catch (e) {
    toast(e.message);
  } finally {
    setDisabled('queueToggle', false);
  }
});

on('queueSubmitAll', async () => {
  setDisabled('queueSubmitAll', true);
  setText('queueSubmitAll', 'sending…');
  try {
    const r = await api('/api/queue/submit-all', { method: 'POST' });
    if (r.queue) state.queue = r.queue;
    const parts = [`${r.runs} run${r.runs === 1 ? '' : 's'} sent to ComfyUI`];
    if (r.alreadySubmitted) parts.push(`${r.alreadySubmitted} already there`);
    if (r.failures?.length) parts.push(`${r.failures.length} failed: ${r.failures[0].message}`);
    toast(parts.join(' · '));
    renderQueue();
  } catch (e) {
    toast(e.message);
  } finally {
    setDisabled('queueSubmitAll', false);
    setText('queueSubmitAll', 'send all to ComfyUI');
    renderQueue();
  }
});

/** Fold a queue message from /api/events or /api/jobs into the state. */
function applyQueue(q) {
  if (!q) return;
  const wasPaused = state.queue?.paused === true;
  state.queue = q;
  // A new hold deserves a new "ComfyUI is back" offer, so the once-only flag is
  // cleared the moment the queue is held again rather than after a resume.
  if (q.paused && !wasPaused) resumeOffered = false;
  // The queue came back off disk after a restart. Said once per page, and keyed
  // on the timestamp so a reload does not claim a recovery that happened hours
  // ago - the jobs are on screen either way, and this is only the explanation.
  if (q.restored?.jobs && q.restored.at !== state.restoredShown) {
    state.restoredShown = q.restored.at;
    toast(
      `queue recovered — ${q.restored.jobs} job${q.restored.jobs === 1 ? '' : 's'} from before the restart` +
      `${q.restored.running ? `, ${q.restored.running} of them mid-run` : ''}`,
    );
  }
  renderQueue();
}

let pollTimer = null;
async function pollJobs() {
  clearTimeout(pollTimer);
  if (state.es || stopping) return;
  try {
    const { jobs, queue } = await api('/api/jobs');
    for (const snap of jobs) state.jobs.set(snap.id, snap);
    applyQueue(queue);
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

/**
 * The timers tick on their own clock.
 *
 * They used to be plain text written by renderJob, which meant a run timer could
 * only change when something ELSE changed the page: a run generating for six
 * minutes with no progress event in between - or simply waiting in ComfyUI's
 * queue, where nothing at all happens - froze at whatever the last snapshot
 * said. So the numbers live here and a 1s tick rewrites them, touching nothing
 * else: no re-render, no request. A finished run has an end time, so its timer
 * stops for good and the tick goes quiet on it.
 *
 * Keyed by element, and rebuilt from scratch on every render, so a re-render can
 * never leave a stale timer updating a detached <li>.
 */
const runTimers = new Map();
function tickTimers() {
  const now = Date.now();
  for (const [el, t] of runTimers) {
    const text = durationBetween(t.startedAt, t.endedAt, now);
    if (text === t.text) continue;
    t.text = text;
    if (el.isConnected) el.textContent = text;
  }
}
setInterval(tickTimers, 1000);

function renderJob(job) {
  $('jobPanel').hidden = false;
  const upscale = job.kind === 'upscale' || job.spec?.kind === 'upscale';
  const s = $('jobStatus');
  s.textContent = `${upscale ? '⤒ upscale · ' : ''}${job.status} · ${job.summary.done}/${job.summary.total} runs · ${job.summary.images} images`;
  s.className = `status ${job.status}`;

  const cur = job.runs.find((r) => r.status === 'running') ?? job.runs[job.summary.current];
  const pct = cur?.progress ?? 0;
  $('jobBar').style.width = `${job.status === 'done' ? 100 : pct}%`;

  const bits = [];
  if (job.status === 'queued') bits.push('waiting for the running job to finish');
  if (job.status === 'paused') {
    bits.push(state.queue?.reason === 'connection'
      ? 'held - ComfyUI is not answering; nothing is lost'
      : 'held - press resume to carry on');
  }
  if (cur) {
    bits.push(`run ${cur.index + 1} of ${job.summary.total}`);
    // "2 ahead" is the number that predicts the wait; how many prompts are
    // RUNNING is nearly always 1 and means nothing on a single machine.
    if (cur.ahead != null && cur.ahead > 0) bits.push(`${cur.ahead} ahead in ComfyUI's queue`);
    else if (cur.queue != null && cur.queue > 0) bits.push(`queue +${cur.queue}`);
    if (cur.node != null) bits.push(`node ${cur.node}`);
    if (cur.seed != null) bits.push(`seed ${cur.seed}`);
  }
  if (job.authFailed) bits.push('auth failed - reload the token in Settings');
  if (job.error) bits.push(job.error);
  $('jobLine').textContent = bits.join(' · ');

  const ul = $('runList');
  ul.innerHTML = '';
  runTimers.clear();
  for (const r of job.runs) {
    const li = document.createElement('li');
    if (r.error) li.className = 'err';
    li.innerHTML = `<b>run ${r.index + 1}</b><span></span>`;
    // A prompt sitting in ComfyUI's queue has a ComfyUI id but no start time yet.
    // "running" would be a lie and a timer would be a bigger one, so say what it
    // is actually doing.
    const waiting = Boolean(r.promptId) && !r.startedAt && !r.endedAt;
    const detail = r.error
      ? r.error
      : [waiting ? 'waiting at ComfyUI' : r.status, r.seed != null ? `seed ${r.seed}` : null, r.progress ? `${r.progress}%` : null]
          .filter(Boolean).join(' · ');
    li.lastChild.textContent = detail;
    const time = durationBetween(r.startedAt, r.endedAt);
    if (time) {
      const clock = document.createElement('span');
      clock.className = 'run-time';
      clock.textContent = time;
      clock.title = 'generating time - starts when ComfyUI begins the run';
      li.append(clock);
      runTimers.set(clock, { startedAt: r.startedAt, endedAt: r.endedAt, text: time });
    }
    if (r.promptId) li.title = `ComfyUI prompt ${r.promptId}`;
    // A failed download used to be invisible: it went into run.errors and nothing
    // ever read it, so the image simply was not in the download folder and there
    // was no sign of why. The run still succeeded - say the half that went wrong.
    const dl = (r.errors ?? []).filter((x) => /download failed/i.test(x));
    if (dl.length) {
      li.classList.add('warn');
      const note = document.createElement('span');
      note.className = 'run-note';
      note.textContent = `${dl.length} image(s) not downloaded`;
      note.title = `${dl[0]} - the gallery retries these on its own`;
      li.append(note);
    }
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
    state.galleryLoaded = true;
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

/**
 * Images whose download never produced a file. The gallery still shows them -
 * `/api/gallery/:id/file` streams from ComfyUI when there is nothing on disk -
 * so this is not a broken thumbnail, it is a missing copy in the download
 * folder, which is the copy that outlives ComfyUI. `retry.gone` means the sweep
 * has stopped trying and why.
 */
function missingEntries(entries) {
  return entries.filter((e) => e.localPath == null);
}

/** The amber line above the gallery: what is missing, and what can still be fixed. */
function renderMissingNote() {
  const missing = missingEntries(state.gallery);
  const gone = missing.filter((e) => e.retry?.gone);
  const live = missing.length - gone.length;
  const note = $('galleryMissing');
  setHidden('retryDownloads', live === 0);
  if (!missing.length) return setHidden('galleryMissing', true);

  let text = `${missing.length} image(s) are not in the download folder`;
  if (live) text += ` - the app keeps retrying while ComfyUI is reachable`;
  if (gone.length) text += `. ${gone.length} cannot be recovered: ${gone[0].retry.reason}`;
  text += '.';
  setText('galleryMissing', text);
  setHidden('galleryMissing', false);
}

function renderGallery() {
  const wrap = $('galleryList');
  wrap.innerHTML = '';
  renderMissingNote();
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
      `${entries[0].kind === 'upscale' ? '⤒ ' : ''}`
      + `<span class="g-label"><b>${escapeHtml(truncate(entries[0].prompt ?? '(no prompt)', 70))}</b>`
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
      if (entry.localPath == null) cell.classList.add(entry.retry?.gone ? 'gone' : 'undownloaded');
      const img = document.createElement('img');
      img.src = `/api/gallery/${entry.id}/file`;
      img.loading = 'lazy';
      img.alt = truncate(entry.prompt ?? '', 60);
      img.onclick = () => openLightbox(entry, state.gallery);
      const acts = document.createElement('div');
      acts.className = 'acts';
      const bUp = document.createElement('button');
      bUp.textContent = '⤒ upscale';
      bUp.onclick = () => { useAsUpInput(entry); showTab('upscale'); window.scrollTo(0, 0); };
      const bUse = document.createElement('button');
      bUse.textContent = '⟳ use as input';
      bUse.onclick = () => useAsInput(entry);
      // No save button: every image is already written to the download folder
      // as its run finishes, so a second copy is noise. The one exception is an
      // image whose download failed, and that is now labelled rather than
      // silently missing - "retry downloads" at the top fetches those back.
      acts.append(bUse);
      if (entry.localPath == null) {
        // Outside .acts on purpose: that bar only appears on tap/hover, and the
        // whole point of this marker is that it is visible without touching it.
        const tag = document.createElement('span');
        tag.className = 'cell-tag';
        tag.textContent = entry.retry?.gone ? 'gone' : 'not downloaded';
        tag.title = entry.retry?.gone
          ? `ComfyUI cannot serve this any more (${entry.retry.reason})`
          : 'still waiting for a retry - the file is not in the download folder yet';
        cell.append(tag);
      }
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

$('retryDownloads').onclick = async () => {
  const btn = $('retryDownloads');
  btn.disabled = true;
  btn.textContent = 'retrying…';
  try {
    const r = await api('/api/gallery/retry', { method: 'POST', body: '{}' });
    const parts = [];
    if (r.recovered) parts.push(`${r.recovered} recovered`);
    if (r.gone) parts.push(`${r.gone} unrecoverable`);
    if (r.failed) parts.push(`${r.failed} failed again`);
    toast(parts.length ? parts.join(' · ') : `checked ${r.candidates}, nothing to do`);
    // The gallery reads the index, so it is always current. The job panel's own
    // snapshot was taken at collect time and keeps saying what happened then -
    // which is the honest half of the story.
    await loadGallery();
  } catch (e) {
    toast(`retry failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'retry downloads';
    renderMissingNote();
  }
};

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
    p.textContent = (entry.kind ?? entry.settings?.kind) === 'upscale' ? `⤒ ${entry.prompt || '(upscale)'}` : (entry.prompt || '(empty prompt)');
    // const x = document.createElement('button');
    // x.className = 'hrow-x';
    // x.type = 'button';
    // x.textContent = '×';
    // x.title = 'forget this prompt';
    // x.onclick = async (ev) => {
    //   ev.stopPropagation();
    //   try {
    //     await api(`/api/history/${entry.id}`, { method: 'DELETE' });
    //     loadHistory();
    //   } catch (e) { toast(e.message); }
    // };
    // top.append(p, x);
    card.append(top);

    const s = entry.settings ?? {};
    const isUpscale = (entry.kind ?? s.kind) === 'upscale';
    const meta = document.createElement('div');
    meta.className = 'hrow-meta';
    const when = new Date(entry.lastUsedAt).toLocaleString();
    const bits = [when];
    if (entry.uses > 1) bits.push(`used ${entry.uses}×`);
    if (entry.results) bits.push(`${entry.results} image${entry.results > 1 ? 's' : ''}`);
    const refs = (entry.slots ?? []).filter(Boolean).length;
    // An upscale's one image is its input, not a reference, and saying
    // "1 reference" for it would be wrong.
    if (refs && !isUpscale) bits.push(`${refs} reference${refs > 1 ? 's' : ''}`);
    meta.textContent = bits.join(' · ');
    card.append(meta);

    // The row's buttons. Every one of them stops the click, because the row
    // itself restores the prompt when tapped.
    const mkBtn = (label, title, fn, extraClass) => {
      const b = document.createElement('button');
      b.className = extraClass ? `mini ${extraClass}` : 'mini';
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.onclick = (ev) => { ev.stopPropagation(); fn(); };
      return b;
    };

    const chips = document.createElement('div');
    chips.className = 'chips';
    const chip = (label, on) => {
      const c = document.createElement('span');
      c.className = on ? 'chip on' : 'chip';
      c.textContent = label;
      chips.append(c);
    };
    if (isUpscale) {
      // The upscale graph has none of the generate settings, so the row is read
      // from the ones it does have instead of printing a column of meaningless
      // "enhance on / turbo / megapixels" chips.
      chip('upscale', true);
      chip(s.scaleToDim ? `target ${s.targetWidth} × ${s.targetHeight}` : `×${trimNum(s.scale ?? 1)}`, true);
      if ((s.batch ?? 1) > 1) chip(`${s.batch} images in one pass`, true);
      if (s.guidance) chip('extra guidance', false);
      if (s.collectImages === false) chip('no downloads', false);
      if (s.seed !== null && s.seed !== undefined) chip(`seed pinned: ${s.seed}`, true);
    } else {
    chip(`enhance ${s.promptEnhance === false ? 'off' : 'on'}`, s.promptEnhance !== false);
    chip(s.turbo ? 'turbo' : 'full model', s.turbo);
    if (s.consistency) chip('consistency LoRA', true);
    if (s.stepsOverride) chip(`${s.stepsOverride} steps`, true);
    if (s.inputResolution) chip(`${s.inputResolution}px encoder`, true);
    chip(fmtMP(s.megapixels), false);
    // The postprompt is already inside every captured prompt, so this chip is
    // only a reminder that the row's wording has a tail of its own.
    if (typeof s.postprompt === 'string' && s.postprompt.trim() !== '') chip('+ postprompt', true);
    chip(
      s.useSuggestedAspect ? 'aspect: suggested' : `aspect: ${(s.aspectRatio ?? '1:1 (Square)').split(' ')[0]}`,
      s.useSuggestedAspect === true,
    );
    chip(`${s.batch ?? 1}×${s.shuffle ?? 1} shuffle`, false);
    if (s.refresh === 'everyRun') chip('refresh every run', true);
    if (s.collectImages === false) chip('no downloads', false);
    if (s.seed !== null && s.seed !== undefined) chip(`seed pinned: ${s.seed}`, true);
    }
    card.append(chips);

    // --- the seeds -----------------------------------------------------------
    // The seeds are the other half of the recipe: same prompt + same seed gives
    // the same image, so this is what makes a result repeatable. They only exist
    // once a run has actually been sent to ComfyUI, so a prompt that is still
    // queued has none yet.
    const seeds = (entry.seeds ?? []).filter((n) => Number.isFinite(n));
    if (seeds.length) {
      const box = document.createElement('div');
      box.className = 'hrow-seedbox';

      const bar = document.createElement('div');
      bar.className = 'hrow-seedbar';

      const label = document.createElement('span');
      label.className = 'hrow-seedlabel';
      label.textContent = seeds.length === 1 ? `seed ${seeds[0]}` : `${seeds.length} seeds`;
      label.title = seeds.length === 1
        ? 'the seed this image was made with'
        : 'one seed per run, in the order the runs went out';
      bar.append(label);

      const spacer = document.createElement('span');
      spacer.className = 'flex1';
      bar.append(spacer);

      // Newline separated: pasting into a text box gives one number per line,
      // which is what you want when you are moving seeds between prompts.
      const seedText = seeds.join('\n');
      bar.append(
        mkBtn('copy', 'copy the seeds, one per line', async () => {
          toast(await copyText(seedText)
            ? `${seeds.length} seed${seeds.length > 1 ? 's' : ''} copied`
            : 'copy blocked by the browser');
        }),
        mkBtn(seeds.length > 1 ? 'use first' : 'use', 'put this seed in the Seed box', () => {
          useSeed(seeds[0], isUpscale ? 'upscale' : 'generate');
        }),
      );

      box.append(bar);
      card.append(box);
    }

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
 * Put a remembered seed into the Seed box and go to the Generate tab.
 *
 * This is the "run that one again" shortcut: the seed is filled in so the next
 * press reuses it, and the field itself stays visible and editable, so nothing
 * about the job is hidden by putting a seed back.
 */
function useSeed(seed, kind = 'generate') {
  if (!Number.isFinite(seed)) return;
  if (kind === 'upscale') {
    $('upSeed').value = String(seed);
    updateUpMath();
    showTab('upscale');
    window.scrollTo(0, 0);
    toast(`seed ${seed} loaded`);
    return;
  }
  $('seed').value = String(seed);
  syncSeedUi();
  updateRunMath();
  showTab('generate');
  window.scrollTo(0, 0);
  toast(`seed ${seed} loaded`);
}

/**
 * Put a remembered prompt back on the Generate tab: text, every setting, and
 * the reference images. Reference images that were pruned from disk are
 * reported rather than dropped silently.
 *
 * An upscale row goes to the Upscale tab instead. The two forms have nothing in
 * common, and putting a scale factor into the megapixels box because the row
 * happened to be an upscale would be worse than doing nothing.
 */
function restoreHistory(entry) {
  const s = entry.settings ?? {};
  if ((entry.kind ?? s.kind) === 'upscale') return restoreUpscaleHistory(entry);
  $('prompt').value = entry.prompt ?? '';
  // Older rows have no postprompt at all, so an absent field clears the box
  // instead of leaving whatever was typed there armed on the next run.
  $('postprompt').value = typeof s.postprompt === 'string' ? s.postprompt : '';
  if (s.megapixels) $('megapixels').value = s.megapixels;
  if (s.batch) $('batch').value = s.batch;
  if (s.shuffle) $('shuffle').value = s.shuffle;
  if (s.refresh) $('refresh').value = s.refresh;
  $('steps').value = s.stepsOverride ?? '';
  $('inputResolution').value = s.inputResolution ?? '';
  $('turbo').checked = s.turbo === true;
  $('collect').checked = s.collectImages !== false;
  $('enhance').checked = s.promptEnhance !== false;
  $('consistency').checked = s.consistency === true;
  $('useSuggestedAspect').checked = s.useSuggestedAspect === true && s.promptEnhance !== false;
  if (ASPECT_RATIOS.includes(s.aspectRatio)) $('aspectRatio').value = s.aspectRatio;
  // A pinned seed comes back with the prompt, because that is what made it
  // reproducible - but only when the row actually pinned one, so an old row
  // cannot silently re-pin a seed the user has moved on from.
  $('seed').value = s.seed === null || s.seed === undefined ? '' : String(s.seed);
  syncAspectUi();
  syncEnhanceHint();
  syncSeedUi();

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
  updateRunMath();
  toast(lost ? `loaded - ${lost} reference image(s) are gone` : 'loaded into Generate');
}

/**
 * The same gesture on an upscale row: the settings come back into the Upscale
 * form and the image is re-attached when it is still on disk. Nothing is
 * submitted - tapping history has always meant "fill the form in".
 */
function restoreUpscaleHistory(entry) {
  const s = entry.settings ?? {};
  $('upScale').value = s.scale ?? '';
  $('upScaleToDim').checked = s.scaleToDim === true;
  $('upTargetWidth').value = s.targetWidth ?? '';
  $('upTargetHeight').value = s.targetHeight ?? '';
  $('upGuidance').value = s.guidance ?? '';
  $('upSeed').value = s.seed === null || s.seed === undefined ? '' : String(s.seed);
  $('upBatch').value = s.batch ?? 1;
  $('upDownload').checked = s.collectImages !== false;

  const slot = (entry.slots ?? []).find(Boolean);
  let lost = false;
  if (slot?.available && slot.url) {
    setUpImage(slot.kind === 'upload' ? { uploadId: slot.uploadId } : { ref: slot.ref }, slot.url);
  } else {
    lost = true;
    setUpImage(null);
  }
  syncUpUi();
  updateUpMath();
  saveForm();
  showError(null);
  showTab('upscale');
  autoGrow($('upGuidance'));
  window.scrollTo(0, 0);
  toast(lost ? 'loaded - the image is gone, pick another' : 'loaded into Upscale');
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

/**
 * Zoom by `factor` while holding the content point under `focal` (client
 * coords) still. A pinch uses the finger midpoint here, so the image grows
 * towards the fingers instead of towards its own centre; pass the image
 * centre to zoom the way the +/- buttons and the double tap do.
 */
function zoomAbout(factor, focal) {
  const next = clamp(lbZoom.s * factor, LB_MIN, LB_MAX);
  const rect = lbImg.getBoundingClientRect();
  // The centre of the transformed image, so the focal offset is in screen px.
  const cx = focal.x - (rect.left + rect.width / 2);
  const cy = focal.y - (rect.top + rect.height / 2);
  const pan = zoomAboutPoint(lbZoom, cx, cy, next);
  setZoom(next, pan.x, pan.y);
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
  showTab('generate');
});
// The lightbox is where a generated image gets judged, so "upscale this" has to
// be one tap from there rather than a trip through the gallery.
on('lbUpscale', () => {
  useAsUpInput(lbEntry);
  closeLightbox();
  showTab('upscale');
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
// means a pinch (scale by the ratio of finger distances, around the midpoint
// between them); one means a drag.
const lbImg = $('lightboxImg');
const pointers = new Map();
// `d` is the distance the previous pinch was at; the midpoint is kept for
// reference only, because the focal point is read live off the current one.
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
      // Zoom towards the midpoint between the fingers, not the image centre:
      // the point the user is looking at is the one that must stay put. The
      // two-finger midpoint drift is already folded into that focal point, so
      // panning comes out of the same call.
      zoomAbout(d / pinch.d, m);
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
  zoomAbout(e.deltaY < 0 ? 1.15 : 1 / 1.15, { x: e.clientX, y: e.clientY });
}, { passive: false });

// ---------------------------------------------------------------- settings
/**
 * Which graph the bindings editor is looking at. Generate and Upscale read two
 * different files whose node ids share nothing, so one editor with a switch is
 * the only way to keep them from being confused - and the check/save/reset calls
 * all have to carry the same answer, or the page would validate the generate
 * bindings while showing the upscale ones.
 */
const bindKind = () => $('bindKind')?.value === 'upscale' ? 'upscale' : 'generate';
const bindingsFor = (kind) => (kind === 'upscale' ? state.cfg?.upscaleBindings : state.cfg?.bindings) ?? {};
const bindingsPath = (kind) => (kind === 'upscale' ? '/api/upscale/workflow' : '/api/workflow');

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
    renderBindings(bindingsFor(bindKind()));
    renderHealthDetail();
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
  megapixels: 'Megapixels (float)',
  useSuggestedAspect: 'Use suggested aspect',
  aspectRatio: 'Aspect ratio (combo)',
  consistencyLora: 'Consistency LoRA',
  inputResolution: 'Encoder resolution',
  enhanceSeed: 'Enhancer seed',
  images: 'Reference images',
  // The upscale graph's own rows.
  image: 'Image to upscale',
  scale: 'Scale multiplier',
  scaleToDim: 'Scale to a size',
  scaleToDimHeight: 'Scale to a size (height)',
  targetWidth: 'Target width',
  targetHeight: 'Target height',
  guidance: 'Guidance prompt',
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

    const rec = state.bindingTitles.get(`${key}${slot ?? ''}`);
    const mark = document.createElement('div');
    mark.className = 'bind-title';
    // One shared decision, so this row and the checker can never tell different
    // stories about the same binding.
    const m = bindingMark(rec, escapeHtml);
    mark.innerHTML = m.html;
    if (m.bad) d.classList.add('bad');
    d.append(mark);
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

/**
 * Save the binding rows, then paint the result of the save, not the result of the
 * typing.
 *
 * This is the fix for "I changed a node id and pressed save and nothing happened":
 * the server silently drops binding names it does not know and reports the ones
 * it could not resolve, so re-rendering from the server's own answer - and saying
 * so out loud when something did not stick - is the only way the page can tell the
 * truth about what the next run will actually do.
 */
$('saveBindings').onclick = async () => {
  const kind = bindKind();
  const msg = $('bindMsg');
  msg.textContent = 'saving…';
  msg.classList.remove('bad');
  try {
    const patch = kind === 'upscale'
      ? { upscaleBindings: collectBindings() }
      : { bindings: collectBindings() };
    const body = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
    state.cfg = body.config;
    renderBindings(bindingsFor(kind));
    const dropped = kind === 'upscale' ? (body.staleUpscaleBindings ?? []) : (body.staleBindings ?? []);
    await checkBindings();
    if (dropped.length) {
      msg.textContent = `saved, but ignored unknown setting(s): ${dropped.join(', ')}`;
      msg.classList.add('bad');
      toast('some settings were not recognised and were not saved');
    }
  } catch (e) { msg.textContent = e.message; }
};

/**
 * Switching graph swaps the rows to the other map and re-checks them. Nothing is
 * sent by doing this - the rows only reach the server when Save is pressed - and
 * an edit left half-typed on the previous graph is simply dropped, which is why
 * the message line is cleared rather than left claiming something about the map
 * that is no longer on screen.
 */
listen('bindKind', 'change', () => {
  renderBindings(bindingsFor(bindKind()));
  setText('bindMsg', '');
  checkBindings();
});

$('checkBindings').onclick = checkBindings;

/**
 * Put every binding back to what this build ships with.
 *
 * The escape hatch for a row that has drifted: editing the node id by hand is how
 * the correct id and a stale input name end up side by side, and the startup
 * migrations deliberately leave hand-edited rows alone. So the page needs to be
 * able to say "forget what I typed".
 */
$('resetBindings').onclick = async () => {
  const kind = bindKind();
  const msg = $('bindMsg');
  if (!confirm(`Reset every ${kind} node binding back to this build's defaults?\n\nSettings you changed here will be lost.`)) return;
  msg.textContent = 'resetting…';
  msg.classList.remove('bad');
  try {
    const body = await api('/api/config/bindings/reset', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    });
    state.cfg = body.config;
    state.bindingTitles = new Map();
    for (const r of body.bindings ?? []) state.bindingTitles.set(`${r.binding}${r.slot ?? ''}`, r);
    renderBindings(bindingsFor(kind));
    paintBindingMarks(body.bindings ?? []);
    const bad = (body.bindings ?? []).filter((r) => !r.ok);
    if (bad.length) {
      msg.textContent = `reset, but ${bad.length} still do not fit this workflow: ` +
        bad.map((b) => `${b.binding}: ${b.reason}`).join('; ');
      msg.classList.add('bad');
      toast('the defaults do not match the workflow - fix them by hand');
    } else {
      msg.textContent = 'reset to defaults - every binding ok';
      toast('bindings reset');
    }
  } catch (e) { msg.textContent = e.message; }
};

/** 400 from /api/generate when a binding is broken - say where to look. */
function showBindingError(err) {
  const bad = (err.bindings ?? []).map((b) => `${b.binding}${b.slot ? ` #${b.slot}` : ''}: ${b.reason}`);
  if (!bad.length) return false;
  showError(`${err.message}\nFix it in the Settings tab.`);
  toast('a node id in Settings does not match the workflow');
  return true;
}

async function checkBindings() {
  const kind = bindKind();
  const msg = $('bindMsg');
  msg.textContent = 'checking…';
  try {
    const { bindings, ok } = await api('/api/config/validate', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    });
    // The whole record is kept, not just the title: renderBindings re-reads this
    // map, and a map that cannot say "this one failed" is how a broken row ends
    // up wearing a tick.
    state.bindingTitles = new Map();
    let bad = 0;
    for (const r of bindings) {
      state.bindingTitles.set(`${r.binding}${r.slot ?? ''}`, r);
      if (!r.ok) bad++;
    }
    paintBindingMarks(bindings);
    msg.textContent = ok
      ? `all ${kind} bindings ok`
      : `${bad} problem(s) - the ${kind === 'upscale' ? 'Upscale' : 'Generate'} button will refuse to run`;
    msg.classList.toggle('bad', !ok);
  } catch (e) { msg.textContent = e.message; }
}

/** Marks the rows already on screen, without rebuilding them. */
function paintBindingMarks(bindings) {
  for (const el of document.querySelectorAll('#bindings .bind')) {
    const key = el.dataset.key;
    const slot = el.dataset.slot === '' ? null : Number(el.dataset.slot);
    const rec = bindings.find((b) => b.binding === key && (b.slot ?? null) === slot);
    let mark = el.querySelector('.bind-title');
    if (!mark) {
      mark = document.createElement('div');
      mark.className = 'bind-title';
      el.append(mark);
    }
    const m = bindingMark(rec ?? null, escapeHtml);
    mark.innerHTML = m.html;
    el.classList.toggle('bad', m.bad);
  }
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

// The dot is the only always-visible health signal, so it has to be the way to
// the detail rather than a tooltip. Reuses the tab switcher so opening Settings
// still runs loadSettings(), and then scrolls the report into view - the dot is
// in the top bar and the card is far down the page.
$('healthBtn').onclick = () => {
  document.querySelector('.tabbtn[data-tab="settings"]')?.click();
  $('healthDetail')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
};

$('healthCheck').onclick = async () => {
  const el = $('healthDetail');
  el.textContent = 'checking…';
  await refreshHealth();
};

$('healthCopy').onclick = async () => {
  const ok = await copyText(healthReportText());
  toast(ok ? 'report copied' : 'copy failed');
};

// ------------------------------------------------------------ server control

/**
 * Stop the server from the page, then prove that it did.
 *
 * The reply is not proof. A wedged process, or a socket held open by the event
 * stream, could still be there after a `stopping: true` answer - so the page
 * keeps asking /api/health and only calls it done when the socket itself stops
 * answering. A refused connection is the one signal that cannot lie.
 */
let stopping = false;
let shTimer = null;

/** Runs of this job that never reached ComfyUI, so a stop would lose them. */
const unsentCount = (j) =>
  (j.runs ?? []).filter((r) => !r.promptId && ['pending', 'queued'].includes(r.status)).length;

/**
 * What stopping would cost, as consequences rather than counts. Nothing here is
 * fetched: the queue strip, the job list and the gallery already hold all of
 * it, so the confirmation can appear instantly.
 */
function shutdownReport() {
  const jobs = [...state.jobs.values()].filter(inFlight);
  const unsent = jobs.reduce((n, j) => n + unsentCount(j), 0);
  const atComfy = jobs.reduce((n, j) => n + (j.runs ?? []).filter((r) => r.promptId).length, 0);
  const held = state.queue?.paused === true;
  const missing = missingEntries(state.gallery).filter((e) => !e.retry?.gone).length;
  const lines = [];
  if (!jobs.length && !missing) lines.push('<p>Nothing is in flight and every image is downloaded.</p>');
  if (held) {
    lines.push('<p>The queue is paused because ComfyUI is not answering, so there is nothing to hand over.</p>');
  } else if (unsent) {
    lines.push(`<p class="bad">${unsent} run${unsent === 1 ? '' : 's'} never reached ComfyUI and will be lost.</p>`);
  } else if (jobs.length) {
    lines.push('<p>Everything queued has already been handed to ComfyUI.</p>');
  }
  if (atComfy) {
    lines.push(`<p class="warn">${atComfy} prompt${atComfy === 1 ? '' : 's'} keep${atComfy === 1 ? 's' : ''} generating on ComfyUI after this, but nothing will be watching them, so those images are not downloaded here.</p>`);
  }
  if (missing) {
    lines.push(`<p class="warn">${missing} image${missing === 1 ? '' : 's'} still waiting to be downloaded will be retried after the next start.</p>`);
  }
  if (jobs.length) {
    const rows = jobs.slice(0, 4).map((j) => {
      const done = (j.runs ?? []).filter((r) => r.promptId).length;
      return `<li>${escapeHtml(j.id)} · ${j.status} · ${done}/${(j.runs ?? []).length} at ComfyUI</li>`;
    });
    const rest = jobs.length - Math.min(jobs.length, 4);
    if (rest > 0) rows.push(`<li>and ${rest} more</li>`);
    lines.push(`<ul>${rows.join('')}</ul>`);
  }
  return { html: lines.join(''), offerHandover: unsent > 0 && !held };
}

function openShutdownModal() {
  setText('shTitle', 'Shut down mobile-cfy?');
  paintShutdownBody();
  setHidden('shAgain', true);
  setDisabled('shGo', false);
  setText('shGo', 'shut it down');
  setHidden('shCancel', false);
  setHidden('shutdownModal', false);
  // The gallery is only loaded when that tab is opened, so an untouched session
  // would claim every image is downloaded when it simply has not looked yet.
  if (!state.galleryLoaded) {
    loadGallery().then(() => {
      if (!$('shutdownModal').hidden && !stopping) paintShutdownBody();
    });
  }
}

function paintShutdownBody() {
  const r = shutdownReport();
  $('shBody').innerHTML = r.html;
  setHidden('shHandoverRow', !r.offerHandover);
  if ($('shHandover')) $('shHandover').checked = r.offerHandover;
}

function closeShutdownModal() {
  clearTimeout(shTimer);
  // Cancelling means nothing was asked of the server, so the health dot and the
  // polling back off have to come back too.
  stopping = false;
  setHidden('shutdownModal', true);
}

on('shutdownServer', openShutdownModal);
on('shCancel', closeShutdownModal);

/** Build a <p> safely - this markup is user data, not a template literal. */
function para(text, cls) {
  const el = document.createElement('p');
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function shutdownDone() {
  clearTimeout(shTimer);
  setText('shTitle', 'Server stopped');
  const body = $('shBody');
  body.innerHTML = '';
  body.append(
    para('mobile-cfy stopped answering, so the server is stopped.'),
    para('Prompts ComfyUI was already given keep running there.'),
    para('Start it again with: bash start.sh  (in Termux)'),
  );
  const reload = document.createElement('button');
  reload.className = 'btn primary sm';
  reload.textContent = 'reload page';
  reload.onclick = () => location.reload();
  const row = document.createElement('div');
  row.className = 'btnrow';
  row.append(reload);
  body.append(row);
  setHidden('shGo', true);
  setHidden('shCancel', true);
  setHidden('shAgain', true);
}

function shutdownUnconfirmed() {
  clearTimeout(shTimer);
  setText('shTitle', 'Still answering');
  const body = $('shBody');
  body.innerHTML = '';
  body.append(
    para('The server is still answering after ~17 seconds, so it has not stopped. Check the Termux window for a message.', 'bad'),
    para('A queued job can hold the exit up only if it is mid-request; otherwise stop.sh from Termux will do it.'),
  );
  setHidden('shGo', false);
  setText('shGo', 'try shutting down again');
  setHidden('shAgain', false);
  setHidden('shCancel', false);
}

/**
 * Poll until the socket refuses, then say so. The delay is the point: a server
 * that has not exited yet answers normally, so the loop is what separates "it
 * is coming down" from "it is stuck".
 */
function watchForShutdown({ attempts = 24, delay = 700 } = {}) {
  const wait = async (i) => {
    if (i > 0) {
      setText('shTitle', 'Shutting down');
      const w = $('shWaitText');
      if (w) w.textContent = 'waiting for the server to stop answering…';
    }
    try {
      if ((await fetch('/api/health', { cache: 'no-store' })).ok) {
        if (i >= attempts) return shutdownUnconfirmed();
        shTimer = setTimeout(() => wait(i + 1), delay);
        return;
      }
    } catch {
      // A refused connection is the answer we wanted.
    }
    shutdownDone();
  };
  wait(0);
}

on('shGo', async () => {
  setDisabled('shGo', true);
  setHidden('shCancel', true);
  setText('shTitle', 'Shutting down');
  setText('shGo', 'shutting down…');
  $('shBody').innerHTML = '<p class="shwait"><i></i><span id="shWaitText">asking the server to stop…</span></p>';
  stopping = true;
  let note = null;
  try {
    const r = await api('/api/shutdown', {
      method: 'POST',
      body: JSON.stringify({ handover: $('shHandover')?.checked === true }),
    });
    if (r.handover?.failures?.length) note = `${r.handover.failures.length} prompt(s) could not be handed over`;
  } catch (e) {
    // A 403 is a refusal and must be shown; a dead socket means it stopped
    // before it could answer, which the poll below confirms either way.
    if (e.status) {
      stopping = false;
      closeShutdownModal();
      setText('shutdownMsg', e.message);
      toast(e.message);
      return;
    }
  }
  watchForShutdown();
  if (note) toast(note);
});

on('shAgain', () => {
  setHidden('shAgain', true);
  watchForShutdown();
});

/** One handler for both graph files; `kind` says which file to write. */
async function uploadWorkflow(kind, inputId) {
  const file = $(inputId).files?.[0];
  if (!file) return;
  try {
    const workflow = JSON.parse(await file.text());
    const r = await api(bindingsPath(kind), { method: 'PUT', body: JSON.stringify({ workflow }) });
    $('wfMsg').textContent = `saved ${r.nodes} nodes to ${kind === 'upscale' ? 'upscale_api.json' : 'workflow_api.json'}`;
    if (kind === bindKind()) {
      nodeListKind = kind;
      renderNodeList(workflow);
      await checkBindings();
    } else {
      toast('saved - switch the bindings to "for" above to check them');
    }
  } catch (e) { $('wfMsg').textContent = e.message; }
}

listen('wfUpload', 'change', () => uploadWorkflow('generate', 'wfUpload'));
listen('upWfUpload', 'change', () => uploadWorkflow('upscale', 'upWfUpload'));

// The node reference follows the graph the bindings editor is on, and is only
// fetched when it is actually opened - the upscale graph has 40-odd nodes and
// nobody needs them downloaded on every settings visit.
let nodeListKind = null;
listen('nodeListWrap', 'toggle', async () => {
  if (!$('nodeListWrap').open || nodeListKind === bindKind()) return;
  try {
    const { workflow } = await api(bindingsPath(bindKind()));
    nodeListKind = bindKind();
    renderNodeList(workflow);
  } catch (e) { toast(e.message); }
});

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
renderUpSlot();
syncUpUi();
syncAspectUi();
syncEnhanceHint();
updateRunMath();
autoGrow($('prompt'));
autoGrow($('postprompt'));
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
    if (ASPECT_RATIOS.includes(d.aspectRatio)) $('aspectRatio').value = d.aspectRatio;
    $('useSuggestedAspect').checked = d.useSuggestedAspect === true && d.promptEnhance !== false;
    $('turbo').checked = d.turbo === true;
    // null means "leave node 207 alone", which a checkbox cannot show, so a
    // null default starts it off rather than pretending it is off.
    $('consistency').checked = d.consistency === true || d.consistency == null;
    syncAspectUi();
    updateRunMath();
  } catch { /* the server may still be booting */ }
})();