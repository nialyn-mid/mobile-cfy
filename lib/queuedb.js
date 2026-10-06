/**
 * The queue on disk.
 *
 * The runner used to keep every pending job in a private field, which meant a
 * restart - a crash, a battery death, a Termux kill, an `npm i` - threw away work
 * the user had deliberately lined up. This module is the disk half of that
 * problem and knows nothing about running: it turns a job into the smallest
 * record that can be resumed, and back again.
 *
 * Two rules shape the record, and both are load-bearing:
 *
 *   1. Everything volatile is left out. `progress`, `node`, `queue`, `ahead`,
 *      `wsFailed` and `outputs` describe *now*. Restoring a run claiming to be
 *      61% through after an hour on the splash screen would be a lie, and - worse
 *      for the phone - they change on every progress tick, so keeping them would
 *      mean rewriting the file several times a second. A run's identity (index,
 *      group, seed, promptId, the images it already produced, the text it
 *      captured) is what survives.
 *
 *   2. Never trust the file. It is hand-editable, it can be truncated by a
 *      battery cut during the write (mitigated by write-then-rename, see
 *      `writeQueue`), and it can be a newer version than this code. `fromRecord`
 *      rebuilds every field the runner reads with an explicit default, so a
 *      half-written record boots into a run that is honestly `pending` rather
 *      than into `undefined` somewhere the UI would print "[object Object]".
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths, ensureDir } from './config.js';
import { findEntry } from './gallery.js';

// Bumped whenever the record shape changes incompatibly. An older file is read
// as "nothing to restore" rather than half-read.
export const QUEUE_FILE_VERSION = 1;

/**
 * How many jobs the file may hold. A queue this long is a mistake, not a plan,
 * and the whole file is rewritten on every transition - but the cap is never
 * applied silently, because a queue that quietly loses its oldest job is worse
 * than a queue that says it did.
 */
export const MAX_SAVED_JOBS = 100;

export function queueFile() {
  return path.join(paths().dataDir, 'queue.json');
}

// ---------------------------------------------------------------- coercion
// One table, so "which fields exist on a run" is answerable in one place and a
// new run field cannot be silently left out of the restore path.
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const bool = (v) => v === true;
const int = (v, fallback) => (Number.isInteger(v) ? v : fallback);
const safeSeed = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const strList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);

/** What a run must come back with. Anything not listed is deliberately transient. */
const RUN_FIELDS = {
  index: (v, i) => int(v, i),
  group: (v) => int(v, 0),
  indexInGroup: (v) => int(v, 0),
  isFirstOfGroup: bool,
  refreshOverride: bool,
  seed: safeSeed,
  status: (v) => str(v) ?? 'pending',
  promptId: str,
  startedAt: str,
  endedAt: str,
  error: str,
  promptText: str,
  promptTextNode: str,
  promptTextFile: str,
};

const PERSISTED_RUN_KEYS = Object.keys(RUN_FIELDS);

/**
 * Run -> disk. Ids only for the images: the gallery entry itself already lives
 * in data/index.json, and copying it here would put a second, silently diverging
 * copy of the same picture on disk.
 */
export function toRecord(job, position) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    // Where it was when the file was written, so a restore can say "this one was
    // still running" instead of implying three jobs were all merely waiting.
    position: position === 'active' ? 'active' : 'waiting',
    spec: job.spec,
    runs: job.runs.map((r) => {
      const out = {};
      for (const key of PERSISTED_RUN_KEYS) out[key] = r[key] ?? null;
      out.images = strList((r.images ?? []).map((e) => e?.id));
      return out;
    }),
  };
}

/**
 * Disk -> run. Rebuilds every field the runner touches, so the shape does not
 * depend on what the writer happened to include.
 */
export function runFromRecord(rec, i) {
  const run = { images: [], progress: 0, node: null, queue: null, ahead: null, wsFailed: false, outputs: [], errors: undefined };
  for (const [key, coerce] of Object.entries(RUN_FIELDS)) run[key] = coerce(rec?.[key], i);
  run.resumedFromDisk = true;
  run.images = strList(rec?.images)
    .map((id) => findEntry(id))
    // A gallery cleared while the server was down leaves a dangling id. Dropping
    // the entry is the honest answer - the picture really is gone - and the run
    // still counts as finished.
    .filter(Boolean);
  return run;
}

