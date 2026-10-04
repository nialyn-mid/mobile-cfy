# mobile-cfy

A small Node.js server with a mobile web UI that drives a ComfyUI Qwen-Image
workflow from the phone. It replaces the old `comfy_gen.sh` Termux script and adds
reference images, a prompt-enhance toggle, a turbo toggle, a Consistency LoRA
toggle, a step override, an aspect-ratio picker (or the enhancer's own suggested
one), a prompt history you can re-run from, and a gallery where any generated
image can be fed straight back in as an input.

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
| Prompt | Goes to node `41` (Input Prompt) with enhance on, or node `44` (Raw Prompt) when enhance is off |
| Prompt enhance | Node `176` (`cond`). Works with reference images attached too — the enhancer reads them itself |
| Consistency LoRA | Node `207`. On (the default) = through the LoRA, off = the plain model |
| Turbo | Node `147`, which already selects the turbo or full GGUF (`148` / `183`) for you |
| Steps | Blank keeps the workflow's 7 (turbo) / 25 (full). A number writes **both** nodes `149` and `150` |
| Encoder resolution | Node `204` — the size fed to the **text encoder**, not the output size. Blank = the workflow's own 1024 |
| Megapixels | Node `232`, which feeds node `9` *and* the enhancer's target size |
| Use suggested aspect | Node `233`. On = the enhancer picks a shape that suits the prompt. It needs the enhancer, so it greys itself out when enhance is off — nothing would be producing a suggestion |
| Aspect ratio | Node `9`'s `aspect_ratio` combo. Shown when suggested aspect is off. One of the eight the node offers: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9 |
| Batch × Shuffle | `batch × shuffle` sequential runs |
| Prompt refresh | When the override switch (node `68`) fires — see below |
| Reference images | Up to 4, uploaded to ComfyUI's input dir before the run |

Pressing **Generate** clears the prompt box and lets go of the keyboard, on
purpose: the keyboard popping up over the queue you just added to is worse than
scrolling up to type the next one. Attached reference images are cleared at the
same time (with a `references cleared` toast), because the prompt they were
attached to is gone. Pressing Generate on an *empty* prompt still raises the
keyboard, since that one needs typing.

