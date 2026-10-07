import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, ensureDir } from './config.js';
import { findUpload } from './uploads.js';
import { findEntry } from './gallery.js';

// Prompts are small; a few hundred is plenty and keeps the JSON load instant
// on a phone. Trimmed from the front, so the newest survive.
const MAX_ENTRIES = 300;

const FILE = () => path.join(paths().dataDir, 'history.json');

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function writeAll(entries) {
  const file = FILE();
  ensureDir(path.dirname(file));
  const trimmed = entries.slice(-MAX_ENTRIES);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ entries: trimmed }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return trimmed;
}

/**
 * Identity of a prompt+settings combination. Used only to collapse an immediate
 * double-tap on Generate into one row with a higher use count - a genuine
 * re-run much later is still its own history entry.
 */
export function fingerprint({ prompt, settings, slots }) {
  const norm = JSON.stringify([
    String(prompt ?? '').trim(),
    settings ?? {},
    (slots ?? []).map((s) => (s?.uploadId ? `u:${s.uploadId}` : s?.ref ? `g:${s.ref}` : null)),
  ]);
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

/**
 * Remember a submitted prompt. Never throws: losing history must not take a
 * generation down with it.
 *
 * A row can hold SEVERAL jobs: an immediate double-tap folds into the previous
 * row rather than stacking two near-identical ones, and the fold used to
 * overwrite `jobId` - which meant the first job's finish() found no row and
 * its captures (and status, and seeds) silently vanished. `jobIds` keeps every
 * job that folded in, so each one's finish() lands. `jobId` stays as "the
 * newest", which is what a row click restoring its prompt should use.
 */
export function record({ prompt, settings, slots, jobId }) {
  try {
    const now = new Date().toISOString();
    const rows = readAll();
    const fp = fingerprint({ prompt, settings, slots });
    const last = rows[rows.length - 1];

    if (last && last.fingerprint === fp) {
      if (jobId) {
        // Before `jobId` moves on to the new job: the row's previous owner is
        // exactly the finish() that would otherwise find nothing.
        const ids = Array.isArray(last.jobIds) ? last.jobIds : last.jobId ? [last.jobId] : [];
        if (!ids.includes(jobId)) ids.push(jobId);
        last.jobIds = ids;
        last.jobId = jobId;
      }
      last.uses = (last.uses ?? 1) + 1;
      last.lastUsedAt = now;
      last.status = 'running';
      last.results = 0;
      last.seeds = [];
      writeAll(rows);
      return last;
    }

    const row = {
      id: crypto.randomUUID(),
      fingerprint: fp,
      at: now,
      lastUsedAt: now,
      uses: 1,
      jobId: jobId ?? null,
      jobIds: jobId ? [jobId] : [],
      prompt: String(prompt ?? ''),
      settings: { ...settings },
      slots: (slots ?? []).map((s) => (s?.uploadId ? { uploadId: s.uploadId } : s?.ref ? { ref: s.ref } : null)),
      status: 'running',
      results: 0,
      seeds: [],
      promptTexts: [],
    };
    writeAll([...rows, row]);
    return row;
  } catch (e) {
    console.error('[history] record failed', e);
    return null;
  }
}

/**
 * One capture per run. A job with batch 3 x shuffle 2 can genuinely produce six
 * different enhanced prompts - the enhancer re-words on every refresh - so the
 * row keeps them as a list and the UI nests a collapsible per entry.
 */
function normalizeTexts(list) {
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t, i) => ({
      runIndex: Number.isInteger(t.runIndex) ? t.runIndex : i,
      seed: Number.isInteger(t.seed) ? t.seed : null,
      source: t.source === 'raw' ? 'raw' : 'enhanced',
      text: t.text,
      at: t.at ?? null,
    }));
}

