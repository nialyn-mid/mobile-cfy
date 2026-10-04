import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, ensureDir } from './config.js';

const MAX_ENTRIES = 2000;

export function loadIndex() {
  const { index } = paths();
  try {
    const data = JSON.parse(fs.readFileSync(index, 'utf8'));
    return Array.isArray(data?.images) ? data.images : [];
  } catch {
    return [];
  }
}

function saveIndex(images) {
  const { index } = paths();
  ensureDir(path.dirname(index));
  const trimmed = images.slice(-MAX_ENTRIES);
  const tmp = `${index}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ images: trimmed }, null, 2), 'utf8');
  fs.renameSync(tmp, index);
  return trimmed;
}

/**
 * Record one generated image. `localPath` is present when the download ran;
 * the gallery can still serve the bytes from ComfyUI when it did not.
 */
export function addEntry(entry) {
  const images = loadIndex();
  const row = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...entry,
  };
  images.push(row);
  saveIndex(images);
  return row;
}

/**
 * Patch one row in place. The retry sweep needs this: a recovered download only
 * differs from the original entry in its path, name and byte count.
 */
export function updateEntry(id, patch) {
  return updateEntries([{ id, patch }])[0] ?? null;
}

/**
 * Patch many rows with a single write. `saveIndex` rewrites the whole file, so a
 * sweep over twenty missing images has to pay for it once rather than twenty
 * times.
 */
export function updateEntries(patches) {
  const images = loadIndex();
  const byId = new Map(images.map((r) => [r.id, r]));
  const done = [];
  for (const { id, patch } of patches) {
    const row = byId.get(id);
    if (!row) continue;
    Object.assign(row, patch);
    done.push(row);
  }
  if (done.length) saveIndex(images);
  return done;
}

/**
 * Entries whose download never produced a file.
 *
 * The test is deliberately `localPath == null` and NEVER "is the file on disk":
 * a localPath means the download succeeded once, so if that file is gone now the
 * user deleted it, and re-fetching it would quietly undo their housekeeping.
 */
export function missingDownloads() {
  return loadIndex().filter((r) => r.localPath == null && r.comfyFilename);
}

export function listEntries({ jobId, limit = 500 } = {}) {
  let rows = loadIndex();
  if (jobId) rows = rows.filter((r) => r.jobId === jobId);
  return rows.slice(-limit).reverse();
}

export function findEntry(id) {
  return loadIndex().find((r) => r.id === id) ?? null;
}

export function entriesForJob(jobId) {
  return loadIndex().filter((r) => r.jobId === jobId);
}

/** Newest entries first - what "use the last 4 as inputs" wants. */
export function lastEntries(n = 4) {
  return loadIndex().slice(-n).reverse();
}

export function clearIndex() {
  return saveIndex([]);
}