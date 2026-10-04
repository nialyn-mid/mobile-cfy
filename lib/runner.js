import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { config, state, paths } from './config.js';
import { ComfyClient, AuthError, ComfyError, isConnectionError } from './comfy.js';
import { planRuns, buildRunPayload, collectImages, collectText, newSeed, validateJob, normalizeSlots } from './payload.js';
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

  /** Validate + enqueue. Throws on bad input so the route can 400. */
  enqueue(input) {
    const v = validateJob(input, { maxImages: config().maxImages });
    if (!v.ok) {
      const err = new Error(v.errors.join('; '));
      err.status = 400;
      err.errors = v.errors;
      throw err;
    }

    const spec = {
      prompt: v.prompt,
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
        turbo: spec.turbo,
        stepsOverride: spec.stepsOverride,
        inputResolution: spec.inputResolution,
        collectImages: spec.collectImages,
        refresh: spec.refresh,
        useSuggestedAspect: spec.useSuggestedAspect,
        aspectRatio: spec.aspectRatio,
        consistency: spec.consistency,
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
      const wf = readWorkflow();
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
              } else if (ev.type === 'executing') {
                run.node = ev.node;
                this.#emit(job);
              } else if (ev.type === 'error') {
                run.error = ev.message;
                this.#emit(job);
              } else if (ev.type === 'queue') {
                run.queue = ev.remaining;
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
  #hold(job, e) {
    const at = this.#waiting.indexOf(job);
    if (at !== -1) this.#waiting.splice(at, 1);
    this.#waiting.unshift(job);
    job.status = 'paused';
    job.error = e.message;
    this.pause('connection', e.message);
    this.#emit(job);
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
      const todo = job.runs.filter((r) => !r.promptId && !FINISHED.has(r.status));
      report.alreadySubmitted += job.runs.filter(
        (r) => r.promptId && !FINISHED.has(r.status),
      ).length;
      if (!todo.length) continue;
      try {
        const images = await this.#stageFor(job);
        const wf = readWorkflow();
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
    if (run.promptId) return run.promptId;
    // The seed goes into the payload, so it is rolled before the payload is built
    // and the same number is kept afterwards - otherwise the recorded seed would
    // not be the seed that produced the image.
    run.seed = newSeed();
    const payload = buildRunPayload(wf, state.config.bindings, runPayloadOptions(job.spec, run, images ?? []));
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
    run.startedAt = new Date().toISOString();
    return promptId;
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
          runIndex: run.index,
          group: run.group,
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

function readWorkflow() {
  const file = paths().workflow;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const err = new Error(`cannot read workflow ${file}: ${e.message}`);
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