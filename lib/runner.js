import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { config, state, paths } from './config.js';
import { ComfyClient, AuthError, ComfyError } from './comfy.js';
import { planRuns, buildRunPayload, collectImages, collectText, newSeed, validateJob, normalizeSlots } from './payload.js';
import { downloadImage, ensureDir } from './download.js';
import { addEntry, findEntry } from './gallery.js';
import { readUpload, findUpload, pushToComfyInput } from './uploads.js';
import * as history from './history.js';

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
    seed: run.seed,
    refreshOverride: run.refreshOverride,
    isFirstOfGroup: run.isFirstOfGroup,
  };
}

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
    this.#controllers.get(id)?.abort();
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
      megapixels: input.megapixels,
      batch: input.batch,
      shuffle: input.shuffle,
      promptEnhance: input.promptEnhance !== false,
      turbo: input.turbo === true,
      stepsOverride: input.stepsOverride ?? null,
      inputResolution: v.inputResolution,
      collectImages: input.collectImages !== false,
      // When the override switch (node 68) fires: once per shuffle group by default.
      refresh: v.refresh,
      // sparse: [{uploadId} | {ref: {filename,subfolder,type}} | null, ...] up to 4
      slots: hydrateSlots(normalizeSlots(input, config().maxImages)),
    };

    // Derived once so the History card can label the saved text honestly: the
    // workflow bypasses the enhancer entirely whenever an image is attached.
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

  /** Start the next waiting job if nothing is running. */
  #pump() {
    if (this.#activeId) return;
    const next = this.#waiting.shift();
    if (!next) return;
    this.#activeId = next.id;
    this.#run(next)
      .catch((e) => console.error('[runner] unhandled', e))
      .finally(() => {
        this.#activeId = null;
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

    let comfyImages = null;
    try {
      const wf = readWorkflow();
      const slots = job.spec.slots;
      if (slots.some((s) => s !== null)) {
        comfyImages = await this.#stageImages(job, slots);
      }

      for (const run of job.runs) {
        if (signal.aborted) break;
        job.current = run.index;
        run.status = 'running';
        run.seed = newSeed();
        run.startedAt = new Date().toISOString();
        this.#emit(job);

        try {
          const payload = buildRunPayload(wf, state.config.bindings, runPayloadOptions(job.spec, run, comfyImages ?? []));

          const client = this.client();
          const submitted = await client.submitPrompt(payload, { clientId: run.index === 0 ? job.id : undefined });
          const promptId = submitted?.prompt_id;
          if (!promptId) {
            throw new ComfyError(
              submitted?.error?.message || 'ComfyUI rejected the prompt',
              { status: 400, body: JSON.stringify(submitted?.error ?? {}) },
            );
          }
          run.promptId = promptId;

          let lastPct = -1;
          const result = await client.monitor(promptId, {
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
          } else {
            run.status = 'error';
            run.error = e.message;
          }
        }
        run.endedAt = new Date().toISOString();
        this.#emit(job);
      }

      if (signal.aborted) job.status = 'cancelled';
      else if (job.authFailed) job.status = 'error';
      else if (job.runs.every((r) => r.status === 'error')) job.status = 'error';
      else job.status = 'done';
    } catch (e) {
      job.status = job.cancelRequested ? 'cancelled' : 'error';
      job.error = e.message;
      if (e instanceof AuthError) job.authFailed = true;
      console.error('[runner]', job.id, e);
    } finally {
      job.current = -1;
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
            source: job.spec.promptEnhance && job.spec.imageCount === 0 ? 'enhanced' : 'raw',
            text: r.promptText,
          })),
      });
      this.#emit(job);
    }
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
   */
  async #collectPromptText(run, outputs) {
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

    for (const img of images) {
      const ctx = {
        prompt: job.spec.prompt,
        seed: run.seed,
        index: run.index,
        group: run.group,
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
      promptSource: r.promptText ? (job.spec.promptEnhance && job.spec.imageCount === 0 ? 'enhanced' : 'raw') : null,
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