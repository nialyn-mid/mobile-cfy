import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

/**
 * The Sprite workflow's Filename Counter (node 50) is part of every one of its
 * eight SaveImage filename prefixes: `Sprite/{counter}{view}-`. Two jobs that
 * write the same number therefore produce the SAME prefixes, and the second
 * job's files overwrite the first's in ComfyUI's output/Sprite/ folder - a
 * silent data loss that no error would ever mention.
 *
 * So the number is claimed HERE, at enqueue, and persisted to
 * data/sprite-counter.json before the job is handed to the queue. Claiming at
 * enqueue (not at run time) is the safe order: a crash between "submit to
 * ComfyUI" and "remember the number" would otherwise let the next boot reuse a
 * number whose files already exist. A crash after claim only skips a number,
 * which costs nothing.
 *
 * The file is tiny and written atomically (tmp + rename, same recipe as
 * queuedb) so a battery cut mid-write leaves the previous counter intact.
 */

export function counterFile() {
  return path.join(paths().dataDir, 'sprite-counter.json');
}

/**
 * Next number to hand out, read from disk. A missing or unreadable file starts
 * at 1: 0 is a plausible editor value for node 50 in the exported graph, so
 * starting there risks colliding with files the workflow itself already made.
 */
export function readCounter() {
  try {
    const raw = JSON.parse(fs.readFileSync(counterFile(), 'utf8'));
    const n = Number(raw?.next);
    // Floor at 1 and require an integer: a hand-edited 0, -3 or 12.5 is clamped
    // into the range of things that cannot collide, rather than rejected (the
    // alternative is refusing every sprite job over one typo).
    if (Number.isFinite(n)) return Math.max(1, Math.floor(n));
  } catch {
    // Missing file, half-written file, or not JSON at all - all three mean
    // "no remembered counter", which is what a first run looks like.
  }
  return 1;
}

function writeCounterSync(n) {
  const file = counterFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ next: n }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Take the next number for one sprite job and remember that it was taken.
 * Returns the claimed number (always >= 1, always an integer).
 *
 * Synchronous on purpose: enqueue is a synchronous function that pushes the job
 * and persists the queue in the same tick, and letting the number travel
 * through a promise would open the exact window this module exists to close.
 */
export function claimCounter() {
  const n = readCounter();
  writeCounterSync(n + 1);
  return n;
}

/**
 * Tests only: forget what is on disk so a case can start from a known number.
 * Never called by the server - the counter must outlive a restart, which is
 * the entire point of the file.
 */
export function resetCounterForTests(next = 1) {
  writeCounterSync(next);
}