/** Fold a finished job back into its history row. */
export function finish(jobId, { status, results, seeds, promptTexts }) {
  if (!jobId) return null;
  try {
    const rows = readAll();
    // A folded row holds every job that stacked into it: each one's finish
    // has to land, or the first job's captures and counts disappear the
    // moment an immediate double-tap folds over its id.
    const row = rows.find((r) => r.jobId === jobId || (Array.isArray(r.jobIds) && r.jobIds.includes(jobId)));
    if (!row) return null;
    row.status = status ?? row.status;
    row.results = results ?? row.results;
    row.seeds = seeds ?? row.seeds;
    // Append-only and never cleared: re-running a prompt adds a fresh capture
    // per run, and a run that somehow loses its text file must not wipe what
    // earlier runs of the same row captured.
    const incoming = normalizeTexts(promptTexts);
    if (incoming.length) {
      row.promptTexts = textsFor(row);
      const seen = new Set(row.promptTexts.map((t) => `${t.runIndex}:${t.text}`));
      for (const t of incoming) {
        if (!seen.has(`${t.runIndex}:${t.text}`)) row.promptTexts.push(t);
      }
    }
    row.finishedAt = new Date().toISOString();
    writeAll(rows);
    return row;
  } catch (e) {
    console.error('[history] finish failed', e);
    return null;
  }
}

/**
 * What the UI needs to put a slot back on screen: a thumbnail URL and whether
 * the bytes are still there. A picked photo can be pruned from data/uploads,
 * and the gallery can be cleared - either way restoring must say so rather than
 * drop in a broken image.
 */
function describeSlot(slot) {
  if (!slot) return null;
  if (slot.uploadId) {
    const up = findUpload(slot.uploadId);
    return {
      kind: 'upload',
      uploadId: slot.uploadId,
      url: up ? `/api/uploads/${up.id}` : null,
      name: up?.original ?? null,
      available: Boolean(up),
    };
  }
  if (slot.ref) {
    const entry = findEntry(slot.ref);
    return {
      kind: 'gallery',
      ref: slot.ref,
      url: entry ? `/api/gallery/${entry.id}/file` : null,
      name: entry?.localName ?? entry?.comfyFilename ?? null,
      available: Boolean(entry),
    };
  }
  return null;
}

/**
 * Every capture on a row, oldest first. Rows written before this was a list
 * carry a single `promptText` string; fold those in rather than losing a
 * prompt the user may already have read.
 */
function textsFor(r) {
  const list = normalizeTexts(r.promptTexts);
  if (r.promptText && typeof r.promptText === 'string') {
    const first = list[0];
    if (!first || first.text !== r.promptText) {
      list.unshift({ runIndex: 0, seed: null, source: r.promptSource === 'raw' ? 'raw' : 'enhanced', text: r.promptText, at: null });
    }
  }
  return list;
}

export function list({ limit = 100 } = {}) {
  return readAll()
    .slice()
    .reverse()
    .slice(0, Math.max(1, limit))
    .map((r) => ({
      id: r.id,
      at: r.at,
      lastUsedAt: r.lastUsedAt ?? r.at,
      uses: r.uses ?? 1,
      jobId: r.jobId ?? null,
      // Every job folded into this row - a jump-to-history has to match any of
      // them, and legacy rows (written before this existed) derive it.
      jobIds: Array.isArray(r.jobIds) ? r.jobIds : r.jobId ? [r.jobId] : [],
      prompt: r.prompt,
      // 'generate' | 'upscale'. Carried in settings too, but the UI needs it on
      // every row just to draw the right chips, so it is lifted to the top.
      kind: r.settings?.kind ?? 'generate',
      settings: r.settings ?? {},
      slots: (r.slots ?? []).map(describeSlot),
      status: r.status ?? 'running',
      results: r.results ?? 0,
      seeds: r.seeds ?? [],
      finishedAt: r.finishedAt ?? null,
      // The strings the text encoder actually received (workflow node 181) -
      // one per run, since every refresh can re-word the prompt differently.
      promptTexts: textsFor(r),
    }));
}

export function find(id) {
  const row = readAll().find((r) => r.id === id);
  if (!row) return null;
  return { ...row, slots: (row.slots ?? []).map(describeSlot), promptTexts: textsFor(row) };
}

export function remove(id) {
  const rows = readAll();
  const next = rows.filter((r) => r.id !== id);
  if (next.length === rows.length) return false;
  writeAll(next);
  return true;
}

export function clear() {
  return writeAll([]);
}