> **A broken binding will not run silently.** Every binding is checked against
> `workflow_api.json` before a job is accepted; if one points at a node that is
> gone, Generate refuses with the exact reason ("node 43 is not in the
> workflow") instead of quietly producing something you did not ask for.

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

- **Toggles and run settings** — enhance, turbo, consistency, save-images, steps,
  encoder resolution, megapixels, suggested aspect, aspect ratio, batch, shuffle,
  prompt refresh. Your last choices come back exactly as they were. The
  *config.json* defaults in Settings only apply on a first run, or if you clear
  site data.
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
the workflow at once, and every row shows its own verdict — a broken one is marked
`✗` with the reason, never a tick. That matters because a stale node id used to
fail silently: writing `43` after that node was renamed did nothing at all, and the
symptom was a raw prompt where an enhanced one should have been. Now three things
stop that:

- Generate refuses to start when any binding is broken, naming the node.
- A binding still holding an *old untouched default* is re-pointed at startup and
  saved, so an upgraded app never keeps writing into a node that moved.
- **Reset to defaults** puts every binding back to what this build ships with, and
  reports anything the defaults themselves cannot fit.

A binding you edited by hand is never rewritten — if you know what you are doing,
the app keeps out of the way. The one shape that does get migrated is a *half*
edit: a correct new node id still carrying the old input name, like
`enhanceSwitch = 176 / switch` when node 176's input is called `cond`. That is a
real node with an input that does not exist, and it is repaired at startup — both
that and the untouched old default are listed in `BINDING_MIGRATIONS` in
`lib/config.js`.

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

### Walking off the network

Two buttons appear next to the queue strip while there is anything in flight:

**`send all to ComfyUI`** hands every run the app is still holding over to
ComfyUI's own queue in one go — the rest of the running job's batch *and* every
job queued behind it — and then keeps watching them. Use it when you are about to
leave the local network: the work is now the server's problem, the phone can
close, and the images still land in the download folder. Pressing it twice costs
nothing; a run that is already at ComfyUI is never sent again, so no seed is
burnt twice and no duplicate image appears.

**`pause queue` / `▶ resume queue`** holds the queue by hand, and it also engages
itself. If ComfyUI stops answering — you left range, the PC slept — the queue
pauses itself the moment the connection fails, says so in amber under the strip,
and **nothing is lost**:

- no run is dropped and no run is marked failed;
- the job shows as `paused`, not `error`, and keeps no end time;
- requests you add while offline are accepted and queued as usual, so you can
  build a whole batch of work with no server in sight;
- resume picks up exactly the runs that are missing. A prompt ComfyUI was already
  working on is re-attached to and watched, never submitted a second time.

Resume is always a deliberate tap. When the health check notices ComfyUI is back
the dot turns amber and says `back online` with a `press resume` toast — it will
not start four generations behind your back just because a ping succeeded.

`send all to ComfyUI` is disabled while the queue is held (there is nowhere to
send it to yet); the pause bar stays visible even over an empty queue, because
the resume button is the only way back out of a pause.

Both buttons are also plain endpoints, if you would rather use them from a
script: `GET /api/queue`, `POST /api/queue/pause`, `POST /api/queue/resume`,
`POST /api/queue/submit-all`. `GET /api/health` and `GET /api/jobs` both carry
the same `queue` object, and the event stream sends it as
`{"type":"queue","queue":{…}}` — first, before any job snapshot.

One thing a pause deliberately does **not** do: survive a server restart. The
queue lives in memory, so `node server.js` again starts with an empty one. Jobs
whose prompts are already at ComfyUI keep going there and will still download.

### Stopping the server

The last card in **Settings** is `⏻ shut down server`. It stops the Node process
that is serving this page — nothing else: ComfyUI keeps running, and your images
and prompt history are files on disk, untouched.

Because the queue lives in that process, the button asks first, and it is specific
about what each group of work means:

| | |
|---|---|
| queued but never sent to ComfyUI | **lost** unless you hand it over |
| already at ComfyUI, not started yet | keeps generating, but nothing will be watching it, so those images are **not downloaded here** |
| downloading already failed | retried automatically after the next start |
| already downloaded | safe |

Tick **hand queued work to ComfyUI first** and it does exactly what *send all to
ComfyUI* does, one last time, before leaving. The checkbox only appears when
there is something to hand over and the queue is not already held.

Then the page **polls until the server really stops answering** — the reply only
says the request was accepted, so confirmation waits for `/api/health` to stop
answering entirely. After about 17 seconds of silence it says it is still checking
and offers **check again**, rather than declaring a victory that did not happen.
When it does confirm, the screen explains that ComfyUI is still going and that
`bash start.sh` brings the server back, with a *reload page* link that works the
moment it does.

The button only works when the page was served **from the phone**
(`http://127.0.0.1:<port>`). The UI is reachable from every device on the wifi, and
a tap from a laptop should not kill the phone's server; from another device it
answers with a 403 and the UI explains why. `MOBILE_CFY_ALLOW_REMOTE_SHUTDOWN=1`
in the environment lifts that if you want a remote button.

Endpoint: `POST /api/shutdown` with an optional `{"handover":true}`.

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
| `megapixels` | `232.value` | Input Megapixels |
| `useSuggestedAspect` | `233.value` | Use Suggested Aspect |
| `aspectRatio` | `9.aspect_ratio` | Resolution Selector |
| `consistencyLora` | `207.value` | Consistency LoRA |
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
- The tags say **enhanced prompt** or **raw prompt (enhancer bypassed)**. The tag
  is decided by your toggle, not by guessing: enhance on means the enhancer ran,
  enhance off means node `176` handed your text straight through. If you ever see
  *raw* with enhance on, the binding is broken — Generate will have refused to
  start, so check the Settings tab.
- Captures accumulate. Re-running a remembered prompt adds its new wording(s)
  alongside the old ones rather than replacing them, so a good result never
  disappears because you tried the prompt again.
- `promptTextNodes` in `config.json` lists which nodes to read. `[]` turns the
  capture off. (Note the opposite default to `collectNodes`, where `[]` means
  "every SaveImage".)

Two other settings live outside the bindings:

- `collectNodes` — which `SaveImage` nodes to collect. `[]` collects all of them.
- `filenameTemplate` — how downloads are named.

### Consistency LoRA

Node `207` "Consistency LoRA" is a boolean that decides whether the model runs
through the LoRA (`206`) or not — `218`/`221` pick between the plain GGUF and the
LoRA-patched one. The toggle writes it directly, and it defaults to **on**, which
is what the workflow's own editor value is. Turning it off genuinely turns the
LoRA off, which costs VRAM but keeps the plain model — worth doing for one-off
text-to-image work, and worth leaving on when a run's reference images should
keep their identity across seeds.

If you would rather leave node `207` alone, set `"consistency": null` in
`config.json` — the server then writes nothing when a caller omits the field,
and the checkbox starts off on a fresh device.

### Size: megapixels and shape

The workflow now separates the two things:

- **Node `232` "Input Megapixels"** (a float) is the *budget*. It feeds node `9`
  and the enhancer's own `Target Megapixels`, so the suggestion and the output
  agree with whatever you typed.
- **Node `233` "Use Suggested Aspect"** decides who picks the shape. On, node `226`
  reads the enhanced prompt and returns an aspect that suits it. Off, node `9`'s
  own `aspect_ratio` combo is used and the dropdown appears.

Suggested aspect needs the enhancer — it is literally asking the enhancer for a
shape, so the switch greys itself out (and the server forces node `233` off) when
Prompt enhance is off. Asking for it is a preference that gets downgraded, not an
error.

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
{stamp}_s{shuffle}b{batch}i{img}
261004-001849_s0b0i0.png
```

`{stamp}` is `yymmdd-hhmmss` — the moment the image was written — and `s/b/i` are
the shuffle group, which seed of that group, and which image of that run, so the
counters say at a glance what produced a file:

```
261004-001849_s0b0i0.png   shuffle 0, seed 0, image 0   (the S8 final)
261004-001849_s0b0i1.png   shuffle 0, seed 0, image 1   (the S7 preview)
261004-002033_s0b1i0.png   shuffle 0, seed 1, image 0
```

Collisions become `name_1.png`, as in the old script. Available tokens:
`{stamp} {prompt} {variant} {seed} {index} {node} {group} {shuffle} {batch}
{img}` — `{shuffle}` falls back to `{group}`, `{batch}` to `{index}`, and `{img}`
to 0, so an older template that only had `{index}` still renders.

Note that Termux's shared-storage folder is `downloads` (plural). If it is
missing, run `termux-setup-storage` — Settings has a **Test folder** button that
will tell you.

### When a download fails

A dropped connection used to cost you the file silently: the image still showed in
the gallery (served straight from ComfyUI), but the copy in the download folder was
never written and nothing said so. That is now visible and now recoverable.

- Anything still missing is badged **not downloaded** in the gallery, the run says
  how many images it is still short of, and a note above the grid counts them with a
  **retry downloads** button.
- Nothing needs pressing. A background sweep runs every 15 seconds and only acts
  when there is something outstanding.
- The rules it follows, chosen so it can never fight you:
  - **Two tries**, 30s then 2 minutes apart. The download at collect time counts as
    the first attempt, so a run gets three chances in total — after that the entry
    is marked **gone** instead of being fetched forever.
  - **A 404 ends it immediately.** ComfyUI saying "no such file" is a real answer,
    not a fluke.
  - **A dead network costs nothing.** A connection error spends no attempt and stops
    the sweep there, because everything behind it would fail too. Coming back
    online (or pressing resume) tries again.
  - **The 24-hour limit counts reachable time only.** Age accrues per sweep, so a
    phone that was switched off, or asleep out of range, for a week has lost
    nothing.
  - **A file you deleted stays deleted.** Only entries that never had a local copy
    are retry candidates, so a file you removed from the download folder is never
    quietly downloaded again.

Recovered files keep the name they would have had, because the shuffle/batch/image
counters recorded at collect time are replayed — so a retry cannot produce
`…_1.png` next to the original.

Manual endpoint (the button calls it, and it is safe to press twice):

```
POST /api/gallery/retry    -> {"candidates":1,"recovered":1,"gone":0,"failed":0,"skipped":0,"pending":0}
```

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

**The queue says `paused` and nothing is happening.** ComfyUI stopped answering,
so the queue held itself instead of failing every run one by one. Nothing is lost
— press `▶ resume queue` when the server is reachable again, or `send all to
ComfyUI` if you would rather hand the work over first. If the server was
restarted, the in-memory queue is empty by definition (see *Walking off the
network*).

**Generation is slow.** The prompt enhancer runs a Qwen3-VL model and dominates
runtime — minutes per run is normal. Turn it off for a much faster turnaround.

**An image is badged `not downloaded` or `gone`.** The gallery is showing it
because ComfyUI still has it, but the copy in the download folder failed. The retry
sweep works on its own every 15s; **retry downloads** forces it now. `gone` means
the budget ran out or ComfyUI no longer has the file (ComfyUI prunes its output
folder — a `gone` image may only exist in this app's gallery from now on). See
*When a download fails*.

**The shut down button does nothing.** The button only works when the page is
served *from the phone itself* (`http://127.0.0.1:<port>`), because the UI is
reachable from every device on the wifi and a tap from a laptop should not kill
the phone's server. Open the UI on the phone. If you genuinely want a remote
button, start the server with `MOBILE_CFY_ALLOW_REMOTE_SHUTDOWN=1`.

**The page says "still checking" after a stop.** It is polling `/api/health`
until the connection is refused, which is the only proof that the process is gone.
About 17 seconds without confirmation it says so and offers **check again** — a
stop that does not finish leaves the process in exactly the state where the reply
was fine.

---

## Development

```bash
npm test      # node --test "test/**/*.test.js"
```

Tests cover config merging and the binding/value migrations, payload construction,
the run matrix, prompt-text capture, download naming, upload sniffing and
multipart parsing, the history store, the bindings panel's verdict rendering, the
queue — bulk submit, an auto-paused queue, offline building, resume, and cancel —
the download-retry sweep, and the shut down route. 148 of them; they need no network
and no real ComfyUI (`test/queue.test.js`, `test/retry.test.js` and
`test/shutdown.test.js` each run a fake ComfyUI from the shared
`test/helpers/fakeComfy.js`). Every temp root a test creates is deleted again, so
running the suite on the phone does not leave litter behind.

`test/reset.test.js` starts a second server on port 3082, `test/shutdown.test.js`
on 3083, each with `MOBILE_CFY_ROOT` pointed at a temp directory, so they never
touch the instance you are using.

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
                   history, uploads, multipart, env, retry, shutdown
public/            index.html, app.js, style.css, bindmark.js  (no build step)
test/              node --test  (helpers/fakeComfy.js is the shared fake server)
data/
  history.json     prompt memory (300 newest)
  index.json       gallery index
  uploads/         reference images you attached
```

`PLAN.md` holds the design rationale, the full node map, and the reasoning behind
each binding.