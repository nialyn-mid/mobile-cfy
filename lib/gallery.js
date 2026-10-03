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