/** Disk -> job, or null when the record is too broken to be a job at all. */
export function fromRecord(rec) {
  if (!rec || typeof rec.id !== 'string' || !rec.id) return null;
  if (!rec.spec || typeof rec.spec !== 'object') return null;
  if (!Array.isArray(rec.runs) || !rec.runs.length) return null;
  const spec = {
    ...rec.spec,
    // A record from before the upscale tab has no kind, and `kind` is what the
    // payload builder and the filename counters branch on.
    kind: rec.spec.kind === 'upscale' ? 'upscale' : 'generate',
    slots: Array.isArray(rec.spec.slots) ? rec.spec.slots : [],
  };
  if (typeof spec.prompt !== 'string') spec.prompt = String(spec.prompt ?? '');
  return {
    id: rec.id,
    createdAt: str(rec.createdAt) ?? new Date().toISOString(),
    // Whatever it was doing, it is queued again now - the pump sets `running`
    // when it actually starts. Reporting `running` for a job sitting in the
    // waiting list would put the UI's own bookkeeping out of step with itself.
    status: 'queued',
    authFailed: false,
    cancelRequested: false,
    error: null,
    spec,
    runs: rec.runs.map(runFromRecord),
    current: -1,
    // Bookkeeping for the boot message and for the one-off reattach check.
    resumedFrom: rec.position === 'active' ? 'running' : 'queued',
  };
}

/**
 * The file's contents, or null. The newest jobs win if there are more than the
 * cap; the caller is told, because dropping somebody's oldest job without saying
 * so is the one failure mode this whole feature exists to prevent.
 */
export function trimSaved(records, cap = MAX_SAVED_JOBS) {
  if (records.length <= cap) return { kept: records, dropped: 0 };
  return { kept: records.slice(-cap), dropped: records.length - cap };
}

// ------------------------------------------------------------------- write
/**
 * The last body written, per file. Keyed by path so that two roots (two tests, or
 * a data dir that has been moved) can never mistake one another's "unchanged" for
 * their own. This is what keeps a run that ticks progress off the disk.
 */
const lastWritten = new Map();

/** One write at a time. Two overlapping renames of the same file can interleave. */
let chain = Promise.resolve();

export function serialise(records, at = new Date().toISOString()) {
  return `${JSON.stringify({ version: QUEUE_FILE_VERSION, savedAt: at, jobs: records }, null, 2)}\n`;
}

const ENOENT = (e) => e.code === 'ENOENT';

/**
 * Write the queue, atomically.
 *
 * `writeFile` then `rename`: a battery cut during `writeFile` leaves the *old*
 * file intact and a `.tmp` beside it, instead of a half-written file that parses
 * to nothing. On the same filesystem (always - both paths are under dataDir)
 * rename is atomic on Linux and Android.
 *
 * Returns `{written, at, error}` rather than throwing: failing to save the queue
 * must never take a running job down, and the caller surfaces the error instead.
 */
export async function writeQueue(records) {
  const file = queueFile();
  const at = new Date().toISOString();
  const body = records.length ? serialise(records, at) : null;
  const out = { written: false, at, error: null };
  chain = chain.then(async () => {
    try {
      if (body === null) {
        // Nothing pending: no file at all, rather than an empty one that a reader
        // would have to special-case.
        try {
          await fsp.unlink(file);
        } catch (e) {
          if (!ENOENT(e)) throw e;
        }
        lastWritten.delete(file);
        out.written = true;
        return;
      }
      if (lastWritten.get(file) === body) return; // nothing actually changed
      ensureDir(path.dirname(file));
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, body, 'utf8');
      await fsp.rename(tmp, file);
      lastWritten.set(file, body);
      out.written = true;
    } catch (e) {
      console.error('[queue] save failed', e);
      out.written = false;
      out.error = e.message;
    }
  });
  await chain;
  return out;
}

/**
 * The same write, synchronously, for the one moment there is no time to wait:
 * shutdown. A pending debounce must not be able to lose the last transition, or
 * "restart the server" would throw away the job the user just queued.
 */
export function writeQueueSync(records) {
  const file = queueFile();
  if (!records.length) {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (!ENOENT(e)) console.error('[queue] save failed', e);
    }
    lastWritten.delete(file);
    return;
  }
  const body = serialise(records);
  if (lastWritten.get(file) === body) return;
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    lastWritten.set(file, body);
  } catch (e) {
    console.error('[queue] save failed', e);
  }
}

/** Forget what has been written - for a test that swaps roots underneath us. */
export function resetWriteCache() {
  lastWritten.clear();
}

// -------------------------------------------------------------------- read
/**
 * What the last run left behind, or null. A file this code cannot read is
 * reported and stepped over: a corrupt queue must never be the reason the
 * server will not start.
 */
export function readQueue() {
  let text;
  try {
    text = fs.readFileSync(queueFile(), 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error(`[queue] ${queueFile()} is not valid JSON (${e.message}) - starting with an empty queue`);
    return null;
  }
  if (data?.version !== QUEUE_FILE_VERSION) {
    console.error(`[queue] ${queueFile()} is version ${data?.version}, this build reads ${QUEUE_FILE_VERSION} - starting with an empty queue`);
    return null;
  }
  if (!Array.isArray(data.jobs)) return null;
  return { savedAt: str(data.savedAt) ?? null, jobs: data.jobs };
}