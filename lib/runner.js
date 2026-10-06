import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { config, state, paths } from './config.js';
import { ComfyClient, AuthError, ComfyError, isConnectionError } from './comfy.js';
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
    };
  }

  #emitQueue() {
    this.emit('queue', this.queueState());
  }

  /** Stop starting new jobs. A job already running is left alone. */
  pause(reason = 'manual', message = null) {
    if (this.#paused) return this.queueState();
    this.#paused = true;
    this.#pauseReason = reason;
    this.#pauseMessage = message;
    this.#pausedAt = new Date().toISOString();
    console.log(`[runner] queue paused (${reason})${message ? `: ${message}` : ''}`);
    this.#emitQueue();
    return this.queueState();
  }

  /** Start again, in order, from wherever the queue stopped. */
  resume() {
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
    // the previous job has finished.
    this.#waiting.push(job);
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
    this.#pump();
    return snapshot(job, this.#waiting);
  }

  /** Start the next waiting job if nothing is running and the queue is live. */
  #pump() {
    if (this.#activeId || this.#paused) return;
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
    this.resume();
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
    if (this.#paused && this.#pauseReason === 'busy') this.resume();
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
      // re-running a prompt reproduces the image instead of wandering off.
      run.seed = job.spec.seed ?? newSeed();
      const payload = this.#buildPayload(job, run, wf, images ?? []);
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
   * The payload for one run. The only place that knows which of the two graphs a
   * job belongs to - and the only reason they can share a queue, a submit path,
   * a monitor and a downloader.
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
    return buildRunPayload(wf, state.config.bindings, runPayloadOptions(job.spec, run, images ?? []));
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
 * Which workflow this job runs on. Both files are read fresh per job (a held job
 * that resumes after the user uploaded a new graph must use the new one), and the
 * two are kept apart because they share no node ids.
 */
function readWorkflowFor(job) {
  const upscale = job?.spec?.kind === 'upscale';
  const file = upscale ? paths().upscaleWorkflow : paths().workflow;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const err = new Error(`cannot read ${upscale ? 'upscale ' : ''}workflow ${file}: ${e.message}`);
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