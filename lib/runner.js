import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { config, state, paths } from './config.js';
import { ComfyClient, AuthError, ComfyError, isConnectionError, comfyHealth, readQueueIds } from './comfy.js';
import { fingerprintOf, graphFromHistoryEntry, graphFromQueueItem, findByFingerprint } from './resync.js';
import {
  planRuns,
  buildRunPayload,
  buildUpscalePayload,
  collectImages,
  collectText,
  newSeed,
  validateJob,
  validateUpscale,
  normalizeSlots,
} from './payload.js';
import { downloadImage, ensureDir } from './download.js';
import { addEntry, findEntry } from './gallery.js';
import { readUpload, findUpload, pushToComfyInput } from './uploads.js';
import * as history from './history.js';
import * as queuedb from './queuedb.js';

/**
 * Did the workflow enhance the prompt, or did our raw text pass straight through?
 *
 * The enhancer takes the reference images itself now (node 226 "Image 1..4"), so
 * this no longer depends on the image count - only on the toggle we actually
 * wrote into node 176. Kept as one function because two call sites had already
 * drifted apart once.
 */
export function promptSourceFor(spec) {
  return spec?.promptEnhance === false ? 'raw' : 'enhanced';
}

/**
 * Everything one run of a job needs in order to become a payload. Kept as its
 * own function so the mapping stays unit-testable - buildRunPayload reads
 * `refreshOverride`, not `isFirstOfGroup`, and dropping it here is exactly the
 * kind of mistake that makes a setting silently do nothing.
 */
export function runPayloadOptions(spec, run, images) {
  return {
    prompt: spec.prompt,
    postprompt: spec.postprompt,
    images,
    promptEnhance: spec.promptEnhance,
    turbo: spec.turbo,
    stepsOverride: spec.stepsOverride,
    megapixels: spec.megapixels,
    inputResolution: spec.inputResolution,
    useSuggestedAspect: spec.useSuggestedAspect,
    aspectRatio: spec.aspectRatio,
    consistency: spec.consistency,
    seed: run.seed,
    refreshOverride: run.refreshOverride,
    isFirstOfGroup: run.isFirstOfGroup,
  };
}

/** Run states that will never be picked up again, by the pump or by a resume. */
const FINISHED = new Set(['done', 'error', 'cancelled']);

/**
 * How often a queue held on ComfyUI's own queue looks again.
 *
 * Long enough that a check is not a request per second while somebody else's
 * three-minute job runs, short enough that the held job starts on its own
 * without anybody watching the page.
 */
const IDLE_POLL_MS = 4000;

/**
 * How often a queue held on the CONNECTION asks whether ComfyUI answers again.
 *
 * Same cadence as the idle watch: long enough to not be a request per second
 * while the server boots, short enough that results reconcile shortly after the
 * link is back - with or without anybody watching the page.
 */
const BACK_POLL_MS = 4000;

/**
 * How long the queue waits for itself to stop changing before it writes.
 *
 * A run reports progress several times a second, but none of that is worth
 * keeping (see lib/queuedb.js) - so in practice this only ever fires on the
 * handful of real transitions: a job queued, cancelled, started, held, finished.
 */
const SAVE_DEBOUNCE_MS = 300;

export class Runner extends EventEmitter {
  #jobs = new Map();
  #controllers = new Map();
  #client = null;
  // Jobs run strictly one at a time. ComfyUI executes one prompt at a time
  // anyway, so letting several jobs submit at once just interleaves them in
  // ComfyUI's queue and makes progress unreadable - and the bash script this
  // replaces was sequential. A cancelled job never blocks the ones behind it.
  #waiting = [];
  #activeId = null;
  // The queue holds instead of feeding. Set when ComfyUI stops answering - the
  // phone has walked out of range, or the server is asleep - and by hand when the
  // operator says stop. Nothing is lost either way: no run is dropped, no seed is
  // re-rolled, and a prompt ComfyUI is already chewing on is re-attached to on
  // resume rather than submitted twice.
  #paused = false;
  #pauseReason = null;
  #pauseMessage = null;
  #pausedAt = null;
  // The runs whose submitPrompt call is in flight right now. A run has no prompt
  // id until ComfyUI answers, so without this the queue and "send everything"
  // could both decide it is still unsubmitted and send it twice.
  #submitting = new Set();
  // The timer that watches ComfyUI's own queue while the queue is held on its
  // account, and the probe it is currently waiting on (one at a time, so a slow
  // answer cannot pile up).
  #idleTimer = null;
  #idleProbe = null;
  // Same pair for a queue held on the CONNECTION: it keeps asking whether
  // ComfyUI is answering again, so a resync happens whether or not anybody has
  // the page open to press resume. The sweep itself is coalesced into one
  // in-flight promise (#resyncing) - a health poll and a pressed resume must not
  // run the same adoption twice, and the pump stays out of the way while it runs.
  #backTimer = null;
  #backProbe = null;
  #resyncing = null;
  // What the last sweep reported ({at, checked, collected, requeued, adopted}),
  // kept so queueState() can hand it to the UI.
  #lastResync = null;
  // The queue's copy on disk. Nothing here is authoritative - the fields above
  // are - but a restart used to throw every pending job away, so the fields are
  // written on every transition and read back once at boot.
  #saveTimer = null;
  #savedAt = null;
  #saveError = null;
  #saveWarned = 0;
  // What the last restore found, kept until the next boot so the UI can say it
  // out loud once instead of pretending the queue was always there.
  #restored = null;

  /**
   * Put back the queue the last run left in data/queue.json.
   *
   * Called once at boot, before the port is open. Returns what was found, or
   * null when there was nothing usable to read - a corrupt file, a newer
   * version, or no queue at all. Every one of those starts an empty queue
   * rather than refusing to start: the alternative is an app that will not boot
   * because of a file it wrote itself.
   */
  restore() {
    const data = queuedb.readQueue();
    if (!data) return null;
    const jobs = [];
    let unreadable = 0;
    for (const rec of data.jobs) {
      const job = queuedb.fromRecord(rec);
      if (job) jobs.push(job);
      else unreadable += 1;
    }
    if (unreadable) console.error(`[queue] ${unreadable} record(s) in queue.json could not be read and were skipped`);
    if (!jobs.length) return null;

    // The job that was running goes back to the FRONT. It may own a prompt
    // ComfyUI is still executing, and it was ahead of everything else anyway -
    // putting it last would let three fresh jobs queue in front of a prompt that
    // has been burning GPU time for twenty minutes. Stable otherwise.
    jobs.sort((a, b) => (a.resumedFrom === 'running' ? 0 : 1) - (b.resumedFrom === 'running' ? 0 : 1));
    const running = jobs.filter((j) => j.resumedFrom === 'running').length;
    for (const job of jobs) {
      this.#jobs.set(job.id, job);
      this.#controllers.set(job.id, new AbortController());
      this.#waiting.push(job);
    }
    this.#restored = { jobs: jobs.length, running, at: data.savedAt };
    this.#savedAt = data.savedAt;
    console.log(
      `[queue] restored ${jobs.length} job(s) from data/queue.json` +
      `${running ? ` (${running} of them were still running)` : ''}`,
    );
    // Reconcile first, start second. The runs read back off disk carry prompt
    // ids from BEFORE the process died: some finished in ComfyUI meanwhile
    // (collect them now rather than reattaching first), some are still queued
    // (leave them, the pump reattaches), and the sweep's own finally starts
    // the pump either way - synchronously returning is preserved, because the
    // boot path reads this return value.
    this.resync();
    return this.#restored;
  }

  /**
   * Every job that is not finished, as it should be written down.
   *
   * The active job first and tagged as such, then the waiting list in order, so
   * a restore reproduces the queue exactly. Finished jobs are not here at all:
   * they are the History tab's business now, and history.json already has them.
   */
  #records() {
    const out = [];
    if (this.#activeId) {
      const active = this.#jobs.get(this.#activeId);
      if (active) out.push(queuedb.toRecord(active, 'active'));
    }
    for (const job of this.#waiting) out.push(queuedb.toRecord(job, 'waiting'));
    const { kept, dropped } = queuedb.trimSaved(out);
    if (dropped && dropped !== this.#saveWarned) {
      this.#saveWarned = dropped;
      console.warn(
        `[queue] ${dropped} job(s) past the ${queuedb.MAX_SAVED_JOBS} cap were left out of queue.json ` +
        `(the newest ${kept.length} were kept) - they are still in memory and still queued`,
      );
    }
    return kept;
  }

