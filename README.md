# mobile-cfy

A small Node.js server with a mobile web UI that drives a ComfyUI Qwen-Image
workflow from the phone. It replaces the old `comfy_gen.sh` Termux script and adds
reference images, a prompt-enhance toggle, a turbo toggle, a step override, and a
gallery where any generated image can be fed straight back in as an input.

**No dependencies.** Node's standard library only — `npm install` is never needed,
because installing packages in Termux is slow and occasionally broken.

---

## Setup

```bash
pkg install nodejs-lts
termux-setup-storage      # once, so ~/storage/downloads exists
bash start.sh
```

`start.sh` starts the server, waits for it to answer, and opens
`http://127.0.0.1:3081` in the Termux browser. It also prints the phone's LAN
address so you can open the same page from a desktop on the same wifi.

Stop it with `Ctrl-C`, or `bash stop.sh` if it is running in the background.

### The ComfyUI token

If ComfyUI has the [ComfyUI-Login](https://github.com/liusida/ComfyUI-Login)
extension installed, every API call needs the bcrypt hash it prints at startup:

```
To see the GUI go to: ...   For direct API calls, use token=$2b$12$...
```

Put that hash in `.env` at the project root:

```
AUTH_TOKEN=$2b$12$....
```

Nothing else is needed in `.env`. **Anyone holding this hash can drive your
ComfyUI**, so treat it like a password — `.gitignore` already excludes `.env`.

The extension caches the token at import, so if you change the password in
ComfyUI you must restart ComfyUI, copy the new hash from its console, then press
**Reload token** in Settings (no need to restart mobile-cfy).

---

## Using it

**Generate** tab

| Control | What it does |
|---|---|
| Prompt | Goes to node `41` (Input Prompt) with enhance on, or node `44` (Raw Prompt) when enhance is off or images are attached |
| Prompt enhance | Node `176` (`cond`). Ignored while reference images are attached — the workflow routes around it on its own |
| Turbo | Node `147`, which already selects the turbo or full GGUF (`148` / `183`) for you |
| Steps | Blank keeps the workflow's 7 (turbo) / 25 (full). A number writes **both** nodes `149` and `150` |
| Encoder resolution | Node `204` — the size fed to the **text encoder**, not the output size. Blank = the workflow's own 1024 |
| Megapixels | Node `9` |
| Batch × Shuffle | `batch × shuffle` sequential runs |
| Prompt refresh | When the override switch (node `68`) fires — see below |
| Reference images | Up to 4, uploaded to ComfyUI's input dir before the run |

**Prompt refresh** is the interesting one. The workflow memorises the last
enhanced prompt, so re-submitting identical text reuses it:

- *Once per shuffle group* — the override switch fires on run 1 of each group.
  One enhancement, then every later image varies only by seed. Fast.
- *Every run* — the switch fires every time, so each image gets its own
  re-enhanced wording. Slow (the Qwen-VL enhancer dominates runtime), but the
  images differ in composition as well as in noise.

**Gallery** tab keeps every image this and previous sessions produced, grouped by
job. Tap a job header to fold its images away — the folded set is remembered, so
a long gallery stays readable between reloads. `⟳ use as input` drops an image
into the next free reference slot.

**History** tab is the prompt memory. Every prompt you submit is written to
`data/history.json` before the job starts, so it is there even if the run
errors out. Tap an entry and the whole thing comes back: the prompt text, the
settings that produced it (enhance, turbo, steps, megapixels, batch × shuffle,
prompt refresh) and the reference images you attached. Nothing is submitted —
you land on the Generate tab and press Generate, or edit first. `×` forgets one
entry, `clear` forgets all.

Two details worth knowing:

- Submitting an identical prompt with identical settings and images straight
  away folds into the existing entry and bumps a *used 3×* counter, so a
  double-tap on Generate doesn't litter the list.
- History stores *references* to your images (the upload id, or the gallery
  id), not copies. If you clear the gallery or the upload is pruned, the
  thumbnail shows `?` and the prompt loads without that reference, with a
  toast telling you how many are missing.

### What the app remembers

Settings and UI state live in the browser's `localStorage`, so they survive a
reload and a phone restart:

- **Toggles and run settings** — enhance, turbo, save-images, steps, megapixels,
  batch, shuffle, prompt refresh. Your last choices come back exactly as they
  were. The *config.json* defaults in Settings only apply on a first run, or if
  you clear site data.
- **Which gallery jobs are folded** away.
- **Not remembered on purpose:** the prompt text (that is History's job) and the
  reference images (they point at one-shot upload handles that a later session
  may no longer have).

The prompt box grows and shrinks to fit what you typed, capped at roughly half
the screen so a wall of text cannot push everything else off the page.

Pressing Generate clears the prompt **and any reference images** you attached.
References belong to the prompt you just submitted — leaving them armed would
quietly turn the next, unrelated prompt into an image-to-image job.

**Settings** tab covers the ComfyUI host, the download folder, the filename
template, and every node binding. **Check bindings** validates all of them against
the workflow at once — use it after you edit the workflow, because a stale node id
fails silently rather than loudly.

### Queueing

The Generate tab is never locked. Submit as many prompts as you like while a
generation is running — each one joins an in-app queue and starts as soon as the
previous job finishes. Only one job reaches ComfyUI at a time, which is all the
workflow can take anyway.

Above the Generate button a queue strip shows everything in flight:

- `▶` with a progress bar — the job ComfyUI is chewing on right now.
- `⏳ queued 2 of 3` — waiting its turn, with a `×` to drop it.
- `✓ done · 6 img` — the most recent finished job that isn't the one on screen.
  **Tap its prompt to bring that job's results up.**

The detail panel always follows whatever is actually running, so you never have to
watch a finished job. It repaints itself after a page reload too — the server
replays the current job list on connect.

### Viewing images

Every image is already in your download folder the moment its run finishes, so
there is no save button anywhere. Tapping a thumbnail opens the **lightbox**:

- Full-screen, with the image centred on black and given the full screen width —
  the pager buttons live in the bottom bar, not in side gutters.
- **Pinch to zoom**, drag to pan, double-tap to jump between fit and a 2.5×
  close look. On a desktop, the mouse wheel zooms toward the cursor.
- `‹ 3 / 24 ›` in the bottom bar, a swipe, or the arrow keys step through the
  whole list without closing.
- The file's own name is pinned to the top of the screen, so you know which
  download you are looking at.
- `⟳ add to prompt` sends the current image to the next free reference slot.
- **The phone's back gesture closes the lightbox** instead of leaving the page —
  one press gets you out of the image, a second press leaves the app.

Zoom is contained inside the image area: the photo is clipped rather than allowed
to grow over the controls, so the bottom bar and the arrows stay tappable at any
zoom level.

---

## Node bindings

Every feature is a `{node, input}` pair in `config.json`, seeded from your
workflow so the server works with no configuration. Change any of them in
Settings without touching code.

| Binding | Default | Title |
|---|---|---|
| `promptEnhanced` | `41.value` | Input Prompt |
| `promptRaw` | `44.value` | Raw Prompt (If Enhance Disabled) |
| `enhanceSwitch` | `176.cond` | Prompt Enhance On/Off |
| `imageCount` | `158.value` | Image Count |
| `images` | `11` / `140` / `141` / `142` `.image` | Reference 1–4 |
| `shuffleSwitch` | `68.value` | ON = Override = Refresh |
| `turboSwitch` | `147.value` | TURBO On/Off |
| `stepsTurbo` / `stepsFull` | `149.value` / `150.value` | Turbo Steps / Full Steps |
| `seed` | `37.seed` | Seed |
| `megapixels` | `9.megapixels` | Resolution Selector |
| `inputResolution` | `204.value` | Input Resolution |

Set a node id to blank to disable that feature; it is then never written to the
payload.

### The prompt the image was actually made from

The workflow writes a text file from node `181` "Save Text", which sits on the
same wire as the text encoder. The server reads it back after every run and
stores it with the history entry, so you can see the enhancer's wording:

- History tab → **▾ show** opens the box for the whole prompt. Inside it there is
  **one collapsible per run**, because a single prompt can legitimately come back
  several ways: *Every run* refreshes the enhancer, and each refresh re-words the
  prompt differently. Each inner box is labelled with its run number and seed, and
  opens to the full text.
- Each inner box has **copy** (to the clipboard) and **use as prompt**, which
  loads that exact wording into the Generate tab *and turns the enhancer off* —
  what you want once a re-wording comes back worth keeping, so you stop paying
  2–5 minutes per image to redraw wording you already like.
- The tags say **enhanced prompt** or **raw prompt (enhancer bypassed)**. The
  workflow bypasses the enhancer on its own whenever a reference image is
  attached, so the file can hold your untouched prompt even with the toggle on.
  Labelling that "enhanced" would be a lie.
- Captures accumulate. Re-running a remembered prompt adds its new wording(s)
  alongside the old ones rather than replacing them, so a good result never
  disappears because you tried the prompt again.
- `promptTextNodes` in `config.json` lists which nodes to read. `[]` turns the
  capture off. (Note the opposite default to `collectNodes`, where `[]` means
  "every SaveImage".)

Two other settings live outside the bindings:

- `collectNodes` — which `SaveImage` nodes to collect. `[]` collects all of them.
- `filenameTemplate` — how downloads are named.

### Encoder resolution

`Encoder resolution` on the Generate tab writes node `204`, which is the pixel
size fed to the **text encoder**, not the size of the finished image — that stays
on Megapixels. Leaving it blank uses whatever the workflow says (1024 today).
Raising it can help the encoder read fine detail in reference images; it costs
VRAM and time.

### Two things the old script got wrong

- **The seed was never randomised.** `comfy_gen.sh` wrote the seed to node `126`,
  which is a `LoadLatent` node — the value was discarded, so every run in a batch
  produced the same image. The real seed node is `37`.
- **Images live in ComfyUI's output dir, but `LoadImage` only reads from input.**
  Every reference image is re-uploaded to `/upload/image` before the run,
  whether it came from the file picker or the gallery.

---

## Downloads

Images are written to `~/storage/downloads/mobile-cfy` as each run finishes, so a
cancelled job still leaves you what it completed. Names follow a template:

```
{stamp}_{prompt}_{variant}_{seed}
261002-172913_a-small-red-cube-on-a-white-background_N8_2846668871.png
```

`{stamp}` is `yymmdd-hhmmss`, `{variant}` is the SaveImage node (`N8`, `N45`) or
its `S8`/`S7` hint when present. Collisions become `name_1.png`, as in the old
script. Available tokens: `{stamp} {prompt} {variant} {seed} {index} {node}
{group}`.

Note that Termux's shared-storage folder is `downloads` (plural). If it is
missing, run `termux-setup-storage` — Settings has a **Test folder** button that
will tell you.

---

## Troubleshooting

**Every call returns 401.** The token is missing or stale. Check the Settings
health dot, then press **Reload token**.

**A run sits at 0% forever.** It is probably queued in ComfyUI behind an orphaned
prompt — usually one left behind by a previous mobile-cfy that was killed. Clear
it:

```bash
curl -X POST http://COMFY:8188/queue -H 'Content-Type: application/json' -d '{"clear":true}'
curl -X POST http://COMFY:8188/interrupt
```

The server also reports a *dropped from the queue* error rather than hanging if
this happens to a job of its own.

**The browser shows no live progress.** Android may have suspended the SSE
connection while the phone was asleep; the UI falls back to polling on its own.
The job itself is unaffected.

**Generation is slow.** The prompt enhancer runs a Qwen3-VL model and dominates
runtime — minutes per run is normal. Turn it off for a much faster turnaround.

---

## Development

```bash
npm test      # node --test "test/**/*.test.js"
```

Tests cover config merging, payload construction, the run matrix, prompt-text
capture, download naming, upload sniffing and multipart parsing, and the history
store. 99 of them; they need no network and no ComfyUI.

The server runs unchanged on Windows for development:

```bash
node server.js
```

### Layout

```
server.js          http server, router, static files
start.sh stop.sh   Termux launcher
config.json        generated; all node ids and paths
workflow_api.json  the ComfyUI workflow, API format
lib/               config, comfy, ws, payload, runner, download, gallery,
                   history, uploads, multipart, env
public/            index.html, app.js, style.css  (no build step)
test/              node --test
data/
  history.json     prompt memory (300 newest)
  index.json       gallery index
  uploads/         reference images you attached
```

`PLAN.md` holds the design rationale, the full node map, and the reasoning behind
each binding.