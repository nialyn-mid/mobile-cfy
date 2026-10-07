/**
 * Recovering result images whose download failed.
 *
 * The gallery never loses an image: `addEntry` runs whether the fetch worked or
 * not, and `GET /api/gallery/:id/file` falls back to proxying ComfyUI's `/view`
 * when there is no local file. What does get lost is the file in the download
 * folder - which is the copy that outlives ComfyUI, and the one Android's
 * gallery ever sees. So this module exists to put that copy back, and it is
 * deliberately paranoid about doing it:
 *
 *   - it only ever looks at entries with `localPath == null`, never at the
 *     filesystem. An entry that HAD a file and does not now is one the user
 *     deleted, and re-fetching it would quietly undo their housekeeping.
 *   - a 404 from ComfyUI is a definite answer, so it gives up at once; anything
 *     else gets two more tries with a delay in between, in case it was a fluke.
 *   - a dropped connection is NOT a failed attempt. The sweep only ever runs
 *     while ComfyUI is reachable, so a blip mid-sweep means "not now", not
 *     "this image is bad" - and spending an attempt on it would burn the retry
 *     budget of an image that was fine all along.
 *   - the age limit accrues only across sweeps, which means it counts time the
 *     app actually spent able to reach ComfyUI. Time spent off the network
 *     never ages an entry out, which is the whole point: the user is away for
 *     hours and comes back to find their work still eligible.
 */
import path from 'node:path';
import { missingDownloads, updateEntries } from './gallery.js';
import { downloadImage } from './download.js';
import { isConnectionError } from './comfy.js';
import { config, paths } from './config.js';

/** The download itself counts as attempt 1, so this is two tries after that. */
export const MAX_ATTEMPTS = 3;

/** How long to wait before try 2 and try 3. */
export const RETRY_DELAYS_MS = [30_000, 120_000];

/** Reachable-time a missing image stays eligible. Not wall-clock. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Rows still worth fetching: missing, not yet given up on, not yet expired. */
export function pending() {
  return missingDownloads().filter((r) => !(r.retry?.gone));
}

/**
 * Try to recover every missing download that is due.
 *
 * `client` is passed in rather than built here so the caller (and the tests)
 * control which ComfyUI is being talked to. Returns a report; never throws for
 * a per-image failure, because one dead image must not stop the others.
 */
export async function sweep({ client, force = false, now = Date.now() } = {}) {
  const rows = pending();
  const report = { candidates: rows.length, recovered: 0, gone: 0, failed: 0, skipped: 0 };
  // Every change is collected and written once at the end: `saveIndex` rewrites
  // the whole file, and the age has to be persisted even for a row whose turn has
  // not come yet, otherwise it silently stops ageing while it waits.
  const patches = [];

  for (const row of rows) {
    const retry = (row.retry ??= { attempts: 1, ageMs: 0, firstSeenAt: now, lastCheckedAt: now });

    // Only the delta since the last sweep counts. The sweep runs while ComfyUI is
    // reachable and not otherwise, so this is reachable time, not wall clock.
    retry.ageMs += Math.max(0, now - (retry.lastCheckedAt ?? now));
    retry.lastCheckedAt = now;

    if (retry.ageMs > MAX_AGE_MS) {
      report.gone += 1;
      patches.push({ id: row.id, patch: { retry: { ...retry, gone: true, reason: 'expired' } } });
      continue;
    }
    if (retry.attempts >= MAX_ATTEMPTS) {
      report.gone += 1;
      patches.push({ id: row.id, patch: { retry: { ...retry, gone: true, reason: 'gave up' } } });
      continue;
    }
    if (!force && (retry.nextAttemptAt ?? 0) > now) {
      report.skipped += 1;
      patches.push({ id: row.id, patch: { retry } });
      continue;
    }

    retry.attempts += 1;
    try {
      const saved = await downloadImage(client, {
        filename: row.comfyFilename,
        subfolder: row.subfolder ?? '',
        type: row.type ?? 'output',
      }, {
        // Sprite entries live in their own subfolder - the same place the
        // original download put them - so a retry does not "recover" an image
        // into a different folder than the one the user is looking at.
        dir: (row.kind ?? 'generate') === 'sprite'
          ? path.join(paths().downloadDir, 'sprite')
          : paths().downloadDir,
        template: config().filenameTemplate,
        // The counters the original run had, recorded on the entry: this rebuilds
        // the exact filename the download would have written a moment earlier.
        ctx: {
          prompt: row.prompt,
          seed: row.seed,
          shuffle: row.shuffle,
          batch: row.batch,
          img: row.img,
          node: row.node,
        },
      });
      report.recovered += 1;
      patches.push({ id: row.id, patch: { localPath: saved.path, localName: saved.name, bytes: saved.bytes, retry: null } });
    } catch (e) {
      // 404 means ComfyUI genuinely no longer has it. No point spending the rest
      // of the budget on a definite answer.
      if (e?.status === 404) {
        report.gone += 1;
        patches.push({ id: row.id, patch: { retry: { ...retry, gone: true, reason: 'ComfyUI no longer has it' } } });
        continue;
      }
      if (isConnectionError(e)) {
        // Not the image's fault. Do not spend an attempt, and do not keep going:
        // everything behind this one would fail the same way.
        retry.attempts -= 1;
        report.skipped += 1;
        patches.push({ id: row.id, patch: { retry } });
        break;
      }
      report.failed += 1;
      const delay = RETRY_DELAYS_MS[Math.min(retry.attempts - 1, RETRY_DELAYS_MS.length - 1)];
      patches.push({
        id: row.id,
        patch: { retry: { ...retry, lastError: e.message, nextAttemptAt: now + delay } },
      });
    }
  }

  updateEntries(patches);
  return report;
}

/**
 * A slow heartbeat for the fluke case: the connection can come back without the
 * user touching anything, and a download that failed a second before it did
 * should heal itself. Unref'd, so it never keeps the process alive, and it only
 * does work when something is actually outstanding.
 */
export function startRetryTicker(getClient, intervalMs = 15_000) {
  const timer = setInterval(() => {
    if (!pending().length) return;
    sweep({ client: getClient() }).catch((e) => {
      console.warn(`[retry] sweep failed: ${e.message}`);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}