  /** Ask for a write, at most one every SAVE_DEBOUNCE_MS. */
  #persist() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#save();
    }, SAVE_DEBOUNCE_MS);
    // Unref'd so a pending write can never be the reason the process refuses to
    // exit - shutDown() flushes synchronously instead of waiting for this.
    this.#saveTimer.unref?.();
  }

  async #save() {
    const { written, at, error } = await queuedb.writeQueue(this.#records());
    if (written) this.#savedAt = at;
    this.#saveError = error;
  }

  /** Write the queue now, synchronously. For shutdown, where there is no later. */
  flushNow() {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    queuedb.writeQueueSync(this.#records());
  }

  client() {
    if (!this.#client) this.#client = new ComfyClient();
    return this.#client;
  }

  /** Drop the cached client so the next call re-reads AUTH_TOKEN from .env. */
  resetClient() {
    this.#client = null;
  }

  list() {
    return [...this.#jobs.values()].map((j) => snapshot(j, this.#waiting));
  }

  /** What the queue strip and the pause button need, and nothing more. */
  queueState() {
    return {
      paused: this.#paused,
      // 'connection' = ComfyUI stopped answering; 'manual' = somebody pressed
      // pause. The UI says different things for each.
      reason: this.#pauseReason,
      message: this.#pauseMessage,
      at: this.#pausedAt,
      waiting: this.#waiting.length,
      running: this.#activeId ? 1 : 0,
      // Runs handed to ComfyUI but not watched yet - what "send everything" moved.
      submitted: [...this.#jobs.values()].reduce(
        (n, j) => n + j.runs.filter((r) => r.promptId && !FINISHED.has(r.status)).length,
        0,
      ),
      // When the queue last reached data/queue.json, when this process found one
      // waiting for it, and whether the last write failed. A queue that is not
      // being saved has to say so: the whole promise is "this survives a
      // restart", and a full card on a phone would break it silently otherwise.
      savedAt: this.#savedAt,
      saveError: this.#saveError,
      restored: this.#restored,
      // What the last resync found, so the UI can say "collected 2 that finished
      // while we were away" instead of silently having different numbers.
      lastResync: this.#lastResync,
    };
  }

  #emitQueue() {
    this.emit('queue', this.queueState());
    this.#persist();
  }

  /** Stop starting new jobs. A job already running is left alone. */
  pause(reason = 'manual', message = null) {
    if (this.#paused) return this.queueState();
    this.#paused = true;
    this.#pauseReason = reason;
    this.#pauseMessage = message;
    this.#pausedAt = new Date().toISOString();
    // A connection hold now has somebody watching for the connection to come
    // back, so results are reconciled whether or not the page is open. A manual
    // pause has no such thing: it stays exactly as the operator left it.
    if (reason === 'connection') this.#startBackWatch();
    console.log(`[runner] queue paused (${reason})${message ? `: ${message}` : ''}`);
    this.#emitQueue();
    return this.queueState();
  }

  /**
   * Start again, in order, from wherever the queue stopped.
   *
   * Reconciliation first, submission second: `resync()` collects the runs that
   * finished while this queue was away, adopts prompts already in ComfyUI's
   * queue, and only then does the pump submit what is genuinely left. Resync
   * failures never block a resume - they are reported in `lastResync`, and the
   * normal reattach-or-hold logic still has the last word.
   */
  async resume() {
    await this.resync();
    this.#stopBackWatch();
    if (!this.#paused) return this.queueState();
    this.#paused = false;
    this.#pauseReason = null;
    this.#pauseMessage = null;
    this.#pausedAt = null;
    // Whatever was watching ComfyUI's queue has nothing to decide any more.
    this.#stopIdleWatch();
    console.log('[runner] queue resumed');
    this.#emitQueue();
    this.#pump();
    return this.queueState();
  }

  /** Move one waiting job up or down. Returns false when it is not waiting. */
  move(id, delta = 1) {
    const at = this.#waiting.findIndex((w) => w.id === id);
    if (at === -1) return false;
    const to = Math.max(0, Math.min(this.#waiting.length - 1, at + (Number(delta) || 0)));
    if (to === at) return false;
    const [job] = this.#waiting.splice(at, 1);
    this.#waiting.splice(to, 0, job);
    console.log(`[runner] moved ${id} from ${at + 1} to ${to + 1}`);
    // Every waiting job's queuePosition may have changed, so refresh them all;
    // the active job's snapshot is untouched (it is never in #waiting).
    for (const w of this.#waiting) this.#emit(w);
    this.#emitQueue();
    return true;
  }

  /**
   * Reconcile the queue with what ComfyUI actually has - the tap-free half of
   * a reconnect.
   *
   * While this queue was not watching (the link dropped, the server restarted),
   * ComfyUI may have finished some prompts, kept others queued, and lost the
   * rest to a cleared queue. This sweep sorts that out BEFORE anything is
   * submitted: finished work is collected into the gallery (never resent),
   * queued work is left to be reattached, vanished work is put back with its
   * original seed. Runs that are being watched right now are not touched - the
   * monitor and #submitRun own those.
   *
   * Sweeps coalesce: a health probe and a pressed resume get the SAME promise,
   * so nobody can adopt or requeue a run twice. Failures never throw - they
   * come back as `ok:false` with a `problem`, and resume proceeds the way it
   * always did (this is reconciliation, not a gate).
   */
  resync() {
    if (this.#resyncing) return this.#resyncing;
    this.#resyncing = this.#resyncSweep()
      .catch((e) => {
        console.error('[runner] resync failed', e);
        return {
          at: new Date().toISOString(),
          ok: false,
          problem: e.message,
          checked: 0,
          collected: 0,
          requeued: 0,
          adopted: 0,
          failed: 0,
          closed: 0,
          left: 0,
        };
      })
      .then((report) => {
        // Kept where queueState() can hand it over: the UI says "collected 2
        // that finished while we were away" from this, and a sweep that could
        // not judge says so here too instead of silently reporting nothing.
        this.#lastResync = report;
        this.#emitQueue();
        return report;
      })
      .finally(() => {
        // Cleared BEFORE the pump runs: #pump steps aside while a sweep is in
        // flight, and the jobs this sweep requeued or collected are exactly the
        // ones the pump should see next.
        this.#resyncing = null;
        if (!this.#paused) this.#pump();
      });
    return this.#resyncing;
  }

  /**
   * The sweep itself: one pass over every run nobody is currently watching,
   * sorted into finished / still queued / vanished / never arrived.
   *
   * Two rules carry the whole design. DONE work is never submitted again -
   * its evidence is /history, and if /history has it, it is collected into the
   * gallery here. UNDONE work is never left behind - evidence for that is
   * /queue, and a prompt in neither is requeued with its ORIGINAL seed, so the
   * retry produces the image the first attempt was going to.
   *
   * Evidence rules, in order:
   *   - a failed probe is not evidence. An unreadable /queue means the sweep
   *     judges nothing at all (`ok:false`), and a run whose history read threw
   *     is left exactly as it was.
   *   - any "it is not in the queue" verdict is confirmed against a FRESH read,
   *     never the snapshot: a run submitted while the sweep was already reading
   *     must not be judged from a queue taken before it existed.
   *   - a prompt id read back off DISK is not this sweep's question. Nobody
   *     here ever saw it enter ComfyUI; #run asks it honestly when the job
   *     reaches it (fail if forgotten, reattach if not), and judging it here
   *     would race that check.
   *
   * Runs being watched right now (the active job, in-flight submits) are never
   * touched: the monitor and #submitRun own them.
   */
  async #resyncSweep() {
    const report = {
      at: new Date().toISOString(),
      ok: true,
      problem: null,
      checked: 0,
      collected: 0,
      requeued: 0,
      adopted: 0,
      failed: 0,
      closed: 0,
      left: 0,
    };

    const candidates = [];
    for (const job of this.#jobs.values()) {
      if (job.id === this.#activeId || FINISHED.has(job.status)) continue;
      for (const run of job.runs) {
        if (FINISHED.has(run.status) || this.#submitting.has(run)) continue;
        candidates.push({ job, run });
      }
    }
    report.checked = candidates.length;
    // No prompt id and no fingerprint means the run never reached ComfyUI:
    // there is nothing to ask. Skipping the HTTP here is what keeps an offline
    // resume (work built while the link was down) instant.
    if (!candidates.some(({ run }) => run.promptId || run.fp)) return report;

    const readQueue = async () => {
      const q = await this.client().getJson('/queue', { timeoutMs: 8000 });
      const list = [...(q?.queue_running ?? []), ...(q?.queue_pending ?? [])];
      return {
        ids: new Set(readQueueIds(list)),
        pairs: list
          .map((item) => ({
            id: Array.isArray(item) ? item[1] : item?.prompt_id,
            graph: graphFromQueueItem(item),
          }))
          .filter((p) => p.id && p.graph),
      };
    };

    let snapshot;
    try {
      snapshot = await readQueue();
    } catch (e) {
      report.ok = false;
      report.problem = `cannot read ComfyUI's queue: ${e.message}`;
      return report;
    }
    // Read once more before any "not in the queue" verdict, memoised: the
    // snapshot answers "is it queued as of the start of the sweep", which is
    // not good enough to hang a requeue on.
    let fresh = null;
    const queueFresh = async () => (fresh ??= await readQueue());
    // The full history, read only when a run actually needs it: fingerprints
    // are the only handle on a run that lost its prompt id, and they match
    // against graphs. Read AFTER the queue, so a prompt that finished a moment
    // ago is already in it.
    let histPairs = null;
    const loadHistory = async () => {
      if (histPairs) return histPairs;
      let h = null;
      try {
        h = await this.client().getJson('/history', { timeoutMs: 8000 });
      } catch (e) {
        if (e?.status !== 404) throw e; // no such endpoint: no graphs, not a failure
      }
      histPairs = Object.entries(h ?? {})
        .map(([id, entry]) => ({ id, entry, graph: graphFromHistoryEntry(entry) }))
        .filter((p) => p.id && p.graph);
      return histPairs;
    };

    // One-to-one bookkeeping. Pinned seeds make identical payloads possible
    // (batch of 3, one pinned seed, no refresh between runs), so "which prompt
    // is this run" cannot be a bare first-match: an id already owned by a run
    // - by ANY run, checked live, because "send everything" keeps submitting
    // while this sweep reads - belongs to its owner, and one prompt must never
    // be handed to two runs.
    const claimed = new Set(); // consumed by an adopt or a collect this sweep
    const dead = new Set(); // confirmed gone and requeued away this sweep
    const liveOwned = () => {
      const ids = new Set();
      for (const j of this.#jobs.values()) for (const r of j.runs) if (r.promptId) ids.add(r.promptId);
      return ids;
    };
    const free = (pairs) => {
      const own = liveOwned();
      return pairs.filter((p) => !own.has(p.id) && !claimed.has(p.id) && !dead.has(p.id));
    };

    const errorMessage = (st) =>
      st?.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message || 'execution error';

    const touched = new Set();
    outer: for (const { job, run } of candidates) {
      // Live re-checks: cancel, the pump and "send everything" keep working
      // while the sweep reads, and a run that just gained an owner or just
      // finished is no longer the sweep's to judge. Re-checked after every
      // await, because those all keep running while this sweep is reading.
      const ours = () => !FINISHED.has(run.status) && !this.#submitting.has(run);
      if (!ours()) continue;
      try {
        if (run.promptId) {
          if (run.resumedFromDisk) {
            report.left += 1;
            continue;
          }
          let entry = null;
          try {
            entry = await this.client().historyEntry(run.promptId, { timeoutMs: 8000 });
          } catch (e) {
            if (e?.status !== 404) throw e; // 404 is an answer; anything else went wrong
          }
          if (entry) {
            if (!ours()) continue;
            const st = entry.status ?? {};
            if (st.completed === true) {
              await this.#collectSwept(job, run, entry.outputs ?? {});
              report.collected += 1;
              touched.add(job);
            } else if (st.status_str === 'error') {
              run.status = 'error';
              run.error = errorMessage(st);
              run.endedAt = run.endedAt ?? new Date().toISOString();
              report.failed += 1;
              touched.add(job);
            } else {
              report.left += 1; // remembered but not finished: leave it alone
            }
            continue;
          }
          // Not in history. Queued => still in progress up there, and the
          // resume reattaches to it. Gone from a FRESH read => cleared,
          // interrupted, or a server that restarted => put back with its seed.
          if ((await queueFresh()).ids.has(run.promptId)) {
            report.left += 1;
            continue;
          }
          if (!ours()) continue;
          dead.add(run.promptId);
          run.promptId = null;
          run.status = 'pending';
          run.progress = 0;
          run.startedAt = null;
          run.endedAt = null;
          run.error = null;
          run.queue = null;
          run.ahead = null;
          run.node = null;
          run.wsFailed = false;
          report.requeued += 1;
          touched.add(job);
          continue;
        }

        if (run.fp) {
          // The POST went out but the answer never came back: no id, but the
          // payload has a fingerprint. Queue first - the work is there and
          // must not be sent twice - then history: it FINISHED while the
          // answer was lost, so it is collected, not resent. In neither means
          // the prompt never landed, and a run that never landed is submitted
          // normally by the pump.
          let match = findByFingerprint(free(snapshot.pairs), run.fp);
          if (!match) match = findByFingerprint(free((await queueFresh()).pairs), run.fp);
          if (match) {
            if (!ours()) continue;
            run.promptId = match.id;
            run.status = 'submitted';
            claimed.add(match.id);
            report.adopted += 1;
            touched.add(job);
            continue;
          }
          const hist = free(await loadHistory());
          const done = findByFingerprint(hist, run.fp);
          if (done) {
            if (!ours()) continue;
            claimed.add(done.id);
            const entry = hist.find((p) => p.id === done.id)?.entry;
            const st = entry?.status ?? {};
            if (st.completed === true) {
              await this.#collectSwept(job, run, entry?.outputs ?? {});
              report.collected += 1;
              touched.add(job);
            } else if (st.status_str === 'error') {
              run.status = 'error';
              run.error = errorMessage(st);
              run.endedAt = run.endedAt ?? new Date().toISOString();
              report.failed += 1;
              touched.add(job);
            } else {
              report.left += 1;
            }
            continue;
          }
          report.left += 1;
          continue;
        }

        report.left += 1; // never reached ComfyUI: nothing to ask
      } catch (e) {
        if (isConnectionError(e)) {
          // Half-judged is worse than unjudged: stop here. What the sweep
          // already collected is real; everything it did not reach keeps its
          // state, and resume's own reattach still has the last word.
          report.ok = false;
          report.problem = e.message;
          break outer;
        }
        report.ok = false;
        report.problem = e.message;
        report.left += 1;
      }
    }

    // Jobs that are over now. The queue may be held (connection, hand) and the
    // pump may not come back for a while, so finished work is closed HERE:
    // the History tab gets its rows without waiting for a resume, and the
    // queue strip stops showing jobs whose every run already landed.
    for (const job of this.#jobs.values()) {
      if (job.id === this.#activeId || FINISHED.has(job.status)) continue;
      if (!job.runs.every((r) => FINISHED.has(r.status))) continue;
      job.status = job.runs.every((r) => r.status === 'error')
        ? 'error'
        : job.runs.every((r) => r.status === 'cancelled')
          ? 'cancelled'
          : 'done';
      job.finishedAt = job.finishedAt ?? new Date().toISOString();
      history.finish(job.id, {
        status: job.status,
        results: job.runs.reduce((n, r) => n + r.images.length, 0),
        seeds: job.runs.map((r) => r.seed).filter((s) => s !== null && s !== undefined),
        promptTexts: job.runs
          .filter((r) => r.promptText)
          .map((r) => ({
            runIndex: r.index,
            seed: r.seed ?? null,
            source: promptSourceFor(job.spec),
            text: r.promptText,
          })),
      });
      const at = this.#waiting.indexOf(job);
      if (at !== -1) this.#waiting.splice(at, 1);
      report.closed += 1;
      touched.add(job);
    }

    for (const job of touched) this.#emit(job);
    if (report.collected || report.requeued || report.adopted || report.failed || report.closed) {
      console.log(
        `[runner] resync: collected ${report.collected}, adopted ${report.adopted}, ` +
        `requeued ${report.requeued}, failed ${report.failed}, closed ${report.closed}` +
        `${report.ok ? '' : ` (incomplete: ${report.problem})`}`,
      );
    }
    return report;
  }

  /**
   * Collect a run that finished while nobody was watching - the sweep's copy
   * of #run's success path, because the monitor is not running for these runs
   * and never will be.
   */
  async #collectSwept(job, run, outputs) {
    if (job.spec.collectImages) await this.#collect(job, run, outputs);
    else run.outputs = collectImages(outputs, config().collectNodes);
    await this.#collectPromptText(run, outputs);
    run.status = 'done';
    run.progress = 100;
    run.endedAt = run.endedAt ?? new Date().toISOString();
  }

  get(id) {
    const j = this.#jobs.get(id);
    return j ? snapshot(j, this.#waiting) : null;
  }

  cancel(id) {
    const j = this.#jobs.get(id);
    if (!j) return false;
    j.cancelRequested = true;
    // Pull it out of the waiting list so a cancelled job does not occupy the
    // slot for the job behind it until the pump reaches it.
    const at = this.#waiting.findIndex((w) => w.id === id);
    if (at !== -1) {
      this.#waiting.splice(at, 1);
      j.status = 'cancelled';
      j.finishedAt = new Date().toISOString();
      // This job never reaches runJob, so its finally block never calls
      // finish() - stamp the history row here or it stays stuck on "running".
      history.finish(j.id, { status: 'cancelled', results: 0, seeds: [] });
      this.#emit(j);
    }
    // Prompts already handed to ComfyUI keep running unless we call them off.
    // Only the ones that have not started can go - ComfyUI refuses to delete the
    // running one, which is also the only one this app is watching closely.
    const queued = j.runs.filter((r) => r.promptId && r.status === 'submitted');
    for (const r of queued) {
      // No run loop is watching these - they were handed over in bulk and their
      // turn never came - so nothing else would ever move them out of "submitted".
      r.status = 'cancelled';
      r.error = 'cancelled';
      r.endedAt = new Date().toISOString();
      this.client().deleteQueuedPrompt(r.promptId).catch(() => null);
    }
    this.#controllers.get(id)?.abort();
    this.#emitQueue();
    return true;
  }

  /**
   * Validate + enqueue. Throws on bad input so the route can 400.
   *
   * Two kinds of job share ONE queue on purpose: ComfyUI has a single queue and
   * one GPU, so a long upscale queued behind three generations is exactly what
   * happens upstream anyway. Everything downstream - pause, resume, cancel,
   * "send everything", the SSE stream - is kind-agnostic, so the only thing that
   * differs is which workflow is read and how the payload is built.
   */
  enqueue(input) {
    if (input?.kind === 'upscale') return this.#enqueueUpscale(input);
    const v = validateJob(input, { maxImages: config().maxImages });
    if (!v.ok) {
      const err = new Error(v.errors.join('; '));
      err.status = 400;
      err.errors = v.errors;
      throw err;
    }

    const spec = {
      // Stamped here rather than read off the body, for the same reason the two
      // routes stamp it: a record that does not say what it is would have to be
      // guessed at on restore, and "guess" is how a generate job ends up in the
      // upscale workflow.
      kind: 'generate',
      prompt: v.prompt,
      // Added to the prompt by node 257 after enhancement, and concatenated onto
      // the text that SaveText captures - so it needs no capture of its own.
      postprompt: v.postprompt,
      megapixels: v.megapixels,
      batch: input.batch,
      shuffle: input.shuffle,
      promptEnhance: v.promptEnhance,
      turbo: input.turbo === true,
      stepsOverride: input.stepsOverride ?? null,
      inputResolution: v.inputResolution,
      collectImages: input.collectImages !== false,
      // When the override switch (node 68) fires: once per shuffle group by default.
      refresh: v.refresh,
      // Resolution, split three ways: the float megapixels node (232), whether
      // the enhancer picks the aspect (233) and which combo to use when it does
      // not (node 9). validateJob has already forced 233 off without the enhancer.
      useSuggestedAspect: v.useSuggestedAspect,
      aspectRatio: v.aspectRatio,
      consistency: v.consistency,
      // null = a fresh seed per run. A number pins every run of the job to it.
      seed: v.seed,
      // sparse: [{uploadId} | {ref: {filename,subfolder,type}} | null, ...] up to 4
      slots: hydrateSlots(normalizeSlots(input, config().maxImages)),
    };

    // Derived once so the History card can label the saved text honestly.
    spec.imageCount = spec.slots.filter(Boolean).length;

    const id = crypto.randomUUID();
    const job = {
      id,
      createdAt: new Date().toISOString(),
      status: 'queued',
      authFailed: false,
      cancelRequested: false,
      error: null,
      spec,
      runs: planRuns(spec).map((r, i) => ({
        ...r,
        index: i,
        seed: null,
        status: 'pending',
        startedAt: null,
        endedAt: null,
        queue: null,
        ahead: null,
        error: null,
        images: [],
      })),
      current: -1,
    };
    this.#jobs.set(id, job);
    this.#controllers.set(id, new AbortController());

    // Remember the prompt before anything can fail, so a run that errors out
    // is still one tap away from being repeated.
    history.record({
      prompt: spec.prompt,
      settings: {
        megapixels: spec.megapixels,
        batch: spec.batch,
        shuffle: spec.shuffle,
        promptEnhance: spec.promptEnhance,
        // Only worth remembering when it said something. It is also already
        // inside every captured prompt (node 257 feeds SaveText), so the row can
        // always be re-run from the capture even if this is dropped.
        postprompt: spec.postprompt,
        turbo: spec.turbo,
        stepsOverride: spec.stepsOverride,
        inputResolution: spec.inputResolution,
        collectImages: spec.collectImages,
        refresh: spec.refresh,
        useSuggestedAspect: spec.useSuggestedAspect,
        aspectRatio: spec.aspectRatio,
        consistency: spec.consistency,
        // Only worth remembering when it was pinned: the seeds actually used are
        // already on the row, and a null here just means "random".
        seed: spec.seed,
      },
      slots: input.slots ?? input.uploadIds ?? input.imageRefs ?? [],
      jobId: id,
    });

    // Fire and forget - the job reports through #emit. #pump starts it when
    // the previous job has finished. #persist is called explicitly because a
    // paused queue never reaches #emitQueue, and a job accepted while paused is
    // exactly the one that must not be lost to a restart.
    this.#waiting.push(job);
    this.#persist();
    this.#pump();
    return snapshot(job, this.#waiting);
  }

  /**
   * The Upscale tab's job: one image, one run, a second workflow.
   *
   * One run even when the box asks for several images, because 506's `batch_size`
   * IS the latent: N there means N images out of a single pass, which shares the
   * model load, the text encode and the VAE instead of paying for them again per
   * image. There is still no shuffle - the graph is a single SaveImage fed one
   * LoadImage, and the two samplers share one seed node. The single run still
   * carries the counters (group 0, batch 0, image 0) that the filename template
   * and the gallery entries are named from.
   */
  #enqueueUpscale(input) {
    const maxImages = config().maxImages;
    const v = validateUpscale(input, { maxImages });
    if (!v.ok) {
      const err = new Error(v.errors.join('; '));
      err.status = 400;
      err.errors = v.errors;
      throw err;
    }

    const slots = hydrateSlots(v.slots);
    const source = slots[0];
    const spec = {
      kind: 'upscale',
      // What the queue row and the history row show. There is no prompt text to
      // show, so the job is named after what it does to which picture.
      prompt: `upscale ${describeSource(source)} ×${trimScale(v.scale)}${v.batch > 1 ? ` ×${v.batch} images` : ''}`,
      scale: v.scale,
      scaleToDim: v.scaleToDim,
      targetWidth: v.targetWidth,
      targetHeight: v.targetHeight,
      guidance: v.guidance,
      seed: v.seed,
      collectImages: input.collectImages !== false,
      // Present so the rest of the app (filename template, chips, queue meta) can
      // read them without asking what kind of job it is looking at. `batch` here
      // is the image count the one run produces, NOT a run count.
      batch: v.batch,
      shuffle: 1,
      slots,
    };
    spec.imageCount = slots.filter(Boolean).length;

    const id = crypto.randomUUID();
    const job = {
      id,
      createdAt: new Date().toISOString(),
      status: 'queued',
      authFailed: false,
      cancelRequested: false,
      error: null,
      spec,
      runs: [{
        group: 0,
        indexInGroup: 0,
        isFirstOfGroup: true,
        refreshOverride: true,
        index: 0,
        seed: null,
        status: 'pending',
        startedAt: null,
        endedAt: null,
        queue: null,
        ahead: null,
        error: null,
        images: [],
      }],
      current: -1,
    };
    this.#jobs.set(id, job);
    this.#controllers.set(id, new AbortController());

    // The whole spec is worth remembering, because every field here is something
    // the user can change on the Upscale tab - including the image, which rides
    // along in `slots` the same way a generation's references do.
    history.record({
      prompt: spec.prompt,
      settings: {
        kind: 'upscale',
        scale: spec.scale,
        scaleToDim: spec.scaleToDim,
        targetWidth: spec.targetWidth,
        targetHeight: spec.targetHeight,
        guidance: spec.guidance,
        seed: spec.seed,
        batch: spec.batch,
        collectImages: spec.collectImages,
      },
      slots: input.slots ?? input.uploadIds ?? input.imageRefs ?? [],
      jobId: id,
    });

    this.#waiting.push(job);
    this.#persist();
    this.#pump();
    return snapshot(job, this.#waiting);
  }

  /**
   * Start the next waiting job if nothing is running and the queue is live.
   *
   * Also steps aside while a resync sweep is judging prompts: submitting a run
   * the sweep is about to adopt or requeue is how the same work gets sent
   * twice. The sweep's own finally pumps, so nothing is lost by waiting.
   */
  #pump() {
    if (this.#activeId || this.#paused || this.#resyncing) return;
    const next = this.#waiting.shift();
    if (!next) return;
    this.#activeId = next.id;
    this.#emitQueue();
    this.#run(next)
      .catch((e) => console.error('[runner] unhandled', e))
      .finally(() => {
        this.#activeId = null;
        this.#emitQueue();
        this.#pump();
      });
  }

  #emit(job) {
    this.emit('update', snapshot(job, this.#waiting));
    this.#persist();
  }

  async #run(job) {
    const { signal } = this.#controllers.get(job.id);
    job.status = 'running';
    this.#emit(job);

    try {
      // Before anything of ours reaches ComfyUI: if its queue already holds work
      // from another device, this job waits instead of joining that queue where
      // it would be invisible and out of reach.
      if (await this.#holdIfComfyBusy(job)) return;
      const wf = readWorkflowFor(job);
      const slots = job.spec.slots;
      // Staged once per job and remembered: "send everything" and a resume can
      // both reach this job again, and re-uploading the same references would
      // hand the workflow a second, differently named copy of the same image.
      let comfyImages = job.stagedImages ?? null;
      if (!comfyImages && slots.some((s) => s !== null)) {
        comfyImages = await this.#stageImages(job, slots);
        job.stagedImages = comfyImages;
      }

      for (const run of job.runs) {
        if (signal.aborted) break;
        // A job that comes back from a pause has runs it already finished and
        // runs already sitting in ComfyUI's queue. The first are done; the
        // second only need watching - submitting them twice would burn a seed
        // and produce a second copy of the same image.
        if (FINISHED.has(run.status)) continue;
        // A prompt id that came off DISK is a different question. The phone may
        // have restarted, and ComfyUI with it - and then that prompt is in
        // neither /history nor /queue. monitor() deliberately never judges a
        // prompt lost until it has watched it enter the queue, which is right for
        // a run it submitted itself and wrong here: left alone it would watch a
        // prompt that will never reappear until the battery dies. So ask once,
        // now, and let a job whose work ComfyUI has forgotten fail honestly.
        if (run.resumedFromDisk) {
          run.resumedFromDisk = false;
          if (!(await this.#promptStillKnown(run))) {
            run.status = 'error';
            run.error =
              'the mobile server restarted while ComfyUI was running this prompt, ' +
              'and ComfyUI has no record of it any more';
            run.endedAt = new Date().toISOString();
            this.#emit(job);
            continue;
          }
        }
        job.current = run.index;
        const reattaching = Boolean(run.promptId);
        if (!reattaching) run.status = 'running';
        this.#emit(job);

        try {
          const client = this.client();
          if (!reattaching) {
            // Rolls the seed, writes the payload and records the prompt id -
            // the same path "send everything" takes, so a run submitted by the
            // queue and one submitted by hand are identical afterwards.
            await this.#submitRun(job, run, wf, comfyImages ?? []);
            run.status = 'running';
          }

          let lastPct = -1;
          const result = await client.monitor(run.promptId, {
            signal,
            onEvent: (ev) => {
              if (ev.type === 'progress') {
                const pct = ev.max > 0 ? Math.round((ev.value / ev.max) * 100) : 0;
                if (pct !== lastPct) {
                  lastPct = pct;
                  run.progress = pct;
                  this.#emit(job);
                }
              } else if (ev.type === 'started') {
                // Guarded: a re-attached run keeps the start time it had before
                // the pause, and /history can report the start and the finish in
                // the same poll.
                if (!run.startedAt) {
                  run.startedAt = new Date(ev.at ?? Date.now()).toISOString();
                  this.#emit(job);
                }
              } else if (ev.type === 'executing') {
                run.node = ev.node;
                this.#emit(job);
              } else if (ev.type === 'error') {
                run.error = ev.message;
                this.#emit(job);
              } else if (ev.type === 'queue') {
                run.queue = ev.remaining;
                run.ahead = ev.position ?? null;
                this.#emit(job);
              } else if (ev.type === 'ws-failed') {
                run.wsFailed = true;
                this.#emit(job);
              }
            },
          });

          if (job.spec.collectImages) {
            await this.#collect(job, run, result.outputs);
          } else {
            run.outputs = collectImages(result.outputs, config().collectNodes);
          }
          await this.#collectPromptText(run, result.outputs);
          run.status = 'done';
          run.progress = 100;
        } catch (e) {
          if (signal.aborted) {
            run.status = 'cancelled';
          } else if (e instanceof AuthError) {
            job.authFailed = true;
            job.error = e.message;
            run.status = 'error';
            run.error = e.message;
            this.#emit(job);
            break;
          } else if (isConnectionError(e)) {
            // Not this run's fault, and not the queue's either: ComfyUI went
            // away mid-flight. Hold everything rather than marking a job failed
            // for a phone that is out of range - the prompt may well still be
            // running up there, and a resume re-attaches to it by prompt id.
            run.status = run.promptId ? 'paused' : 'pending';
            this.#hold(job, e);
            break;
          } else {
            run.status = 'error';
            run.error = e.message;
          }
        }
        if (run.status !== 'paused') run.endedAt = new Date().toISOString();
        this.#emit(job);
      }

      if (signal.aborted) job.status = 'cancelled';
      else if (job.authFailed) job.status = 'error';
      else if (job.status === 'paused') { /* held - #run's finally leaves it open */ }
      else if (job.runs.every((r) => r.status === 'error')) job.status = 'error';
      else job.status = 'done';
    } catch (e) {
      if (job.cancelRequested) {
        job.status = 'cancelled';
        job.error = e.message;
      } else if (isConnectionError(e)) {
        // Same reasoning as inside the run loop - this is where a staging
        // upload or a read of the workflow loses the server.
        this.#hold(job, e);
      } else {
        job.status = 'error';
        job.error = e.message;
        if (e instanceof AuthError) job.authFailed = true;
        console.error('[runner]', job.id, e);
      }
    } finally {
      job.current = -1;
      // A held job is not over. No finishedAt, no history row stamped - both
      // would tell the History tab a paused job was cancelled when it was only
      // waiting for the network to come back.
      if (job.status !== 'paused') {
        job.finishedAt = new Date().toISOString();
        history.finish(job.id, {
          status: job.status,
          results: job.runs.reduce((n, r) => n + r.images.length, 0),
          seeds: job.runs.map((r) => r.seed).filter((s) => s !== null && s !== undefined),
          // Every run that captured text, in order. Runs 2..N of a shuffle group
          // share one enhanced prompt (that is what the refresh switch buys) and
          // the enhancer only re-words when it actually refreshes, so this is
          // usually one entry - but "usually" is doing real work here, and the
          // list is what makes the difference visible instead of assumed.
          promptTexts: job.runs
            .filter((r) => r.promptText)
            .map((r) => ({
              runIndex: r.index,
              seed: r.seed ?? null,
              source: promptSourceFor(job.spec),
              text: r.promptText,
            })),
        });
      }
      this.#emit(job);
    }
  }

  /**
   * Park a job and the whole queue, because ComfyUI stopped answering.
   *
   * The job goes back to the FRONT of the waiting list: it is the one holding the
   * connection, and it may own a prompt that is still executing up there. Its
   * history row stays open, its seeds stay, and no prompt is submitted twice.
   */
  #hold(job, e, reason = 'connection') {
    const at = this.#waiting.indexOf(job);
    if (at !== -1) this.#waiting.splice(at, 1);
    this.#waiting.unshift(job);
    job.status = 'paused';
    job.error = e.message;
    this.pause(reason, e.message);
    this.#emit(job);
  }

  /**
   * Is a prompt id read back off disk still known to ComfyUI?
   *
   * Yes if it is in /history (finished, or at least remembered) or in /queue.
   * Only "in neither" means it is gone - a ComfyUI that restarted has an empty
   * history and an empty queue. A probe that could not answer at all is not
   * evidence, so it answers yes and lets monitor() sort it out; that is the same
   * reasoning the queue itself uses for an unreadable /queue.
   */
  async #promptStillKnown(run) {
    if (!run.promptId) return true;
    try {
      const entry = await this.client().historyEntry(run.promptId);
      if (entry) return true;
      const q = await this.client().queueLookup(run.promptId);
      if (q.state !== 'absent') return true;
      console.warn(`[runner] prompt ${run.promptId} is in neither ComfyUI's history nor its queue`);
      return false;
    } catch (e) {
      // ComfyUI is unreachable. That is not this run's fault and it is not
      // evidence that the prompt vanished - monitor() holds the queue instead.
      console.warn(`[runner] could not check prompt ${run.promptId}: ${e.message}`);
      return true;
    }
  }

  // ------------------------------------------------ ComfyUI's own queue
  /**
   * Prompts in ComfyUI's queue that this app did not send - work from another
   * device, or another window, on the same ComfyUI.
   *
   * Returns `null` for "go ahead" in three cases, and the distinction matters:
   *
   *   - the queue is empty
   *   - everything in it is OURS (a prompt already handed over by a resume or by
   *     "send all"), which must never hold this app behind its own work - that
   *     would deadlock the queue behind itself
   *   - the probe FAILED. A queue that cannot be read is not a queue that is
   *     empty, but it is also not proof of anything, and refusing to start on a
   *     failed read would strand the phone for a transient blip.
   */
  async #foreignBusy() {
    const q = await this.client().queueBusy({ timeoutMs: 8000 });
    if (!q.ok || q.ids.length === 0) return null;
    const mine = new Set();
    for (const j of this.#jobs.values()) {
      for (const r of j.runs) if (r.promptId) mine.add(r.promptId);
    }
    const foreign = q.ids.filter((id) => !mine.has(id));
    if (!foreign.length) return null;
    return { foreign: foreign.length, total: q.ids.length };
  }

  /**
   * Do not add work of our own to a GPU that is already working on somebody
   * else's.
   *
   * This app holds its jobs until it can watch each one finish, and ComfyUI runs
   * one prompt at a time. A prompt from another device therefore jumps in front
   * of the run we are about to submit, and the phone - which may well be out of
   * range by the time it finishes - quietly stops being the thing that decides
   * when its own work starts. So the job waits here, in the open, where the
   * queue strip can say why, instead of being buried in ComfyUI's own queue
   * where nothing would show it.
   *
   * Checked once per job, before its first unsubmitted run: checking before every
   * run would also catch the tail of OUR OWN last prompt lingering in the queue a
   * moment after ComfyUI finished it, and hold the next run for nothing.
   *
   * Returns true when the job was held (so the caller must stop).
   */
  async #holdIfComfyBusy(job) {
    const needsSubmit = job.runs.some((r) => !FINISHED.has(r.status) && !r.promptId);
    if (!needsSubmit) return false;
    let busy = null;
    try {
      busy = await this.#foreignBusy();
    } catch (e) {
      // A probe that throws is treated exactly like one that failed.
      busy = null;
      console.error('[runner] ComfyUI queue probe failed', e);
    }
    if (!busy) return false;
    const where = busy.foreign === 1 ? 'a prompt' : `${busy.foreign} prompts`;
    console.log(`[runner] holding ${job.id}: ComfyUI is busy with ${where} this app did not send`);
    this.#hold(
      job,
      new Error(
        `ComfyUI is busy with ${where} this app did not send (${busy.total} in its queue) - probably another device`,
      ),
      'busy',
    );
    this.#startIdleWatch();
    return true;
  }

  /** Watch ComfyUI's queue while the queue is held on its account. */
  #startIdleWatch() {
    if (this.#idleTimer) return;
    this.#idleTimer = setInterval(() => { this.#checkIdle(); }, IDLE_POLL_MS);
    // Never hold the process open for it - the shut-down button and a Ctrl-C in
    // Termux have to be able to leave while a foreign job is still running.
    this.#idleTimer.unref?.();
    this.#checkIdle();
  }

  #stopIdleWatch() {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#idleTimer = null;
    this.#idleProbe = null;
  }

  /**
   * Watch for ComfyUI answering again while the queue is held on the
   * CONNECTION.
   *
   * The idle watch resumes by itself: a foreign job finishing is a decision
   * that was already made. This one must NOT resume - a link that blipped
   * while four jobs were queued should not quietly start four generations.
   * What it does instead is resync: collect whatever finished during the gap,
   * adopt whatever is already queued, requeue whatever vanished - so results
   * reconcile even if nobody ever opens the page again. Resume stays a
   * deliberate tap, and a resume always resyncs first anyway.
   */
  #startBackWatch() {
    if (this.#backTimer) return;
    this.#backTimer = setInterval(() => { this.#checkBack(); }, BACK_POLL_MS);
    // Never hold the process open for it - same as the idle watch: the
    // shut-down button and a Ctrl-C in Termux must be able to leave.
    this.#backTimer.unref?.();
    this.#checkBack();
  }

  #stopBackWatch() {
    if (this.#backTimer) clearInterval(this.#backTimer);
    this.#backTimer = null;
    this.#backProbe = null;
  }

  async #checkBack() {
    if (!this.#paused || this.#pauseReason !== 'connection' || this.#backProbe) return;
    this.#backProbe = comfyHealth(this.client())
      .catch(() => null)
      .finally(() => { this.#backProbe = null; });
    const health = await this.#backProbe;
    if (!health || health.state !== 'ok') return;
    // Only if it is STILL this hold: a manual pause or a resume in the
    // meantime outranks it.
    if (!this.#paused || this.#pauseReason !== 'connection') return;
    // One successful reconciliation per hold is enough: whatever finishes
    // AFTER it can only be collected by a resume anyway, and a resume always
    // resyncs first. A sweep that could not do its job (lastResync not ok)
    // retries on the next tick.
    const done = this.#lastResync;
    if (done?.ok && this.#pausedAt && done.at >= this.#pausedAt) return;
    console.log('[runner] ComfyUI answers again - reconciling what happened while it was away');
    await this.resync();
  }

  async #checkIdle() {
    if (!this.#paused || this.#pauseReason !== 'busy' || this.#idleProbe) return;
    this.#idleProbe = this.#foreignBusy()
      .catch(() => null)
      .finally(() => { this.#idleProbe = null; });
    const busy = await this.#idleProbe;
    // Only if it is STILL this hold: a manual pause, a cancel or a lost
    // connection in the meantime all outrank it.
    if (busy) return;
    if (!this.#paused || this.#pauseReason !== 'busy') return;
    console.log('[runner] ComfyUI\'s queue is empty again - carrying on');
    await this.resume();
  }

  /**
   * Hand every waiting run to ComfyUI right now.
   *
   * The normal queue holds work on the phone until it is ready to watch each run
   * finish. That is the wrong shape when the phone is about to leave the network:
   * the only machine that will still be awake afterwards is ComfyUI itself. This
   * submits everything - the rest of the running job too, not just what is
   * waiting - so the work is already in ComfyUI's queue when the phone walks
   * away, and comes back as a queue of results to collect.
   *
   * Submission order is preserved, because ComfyUI runs its queue in the order it
   * was given it. Runs already submitted are left alone, so pressing this twice
   * costs nothing.
   */
  async submitAll() {
    const report = { jobs: 0, runs: 0, alreadySubmitted: 0, failures: [], prompts: [] };
    // Running job first: its remaining runs keep the place it already has in
    // ComfyUI's queue, ahead of everything queued behind it.
    const order = [
      ...(this.#activeId ? [this.#jobs.get(this.#activeId)] : []),
      ...this.#waiting,
    ].filter(Boolean);

    for (const job of order) {
      // A run the queue is submitting right this second counts as handed over
      // already: it is on its way to ComfyUI, and #submitRun refuses to send it
      // twice.
      const taken = (r) => r.promptId || this.#submitting.has(r);
      const todo = job.runs.filter((r) => !taken(r) && !FINISHED.has(r.status));
      report.alreadySubmitted += job.runs.filter(
        (r) => taken(r) && !FINISHED.has(r.status),
      ).length;
      if (!todo.length) continue;
      try {
        const images = await this.#stageFor(job);
        const wf = readWorkflowFor(job);
        for (const run of todo) {
          const promptId = await this.#submitRun(job, run, wf, images);
          report.runs += 1;
          report.prompts.push(promptId);
        }
        report.jobs += 1;
        this.#emit(job);
      } catch (e) {
        if (isConnectionError(e)) {
          // Half the work may already be in ComfyUI's queue. Hold and report it
          // - the resume will pick up exactly the runs still missing.
          this.#hold(job, e);
          report.failures.push({ jobId: job.id, message: e.message });
          break;
        }
        // A rejected prompt is one run's problem, not the queue's: say which.
        for (const run of todo) {
          if (!run.promptId) {
            run.status = 'error';
            run.error = e.message;
          }
        }
        report.failures.push({ jobId: job.id, message: e.message });
        this.#emit(job);
      }
    }
    // "Send everything" is the way past a hold for ComfyUI's own queue: the work
    // is in ComfyUI's queue now, which is exactly what the hold was refusing to
    // do, so holding any longer would keep the results unwatched for nothing.
    // Awaited (not fired): the resume now reconciles first, and its sweep must
    // not overlap the report this function is about to return.
    if (this.#paused && this.#pauseReason === 'busy') await this.resume();
    this.#emitQueue();
    return report;
  }

  /** Stage a job's references, or reuse the copy it already uploaded. */
  async #stageFor(job) {
    const slots = job.spec.slots;
    if (!slots.some((s) => s !== null)) return [];
    if (!job.stagedImages) job.stagedImages = await this.#stageImages(job, slots);
    return job.stagedImages;
  }

  /** Submit one run and record everything needed to watch or re-attach to it. */
  async #submitRun(job, run, wf, images) {
    // "Send everything" and the queue can reach the same run at the same
    // moment - the pump may be submitting it right now. Whoever gets here first
    // owns the prompt id; the other one must not roll a second seed on top of it.
    //
    // The claim has to be taken BEFORE the request goes out, not after the prompt
    // id comes back: between the two, the run has no prompt id yet but its prompt
    // is already on its way to ComfyUI, so a second submitter would see "not
    // submitted" and send it again. That costs a seed and leaves a duplicate image
    // in ComfyUI's queue for a run the phone already believes it handed over.
    if (run.promptId || this.#submitting.has(run)) return run.promptId;
    this.#submitting.add(run);
    try {
      // The seed goes into the payload, so it is rolled before the payload is built
      // and the same number is kept afterwards - otherwise the recorded seed would
      // not be the seed that produced the image. A seed pinned on the job wins, so
      // re-running a prompt reproduces the image instead of wandering off. A seed
      // this run already rolled (a requeue putting vanished work back with its
      // original seed) is kept for the same reason: the retry is the SAME run.
      run.seed = job.spec.seed ?? run.seed ?? newSeed();
      const payload = this.#buildPayload(job, run, wf, images ?? []);
      // Identity BEFORE the request goes out: if the answer never arrives -
      // crash, dropped link, half-written response - the next resync finds this
      // exact payload in ComfyUI's queue (adopt the id) or its history (collect
      // it) instead of burning a second seed on work that already exists.
      run.fp = fingerprintOf(payload);
      this.#persist();
      const submitted = await this.client().submitPrompt(payload, {
        clientId: run.index === 0 ? job.id : undefined,
      });
      const promptId = submitted?.prompt_id;
      if (!promptId) {
        throw new ComfyError(submitted?.error?.message || 'ComfyUI rejected the prompt', {
          status: 400,
          kind: 'http',
          body: JSON.stringify(submitted?.error ?? {}),
        });
      }
      run.promptId = promptId;
      run.status = 'submitted';
      // startedAt is NOT stamped here. This run has been handed over, not begun:
      // with three prompts already in ComfyUI's queue the wait can be minutes,
      // and a timer that starts on submit bills the queue for it. The monitor's
      // 'started' event stamps it when ComfyUI actually picks the prompt up.
      return promptId;
    } finally {
      this.#submitting.delete(run);
    }
  }

  /**
   * The payload for one run. The only place that knows which of the three graphs
   * a job belongs to - and the only reason they can share a queue, a submit
   * path, a monitor and a downloader.
   *
   * Generate picks its file AND its bindings map from the same flag
   * (`promptEnhance === false`), so the two can never disagree: the enhanceless
   * graph has no Input Prompt (41) / Enhance switch (176) / Postprompt (256) /
   * refresh (68), and pointing those writes at it would throw "node not in the
   * workflow".
   */
  #buildPayload(job, run, wf, images) {
    if (job.spec.kind === 'upscale') {
      return buildUpscalePayload(wf, state.config.upscaleBindings, {
        // The upscale graph has one LoadImage, and staging already uploaded the
        // picture and got back the name ComfyUI knows it by.
        image: images.find(Boolean) ?? null,
        scale: job.spec.scale,
        scaleToDim: job.spec.scaleToDim,
        targetWidth: job.spec.targetWidth,
        targetHeight: job.spec.targetHeight,
        guidance: job.spec.guidance,
        seed: run.seed,
        // Every value this graph reads has to be copied in here by name. A field
        // left off this list is a silent no-op: the binding validates, the write
        // never happens, and the run quietly produces one image instead of N.
        batch: job.spec.batch,
      });
    }
    const bindings =
      job.spec.promptEnhance === false ? state.config.enhancelessBindings : state.config.bindings;
    return buildRunPayload(wf, bindings, runPayloadOptions(job.spec, run, images ?? []));
  }

  /** Upload every requested image into ComfyUI's input dir, once per job. */
  async #stageImages(job, slots) {
    const client = this.client();
    const out = [];
    for (const slot of slots) {
      if (!slot) {
        out.push(null);
        continue;
      }
      const buf = slot.uploadId
        ? readUpload(slot.uploadId)
        : await client.viewImage(slot.ref);
      if (!buf) throw new Error(`could not read reference image ${JSON.stringify(slot)}`);
      // Upload under the extension the source really has, or ComfyUI's loader
      // will be handed a JPEG's bytes labelled .png.
      const name = await pushToComfyInput(client, buf, path.extname(slot.filename || '') || '.png');
      out.push(name);
    }
    return out;
  }

  /**
   * Fetch the SaveText output(s) for this run and remember the string the text
   * encoder actually received. Never fatal: a missing or unreadable text file
   * just means the History card has nothing to expand.
   *
   * `promptSource` is derived from what we ASKED for, not from the file: the
   * workflow falls back to the raw prompt on its own whenever the enhancer is
   * bypassed, and labelling that "enhanced" would be a lie.
   */  async #collectPromptText(run, outputs) {
    const entries = collectText(outputs, config().promptTextNodes);
    if (!entries.length) return;
    const entry = entries[0];
    try {
      // SaveText inlines the string in its history output, so the common path is
      // no HTTP round trip at all. Only if that is missing do we go and read the
      // file it wrote - which needs the authed client, and is the reason this
      // must never be allowed to fail the run.
      let text = (entry.texts ?? []).join('\n').trim();
      if (!text && entry.files?.length) {
        const buf = await this.client().viewImage(entry.files[0]);
        text = Buffer.from(buf).toString('utf8').trim();
      }
      if (!text) return;
      run.promptText = text;
      run.promptTextNode = entry.node;
      run.promptTextFile = entry.files?.[0]?.filename ?? null;
    } catch (e) {
      console.warn(`[runner] prompt text fetch failed: ${e.message}`);
    }
  }

  /** Download this run's images and record them in the gallery. */
  async #collect(job, run, outputs) {
    const images = collectImages(outputs, config().collectNodes);
    run.outputs = images;
    const dir = paths().downloadDir;
    if (dir) ensureDir(dir);

    for (const [i, img] of images.entries()) {
      const ctx = {
        prompt: job.spec.prompt,
        seed: run.seed,
        index: run.index,
        group: run.group,
        // The three counters that name a picture: which shuffle group, which
        // image of the batch, and which output of this single run.
        shuffle: run.group,
        batch: run.indexInGroup ?? run.index,
        img: i,
        node: img.node,
      };
      let saved = null;
      if (dir) {
        try {
          saved = await downloadImage(this.client(), img, {
            dir,
            template: config().filenameTemplate,
            ctx,
          });
        } catch (e) {
          run.errors = run.errors ?? [];
          run.errors.push(`download failed: ${e.message}`);
        }
      }
      run.images.push(
        addEntry({
          jobId: job.id,
          // Which graph made this, so the gallery and the history row can label an
          // upscaled picture as one instead of guessing from the prompt text.
          kind: job.spec.kind ?? 'generate',
          runIndex: run.index,
          group: run.group,
          // The three counters, recorded on the entry itself so that a retry of a
          // failed download rebuilds the exact name it would have written. Without
          // them the retry has to invent one, and you end up with near-duplicates.
          shuffle: run.group,
          batch: run.indexInGroup ?? run.index,
          img: i,
          node: img.node,
          comfyFilename: img.filename,
          subfolder: img.subfolder ?? '',
          type: img.type ?? 'output',
          prompt: job.spec.prompt,
          seed: run.seed,
          localPath: saved?.path ?? null,
          localName: saved?.name ?? null,
          bytes: saved?.bytes ?? null,
        }),
      );
    }
    this.#emit(job);
  }
}

/**
 * Fill in the ComfyUI coordinates a `{ref: galleryId}` needs, and the real
 * extension for both kinds of source. Kept here rather than in payload.js so the
 * normaliser stays free of gallery/upload lookups (and testable on its own).
 */
function hydrateSlots(slots) {
  return slots.map((slot) => {
    if (!slot) return null;
    if (slot.uploadId) {
      const up = findUpload(slot.uploadId);
      return up ? { uploadId: slot.uploadId, filename: up.file } : null;
    }
    if (typeof slot.ref === 'string') {
      const entry = findEntry(slot.ref);
      return entry ? { ref: { filename: entry.comfyFilename, subfolder: entry.subfolder, type: entry.type } } : null;
    }
    // Already hydrated.
    return slot.ref ? { ...slot, filename: slot.filename || slot.ref.filename } : null;
  });
}

/** The file name an upscale job's image came from, for its queue/history label. */
function describeSource(slot) {
  if (!slot) return 'image';
  return slot.filename || slot.ref?.filename || 'image';
}

/** 2 -> "2", 1.25 -> "1.25". Keeps "upscale cat.png ×2" from reading "×2.00". */
function trimScale(scale) {
  const n = Number(scale);
  return Number.isFinite(n) ? String(Number(n.toFixed(2))) : String(scale);
}

/**
 * Which workflow this job runs on. All files are read fresh per job (a held job
 * that resumes after the user uploaded a new graph must use the new one), and
 * the three are kept apart because they are different graphs. Generate with the
 * enhance toggle off takes the enhanceless file - same flag that picks the
 * bindings map in #buildPayload, so file and map always travel together.
 */
function readWorkflowFor(job) {
  const spec = job?.spec ?? {};
  const upscale = spec.kind === 'upscale';
  const enhanceless = !upscale && spec.promptEnhance === false;
  const file = upscale
    ? paths().upscaleWorkflow
    : enhanceless
      ? paths().enhancelessWorkflow
      : paths().workflow;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const kind = upscale ? 'upscale ' : enhanceless ? 'enhanceless ' : '';
    const err = new Error(`cannot read ${kind}workflow ${file}: ${e.message}`);
    err.status = 500;
    throw err;
  }
}

function snapshot(job, waiting = []) {
  const done = job.runs.filter((r) => r.status === 'done').length;
  const failed = job.runs.filter((r) => r.status === 'error').length;
  const at = waiting.findIndex((w) => w.id === job.id);
  return {
    id: job.id,
    kind: job.spec.kind ?? 'generate',
    status: job.status,
    // Where this job sits behind the one currently running. -1 once it has
    // started, so the UI can say "1st of 3 queued" and then "running".
    queuePosition: at === -1 ? null : at + 1,
    queueLength: waiting.length,
    authFailed: job.authFailed,
    error: job.error,
    spec: job.spec,
    runs: job.runs.map((r) => ({
      index: r.index,
      group: r.group,
      isFirstOfGroup: r.isFirstOfGroup,
      seed: r.seed,
      status: r.status,
      // ComfyUI's own id for this run - the thing to look up in /history and
      // /queue when a run misbehaves.
      promptId: r.promptId ?? null,
      startedAt: r.startedAt ?? null,
      endedAt: r.endedAt ?? null,
      progress: r.progress ?? 0,
      node: r.node ?? null,
      queue: r.queue ?? null,
      // How many prompts sit between this run and ComfyUI actually running it.
      // `queue` above is how many are RUNNING, which for a single-machine setup is
      // almost always 1 and says nothing about how long the wait is.
      ahead: r.ahead ?? null,
      wsFailed: r.wsFailed ?? false,
      error: r.error,
      errors: r.errors,
      images: r.images,
      outputs: r.outputs ?? [],
      // What the text encoder was handed, straight from the workflow's own
      // SaveText node. Lets the job panel show the enhanced prompt too.
      promptText: r.promptText ?? null,
      promptSource: r.promptText ? promptSourceFor(job.spec) : null,
      promptTextNode: r.promptTextNode ?? null,
      promptTextFile: r.promptTextFile ?? null,
    })),
    summary: {
      total: job.runs.length,
      done,
      failed,
      images: job.runs.reduce((n, r) => n + r.images.length, 0),
      current: job.current,
    },
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? null,
  };
}

export const runner = new Runner();