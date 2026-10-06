# mobile-cfy

A small Node.js server with a mobile web UI that drives a ComfyUI Qwen-Image
workflow from the phone. It replaces the old `comfy_gen.sh` Termux script and adds
reference images, a prompt-enhance toggle, a turbo toggle, a Consistency LoRA
toggle, a step override, an aspect-ratio picker (or the enhancer's own suggested
one), an **Upscale tab** with its own second workflow, a prompt history you can
re-run from, and a gallery where any generated image can be fed straight back in
as an input.

**No dependencies.** Node's standard library only — `npm install` is never needed,
because installing packages in Termux is slow and occasionally broken.

---

## Setup

```bash
pkg install nodejs-lts
termux-setup-storage      # once, so ~/storage/downloads exists
bash start.sh
```

`start.sh` starts the server, waits for it to answer, and prints the URL. It does
**not** open a browser on its own — `bash start.sh --open` does that, when you
want it. (Opening on every start threw the Termux session behind a page nobody
had asked for yet, which on a phone means losing sight of the log the server is
writing into at the moment you start it.) It also prints the phone's LAN address
so you can open the same page from a desktop on the same wifi.

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
| Prompt | Node `41` (Input Prompt) when enhance is on, node `44` (Raw Prompt) when it is off |
| Postprompt | Node `256`. Optional extra text joined onto the prompt by the workflow — see below. Enhance off runs a different file with no `256`, so it is **not applied** then (the hint under the toggle says so) |
| Prompt enhance | Node `176` (`cond`). Works with reference images attached too — the enhancer reads them itself |
| Consistency LoRA | Node `207`. On (the default) = through the LoRA, off = the plain model |
| Turbo | Node `147`, which already selects the turbo or full GGUF (`148` / `183`) for you |
| Steps | Blank keeps the workflow's 7 (turbo) / 25 (full). A number writes **both** nodes `149` and `150` |
| Encoder resolution | Node `204` — the size fed to the **text encoder**, not the output size. Blank = the workflow's own 1024 |
| Megapixels | Node `232`, which feeds node `9` *and* the enhancer's target size |
| Use suggested aspect | Node `233`. On = the enhancer picks a shape that suits the prompt. It needs the enhancer, so it greys itself out when enhance is off — nothing would be producing a suggestion |
| Aspect ratio | Node `9`'s `aspect_ratio` combo. Shown when suggested aspect is off. One of the eight the node offers: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9, 21:9 |
| Batch × Shuffle | `batch × shuffle` sequential runs |
| Seed | Blank = a fresh random seed for every run. A number pins it — see below |
| Prompt refresh | When the override switch (node `68`) fires — see below. Enhance off runs the enhanceless file, which has no `68`, so it does not apply then |
| Reference images | Up to 4, uploaded to ComfyUI's input dir before the run |

Pressing **Generate** clears the prompt box and lets go of the keyboard, on
purpose: the keyboard popping up over the queue you just added to is worse than
scrolling up to type the next one. Attached reference images and a typed
**postprompt** are cleared at the same time (one `postprompt and references
cleared` toast), because the prompt they were written for is gone. Pressing
Generate on an *empty* prompt still raises the keyboard, since that one needs
typing.

**Postprompt** is the one field that reads as if it were a suffix and is not one.
Node `257` in the workflow joins node `256` (your postprompt) onto whichever text
the enhance branch produced, with **no delimiter**, and the joined string is what
both the text encoder and the SaveText node read. So:

- It is applied *after* enhancement — on the enhance-on path. When the enhancer
  is off the job runs `workflow_api_enhanceless.json` instead, which has no
  postprompt node at all, so nothing is applied then and the field is ignored.
- It is joined **literally**. A postprompt of `\n\nas a pencil sketch` becomes
  `…your prompt\n\nas a pencil sketch`; without your newlines it would be glued
  onto the last word. Nothing is trimmed on the way in.
- It ends up inside the captured prompt text, which is why the History tab needs
  no special handling for it. The text is recorded on the row as well, so
  tapping an old entry puts the box back exactly as you left it.
- Blank (or only spaces) is *not* sent: node `256` keeps whatever you left in the
  ComfyUI editor, exactly as for every other optional field.

> **A broken binding will not run silently.** Every binding is checked against
> its own workflow file before a job is accepted — `workflow_api.json` for
> enhance-on runs, `workflow_api_enhanceless.json` for enhance-off runs,
> `upscale_api.json` for upscales; if one points at a node that is gone, the
> button refuses with the exact reason ("node 43 is not in the workflow")
> instead of quietly producing something you did not ask for.

**Seed** is the reproducibility dial. Left blank, every run rolls a fresh random
seed (what the app has always done — there is no seed for you to see or lose).
Type a whole number and every run of that job uses *that* seed, so the same
prompt gives you the same image back: raise the seed again to nudge one detail,
change the wording to move something else. It is written to node `37`, which
every KSampler already reads.

Two things the app refuses to leave ambiguous:

- A pinned seed with more than one run shows a warning under the box. All the
  runs use it, so runs whose *prompt* is also identical are identical images —
  with a shuffle of 3 and "once per group" that is 3 copies of the first one.
  It is allowed because it is sometimes exactly what you want (the same picture
  at a different megapixels, say), and a checkbox-level block would be worse.
- The field is **not** remembered across a reload. A pinned seed that silently
  survived a page refresh would quietly re-use itself on the next, unrelated
  prompt — the one thing this feature must never do. History *does* bring a
  pinned seed back, because tapping an entry is an explicit "run this again".

**Prompt refresh** is the interesting one. The workflow memorises the last
enhanced prompt, so re-submitting identical text reuses it:

- *Once per shuffle group* — the override switch fires on run 1 of each group.
  One enhancement, then every later image varies only by seed. Fast.
- *Every run* — the switch fires every time, so each image gets its own
  re-enhanced wording. Slow (the Qwen-VL enhancer dominates runtime), but the
  images differ in composition as well as in noise.

**Upscale** tab

A second workflow (`upscale_api.json`) with one job per image and one run each:

| Control | What it does |
|---|---|
| Image | The one image to upscale. Upload it, drop it on the box, paste it, or pick one from the gallery. It is uploaded to ComfyUI's input dir first and the returned name is written to node `538` (LoadImage) |
| Scale multiplier | Node `517`. Default `2`, and anything up to `16` — the workflow's own maths takes the smaller of `×N` and the 4× ceiling |
| Scale to a target size | Node `526`. On = ignore the multiplier and aim for the two dimensions below |
| Target width / height | Nodes `528` / `529`, each 64–8192. Only read when the switch above is on, so they are greyed out until you turn it on |
| Guidance | Node `544`. **Added** to the workflow's own instruction (node `522`, "Enhance this image to high resolution…") rather than replacing it, so a phrase like "keep the film grain" steers the run without having to retype the base instruction |
| Batch | Node `506`'s `batch_size`: how many images **one pass** produces, 1–8. Different from the Generate tab's batch, which is N separate runs — see below |
| Seed | Blank = random. A number pins it, exactly as on the Generate tab |
| Download | Whether the result is saved to your download folder |

Turn **Scale to a target size** on and the workflow computes one uniform factor
`min(4, √(targetW·targetH / (w·h)))`, so the aspect ratio survives: a 3000 × 2000
target on a 1000 × 1000 source scales by 2.45, not by 3 and 2 separately.

**That factor scales AREA to the box, not the sides to the box.** It gives the
result the box's pixel count in the source's shape, which means the result can
come out *larger* than the box on one side: a 1024 × 768 source aimed at
2048 × 2048 comes out 2364 × 1773, not 2048 × 1536. Two independent fits would
have kept it inside the box and stretched the picture. If you need the result to
sit inside a box, set the box's two sides to the aspect ratio you want.

The 4 in that formula is the export's own ceiling and cannot be raised. Asking a
256 × 256 image for an 8192 × 8192 box gives 1024 × 1024, not 8192 — no amount of
asking changes it.

**The size of the image you picked is printed under it**, with the size that will
come out the other end:

```
1024 × 768  →  2048 × 1536
```

It is read straight off the thumbnail the browser has already decoded, so there
is no extra request and it works the same for an upload, a paste, a drop and a
gallery pick. It updates the moment you change the multiplier or the target
box. A result wider than 8192 on a side is called out in orange first — that is
the point where a small card runs out of memory twenty minutes into a run.

> **Both halves of the size switch are written.** The graph's height switch (node
> `530`) is a hard-wired `false` in the export while the width switch (node `527`)
> follows `526`. Taken literally that would aim at the target *width* and a plain
> `×N` *height*, throwing the aspect away — so both are written from the one toggle.
> `530` stays its own editable binding, which is what keeps the "every node id is
> configurable" promise honest.

**Upscale batch is a batch of latents, not a batch of jobs.** The only batch knob in
the graph is node `506`'s `batch_size`, and it is a big one: its output 2 *is* the
latent that both samplers work on and the decoder saves, so `4` means four images
out of a single pass. That is deliberately not the Generate tab's arrangement,
where `batch` is N separate runs:

- **Why not N runs:** an upscale pass is minutes of GPU time, and N runs would pay
  the model load, the text encode and the VAE again for every image. One prompt
  with a batched latent shares all of it — 4 images cost about the same wall clock
  as 1.
- **The images are still different.** ComfyUI offsets the noise per batch element,
  so a pinned seed gives you four variations of the same source rather than four
  copies of one picture.
- **The cost is VRAM, not time.** Every one of them sits in memory at the target
  size at once, so a big target and a big batch together can run a small card out.
  The note under the inputs says as much; start at 2 if a run fails.
- It is still one job and one run, so cancelling, timing, the queue and the gallery
  all behave exactly as they do at 1 — the thumbs just show N pictures.

Both tabs share **one queue**, because ComfyUI has one GPU and one queue: an
upscale waiting behind a shuffle holds up the next generate, and the queue bar,
the pause/send-all controls, cancel, per-run timers and shutdown handover all
appear on both tabs. Upscale rows are marked `⤒`, and so are their gallery groups
and history entries.

Upscaling one image per job is deliberate — the workflow has a single LoadImage —
so upscaling four pictures means four jobs. They queue like anything else, and
they wait for ComfyUI's own queue exactly like anything else (see *When ComfyUI is
busy with somebody else's work*).

**Pressing `Upscale` clears the picture and the guidance**, the same way `Generate`
clears the prompt, the postprompt and the reference images: those three describe
*this* job, and leaving them armed would silently run the *next* one against the
wrong image. The scale, the target size, the batch and the download toggle are
settings and stay put — upscaling the next photo the same way is the whole point
of a separate tab. A toast says what was cleared. History puts it all back.

Under the hood it is `POST /api/upscale` with
`{slots:[{uploadId}], scale, scaleToDim, targetWidth, targetHeight, guidance, seed,
batch, collectImages}` returning `202` and a normal job object — the same shape a
generate returns, so everything downstream (queue, events, cancel, gallery,
history) needed no new code. The graph itself is read and replaced through
`GET`/`PUT /api/upscale/workflow`, which never touches `workflow_api.json`.

The upscale graph is checked before a job is accepted, exactly like the generate
one, and **a broken upscale binding does not block a generate**: they point at two
different files and share no node ids.

**Gallery** tab keeps every image this and previous sessions produced, grouped by
job. Tap a job header to fold its images away — the folded set is remembered, so
a long gallery stays readable between reloads. `⟳ use as input` drops an image
into the next free reference slot, `⤒ upscale this` opens the Upscale tab with it
already in place, and an upscale job's group is marked `⤒` so it is never confused
with a generation.

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
- The **seeds** row under each entry is the answer to "what did that run use?".
  `copy` puts every seed of the job on the clipboard, one per line, and `use`
  pins the first one and drops you on the Generate tab — so re-typing a 10-digit
  number by hand is never necessary. Entries with no seed of their own (older
  rows, or ones still queued) show nothing there rather than an empty box.
- Upscale entries are marked `⤒`, carry their own chips (`×2`, `target 3000 × 2000`,
  `4 images in one pass`, `extra guidance`), and are the one thing in History that
  reopens the **Upscale** tab instead of Generate — multiplier, target size, batch,
  guidance, seed and download toggle all come back, along with the image itself
  when the gallery still has it.

### What the app remembers

Settings and UI state live in the browser's `localStorage`, so they survive a
reload and a phone restart:

- **Toggles and run settings** — enhance, turbo, consistency, save-images, steps,
  encoder resolution, megapixels, suggested aspect, aspect ratio, batch, shuffle,
  prompt refresh, and on the Upscale tab the multiplier, the target-size switch,
  both target dimensions, the batch count and the download toggle. Your last
  choices come back exactly as they were. The *config.json* defaults in Settings
  only apply on a first run, or if you clear site data.
- **Which gallery jobs are folded** away.
- **Not remembered on purpose:** the prompt text (that is History's job), the
  **postprompt**, the reference images (they point at one-shot upload handles
  that a later session may no longer have), the **seed** and the **guidance
  prompt** — a pinned seed that silently survived a reload would re-use itself on
  your next unrelated prompt, and a postprompt or a sentence of guidance is text
  you would rather write each time. History brings them all back when you tap an
  entry, because that is an explicit "run this again".

The prompt box grows and shrinks to fit what you typed, capped at roughly half
the screen so a wall of text cannot push everything else off the page. The
postprompt box does the same, half as tall to start with.

Pressing Generate clears the prompt, the **postprompt** and any reference images
you attached. All three belong to the prompt you just submitted — leaving them
armed would quietly append yesterday's tail, or turn the next unrelated prompt
into an image-to-image job. Pressing **Upscale** does the same for the picture and
the guidance, which belong to the image that was just submitted.

**Settings** tab covers the ComfyUI host, the download folder, the filename
template, and every node binding. Its **ComfyUI link** card is the written
version of the dot in the corner — tap the dot and it lands there; see *The dot
in the corner, and what it actually saw*. A **Generate / Upscale** switch above the
binding table picks which set you are editing and which graph **check bindings**
and the node list read, so the two never get mixed up. **Check bindings**
validates all of them against the workflow at once, and every row shows its own
verdict — a broken one is marked `✗` with the reason, never a tick. That matters
because a stale node id used to fail silently: writing `43` after that node was renamed did nothing at all, and
the symptom was a raw prompt where an enhanced one should have been. Now three things
stop that:

- Generate and Upscale each refuse to start when any of *their* bindings is
  broken, naming the node. A broken upscale binding does not block a generate.
- A binding still holding an *old untouched default* is re-pointed at startup and
  saved, so an upgraded app never keeps writing into a node that moved.
- **Reset to defaults** puts every binding back to what this build ships with, for
  the set you are looking at, and reports anything the defaults themselves cannot
  fit.

A binding you edited by hand is never rewritten — if you know what you are doing,
the app keeps out of the way. The one shape that does get migrated is a *half*
edit: a correct new node id still carrying the old input name, like
`enhanceSwitch = 176 / switch` when node 176's input is called `cond`. That is a
real node with an input that does not exist, and it is repaired at startup — both
that and the untouched old default are listed in `BINDING_MIGRATIONS` in
`lib/config.js`.

### Queueing

Neither tab is ever locked. Submit as many prompts or upscales as you like while a
job is running — each one joins an in-app queue and starts as soon as the previous
job finishes. Only one job reaches ComfyUI at a time, which is all the hardware can
take anyway.

**There is one queue for both tabs**, because ComfyUI has one GPU and one queue.
An upscale added behind a shuffle waits for the same slot and is visible in the same
strip, and the strip, the detail panel and everything below it sit under whichever
tab you are on — you can start a batch on Generate, switch to Upscale, and watch
the same progress without losing your place.

Above the Generate button a queue strip shows everything in flight:

- `▶` with a progress bar — the job ComfyUI is chewing on right now.
- `⏳ queued 2 of 3` — waiting its turn, with a `×` to drop it. Upscale rows are
  prefixed `⤒`.
- `✓ done · 6 img` — the most recent finished job that isn't the one on screen.
  **Tap its prompt to bring that job's results up.**

The detail panel always follows whatever is actually running, so you never have to
watch a finished job. It repaints itself after a page reload too — the server
replays the current job list on connect.

**The queue is saved to disk.** `data/queue.json` holds everything in flight, so a
killed server, a dead battery or an accidental `npm` restart does not throw the
queue away. Start the server again and the jobs come back in the order you
queued them, and a toast says how many — including how many were mid-run. The
file is written by a `tmp` file and a rename, so a cut power supply leaves the
previous file whole rather than a half-written one, and it is deleted once the
queue empties.

Three details worth knowing:

- **The job that was running is saved too**, and comes back first, because it may
  own a prompt already burning GPU time. The app asks ComfyUI whether that prompt
  is still known. If it is, it re-attaches and watches it to the end. If ComfyUI
  restarted and forgot it, the run is marked failed with an explanation instead
  of hanging forever.
- **A job that had already finished is not run again.** The file is cleared as
  soon as the queue drains, so this only matters if the server is killed in the
  small window between finishing and the next save.
- **If the file cannot be written, the queue bar says so** in orange rather than
  pretending. A full phone, or a `data/` that has become read-only, is worth
  knowing about before you queue an hour of work.

The 100 most recent jobs are kept in that file. Beyond that, the oldest are
dropped — and the app says so once in the log rather than every time.

### Run timers

Each run in the detail panel carries its own generating-time clock, ticking once a
second in `m:ss` (`20:35`, and `1:02:05` once it passes the hour). It ticks on the
page's own clock, not on server messages, so it keeps moving through the long quiet
stretches where ComfyUI has nothing new to say.

**The clock starts when ComfyUI starts the run**, not when the app hands the prompt
over. A run that is handed over and then waits its turn reads `waiting at ComfyUI`
with no timer at all until ComfyUI picks it up — the header line says `2 ahead in
ComfyUI's queue` meanwhile. That distinction is the point: the number you use to
judge how long a generation takes should not include however long the queue made
you wait for it.

A finished run's clock stops where it finished. A run that was dropped from
ComfyUI's queue before it ever began has no clock, because it never generated.

### The dot in the corner, and what it actually saw

The top-right dot polls ComfyUI every few seconds and shows one word. Because one
word is rarely enough, **tapping the dot opens Settings and scrolls to the
`ComfyUI link` card**, which writes the whole thing out — the address that was
dialled, the server's own error text, and the next step — with a `copy report`
button and a `⟳ check again` button so you do not have to wait for the poll.

Each fault has its own word, because `unreachable` used to cover all of them and
four of the five are not outages:

| The dot says | It means | Do this |
|---|---|---|
| `bad address` | the host box cannot be dialled at all — a pasted `http://`, a `:8188` in the host box, a path, a space, a bare IPv6 | fix the Host / Port boxes; the message names which one |
| `no token` | there is no `token=` line in the `.env` | copy it out of the ComfyUI console, then `⟳ reload token from .env` |
| `auth failed` | ComfyUI answered and refused the token | `⟳ reload token from .env`; **restart ComfyUI first** if its password changed — ComfyUI caches the token at startup |
| `slow` | up, but nothing came back inside the wait (8s by default, `comfy.healthTimeoutMs`) | wait, or check whether it is still starting up / loading models |
| `unreachable` | nothing answered at that address | check the host and port, and that ComfyUI listens on `0.0.0.0`, not `127.0.0.1` |
| `not comfyui` | something answered with a **web page** instead of ComfyUI — usually the ComfyUI-Login screen | check the port; if the page is a login screen, reload the token |
| `http 403` / `http 500` / … | something answered, with a refusal | usually a proxy, or a port that is not ComfyUI |

`GET /api/health` returns the same report as `comfy: {host, port, state, error,
hint, problem, checkedAt}` — so `curl -s http://127.0.0.1:3081/api/health` in
Termux shows the same lines the card does, without touching the browser. It also
carries `shutdown: {allowed, because, error}`: whether *this* caller may stop the
server, and why not if it may not.

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

`send all to ComfyUI` is disabled while the queue is held for a lost connection
(there is nowhere to send it to yet); the pause bar stays visible even over an
empty queue, because the resume button is the only way back out of a pause.

Both kinds of hold survive a restart, because the queue itself is on disk — see
*The queue is saved to disk*.

### When ComfyUI is busy with somebody else's work

A second hold, and the one that is not about you at all. ComfyUI has one queue
per machine, so a generation started from another device — another browser, or the
ComfyUI page itself — is sitting in front of yours without this app knowing. Before
a job submits anything of its own, the app looks at ComfyUI's queue once:

- **Prompts it did not send are there** → the job waits here, in the open, and the
  strip says `held — ComfyUI is busy with … this app did not send`, naming how many
  are in the queue and how many of your jobs are waiting. It starts by itself the
  moment that queue empties — nobody has to watch the page or tap resume.
- **Prompts it did send are there** → nothing happens, because that is this app's
  own work waiting its turn. It never holds itself behind itself.
- **The queue cannot be read** → the job runs anyway. A `/queue` that failed to
  answer is not proof that the queue is empty, but it is not proof that it is busy
  either, and refusing to start would strand the phone over a blip.

Nothing of yours reaches ComfyUI while it waits: no prompt id, no seed burnt, no
half-submitted job. If you would rather not wait at all, `send all to ComfyUI`
stays enabled during this hold — queuing up behind that work is exactly what it
does — and the hold lifts as soon as the work is handed over.

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
(`http://127.0.0.1:<port>`, or the phone's own wifi address). The UI is reachable
from every device on the wifi, and a tap from a laptop should not kill the phone's
server. When the page is somewhere else, the card says so **before you press
anything** — `GET /api/health` carries the server's own verdict, so an orange
line appears under the button naming the address it is refusing — and if you press
it anyway the dialog stays open with the reason in it, rather than closing and
showing a toast that is gone before you have read it. `MOBILE_CFY_ALLOW_REMOTE_SHUTDOWN=1`
in the environment lifts the restriction if you want a remote button.

Endpoint: `POST /api/shutdown` with an optional `{"handover":true}`. A refusal is
`403` with the same `{allowed, because, error}` verdict as the health poll, so the
page can print the server's words instead of guessing at them.

### Viewing images

Every image is already in your download folder the moment its run finishes, so
there is no save button anywhere. Tapping a thumbnail opens the **lightbox**:

- Full-screen, with the image centred on black and given the full screen width —
  the pager buttons live in the bottom bar, not in side gutters.
- **Pinch to zoom** towards the point between your fingers, drag to pan,
  double-tap to jump between fit and a 2.5× close look. On a desktop, the mouse
  wheel zooms toward the cursor.
- `‹ 3 / 24 ›` in the bottom bar, a swipe, or the arrow keys step through the
  whole list without closing.
- The file's own name is pinned to the top of the screen, so you know which
  download you are looking at.
- `⟳ add to prompt` sends the current image to the next free reference slot.
- `⤒ upscale this` opens the Upscale tab with the image you are looking at already
  in it, which is the usual way to check an upscale against its source.
- **The phone's back gesture closes the lightbox** instead of leaving the page —
  one press gets you out of the image, a second press leaves the app.

Zoom is contained inside the image area: the photo is clipped rather than allowed
to grow over the controls, so the bottom bar and the arrows stay tappable at any
zoom level.

Pinch and wheel zoom both hold the point you are looking at still, so the image
grows *towards* your fingers (or the cursor) even when it is already zoomed and
panned — see `public/zoommath.js` for the one-line formula and `test/zoommath.test.js`
for why it is easy to get wrong.

---

## Node bindings

Every feature is a `{node, input}` pair in `config.json`, seeded from your
workflow so the server works with no configuration. Change any of them in
Settings without touching code.

| Binding | Default | Title |
|---|---|---|
| `promptEnhanced` | `41.value` | Input Prompt |
| `promptRaw` | `44.value` | Raw Prompt (If Enhance Disabled) |
| `postprompt` | `256.value` | Postprompt |
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

### The upscale bindings

The Upscale tab has its own set, in `upscaleBindings`, checked against
`upscale_api.json` (`upscaleWorkflowFile` names the file). Settings has a
**Generate / Enhanceless / Upscale** switch above the binding table that switches
which set you are editing and which graph the checks and the node list read, and
**replace upscale_api.json** uploads a new copy of the upscale graph.

| Binding | Default | Title |
|---|---|---|
| `image` | `538.image` | Image To Upscale |
| `scale` | `517.value` | Scale Multiplier |
| `scaleToDim` | `526.value` | Scale To Dim |
| `scaleToDimHeight` | `530.switch` | If/Else Switch — see the note above |
| `targetWidth` | `528.value` | Target Width |
| `targetHeight` | `529.value` | Target Height |
| `guidance` | `544.value` | Guidance Prompt |
| `batch` | `506.batch_size` | Text Encode Qwen Image 2.1 (List) |
| `seed` | `536.seed` | Seed |

The maps are independent in every direction: `POST /api/config/validate` and
`POST /api/config/bindings/reset` take a `{"kind": "generate" | "enhanceless" |
"upscale"}` body to point at another one, and a stale name dropped from one map
is reported only in that map's report key (`staleBindings`,
`staleEnhancelessBindings`, `staleUpscaleBindings`).

### The enhanceless bindings

Turning **Prompt enhance** off does not just flip node `176` — the job runs a
*different file*, `workflow_api_enhanceless.json` (`enhancelessWorkflowFile`),
which is the generate graph with the enhancer deleted out of it. That is the
performance point: no enhancer pass, so the run goes straight to the text
encoder and the samplers.

Because it is a separate export, its node ids are only *coincidentally* the same
as the normal workflow's, and a future edit to either file can desync them. So it
gets its own map, `enhancelessBindings`, and its own Settings row behind the
three-way switch. It declares only what that file actually has:

| Binding | Default | Title |
|---|---|---|
| `promptRaw` | `44.value` | Raw Prompt (If Enhance Disabled) |
| `imageCount` | `158.value` | Image Count |
| `turboSwitch` | `147.value` | TURBO On/Off |
| `stepsTurbo` / `stepsFull` | `149.value` / `150.value` | Turbo Steps / Full Steps |
| `seed` | `37.seed` | Seed |
| `megapixels` | `232.value` | Input Megapixels |
| `aspectRatio` | `9.aspect_ratio` | Resolution Selector |
| `consistencyLora` | `207.value` | Consistency LoRA |
| `inputResolution` | `204.value` | Input Resolution |
| `images` | `11` / `140` / `141` / `142` `.image` | Reference 1–4 |

`promptEnhanced`, `enhanceSwitch`, `postprompt`, `shuffleSwitch` and
`useSuggestedAspect` are deliberately absent: their nodes are not in that graph,
and a binding pointing at a missing node would fail validation on every
enhance-off run. A binding the run never reads is simply not written (blank
behaves the same way), which is why absence *is* the disable switch here.

The flag picks all three answers at once — the file, the map and the pre-flight
check — so `POST /api/generate` guards `enhancelessBindings` against
`workflow_api_enhanceless.json` when `promptEnhance` is `false`, and the normal
map against `workflow_api.json` when it is not. A broken enhanceless row refuses
enhance-off runs only; enhance-on runs are unaffected, and vice versa.

One thing stays true on the *normal* path: the payload still writes
`enhanceSwitch` = on whatever the exported file says, because an exporter that
last ran with the toggle off ships `176.cond` = `false` and would otherwise
quietly bypass the enhancer on every "enhanced" run. (The shipped
`workflow_api.json` is exactly that.)

`GET`/`PUT /api/enhanceless/workflow` reads and replaces that file without
touching the other two, and **replace workflow_api_enhanceless.json** in
Settings uploads a new copy.

### The prompt the image was actually made from

The workflow writes a text file from node `181` "Save Text", which sits on the
same wire as the text encoder — both read node `257`, the concatenation of the
enhance branch's output with your **postprompt**. The server reads the file back
after every run and stores it with the history entry, so you can see exactly what
the model was given, postprompt included:

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
  enhance off means the prompt went in as typed — via node `44` directly, since
  the enhanceless file has no switch to hand it through. If you ever see *raw*
  with enhance on, the binding is broken — Generate will have refused to start,
  so check the Settings tab. (Enhanceless runs have no SaveText node either, so
  they capture nothing — any *raw*-tagged capture in History is from before that
  workflow existed.)
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

**The dot says something other than a version number.** Tap it — it opens the
`ComfyUI link` card in Settings, which prints the address that was dialled, the
server's own error and the next step, and has a `copy report` button. The table
in *The dot in the corner, and what it actually saw* maps each word to its fix. A
common one on a phone: ComfyUI bound to `127.0.0.1` answers the phone itself but
not the LAN, so the host box needs the PC's address and ComfyUI needs
`--listen 0.0.0.0`.

**The queue says `paused` and nothing is happening.** ComfyUI stopped answering,
so the queue held itself instead of failing every run one by one. Nothing is lost
— press `▶ resume queue` when the server is reachable again, or `send all to
ComfyUI` if you would rather hand the work over first. If the server was
restarted, the queue comes back from `data/queue.json` on its own — see *The
queue is saved to disk*.

**A run is marked failed saying the server restarted.** ComfyUI had forgotten the
prompt — usually because ComfyUI itself was restarted, which empties its queue
and history. The app cannot re-watch a prompt that no longer exists, so it says
so instead of waiting forever. Submit it again.

**The queue bar warns that nothing is being saved.** The file could not be
written, usually a full phone or a `data/` that has become read-only. The queue
still works; a restart just loses it.

**The queue says `held` and the wait looks unending.** That is the other pause:
ComfyUI is busy with prompts this app never sent, most likely from another device
on the same server. Your jobs wait in the open rather than disappearing into
ComfyUI's queue, and they start on their own the moment it empties — check the
other device (or a ComfyUI tab) rather than pressing resume. `send all to ComfyUI`
is enabled here on purpose: it is the way to stop waiting. See *When ComfyUI is
busy with somebody else's work*.

**Generation is slow.** The prompt enhancer runs a Qwen3-VL model and dominates
runtime — minutes per run is normal. Turn it off for a much faster turnaround.

**An image is badged `not downloaded` or `gone`.** The gallery is showing it
because ComfyUI still has it, but the copy in the download folder failed. The retry
sweep works on its own every 15s; **retry downloads** forces it now. `gone` means
the budget ran out or ComfyUI no longer has the file (ComfyUI prunes its output
folder — a `gone` image may only exist in this app's gallery from now on). See
*When a download fails*.

**The shut down button does nothing.** It only works when the page is served *from
the phone itself* (`http://127.0.0.1:<port>`), because the UI is reachable from
every device on the wifi and a tap from a laptop should not kill the phone's
server. Open the UI on the phone — `bash start.sh` prints the loopback address and
does not open a browser on its own any more. If you genuinely want a remote button,
start the server with `MOBILE_CFY_ALLOW_REMOTE_SHUTDOWN=1`.

If the button was pressed from the wrong device the Settings card says so, in
orange, the moment the page loads — you do not have to press it to find out.

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

Tests cover config merging and the binding/value migrations, payload construction
for **all three** graphs (including that enhance-off runs write node `44` in the
enhanceless file, that the enhanceless map declares nothing that file lacks, and
that the normal path forces `176.cond` on whatever the export says), the run
matrix, prompt-text capture, download naming, upload
sniffing and multipart parsing, the history store, the bindings panel's verdict
rendering, the page's own wiring — every id it reaches for exists in `index.html`
and every API path it calls is registered in `server.js` — and the page BOOTING
itself against a stub DOM (`test/boot.test.js` runs `app.js` the way a browser
would, so a single bad element reference at module scope can never again silently
kill the lightbox's swipe and pinch handlers or the shutdown wiring) — the queue — bulk submit,
an auto-paused queue, offline building, resume, cancel, the run-timer start, a
pinned seed, a postprompt written verbatim and recorded on the row, and an upscale
job sharing the queue with a generate — the Upscale tab's HTTP
surface end to end (including a batch of 4 landing in node 506 as one prompt) —
the enhanceless HTTP surface (each flag refusing runs against its OWN binding
map, and an enhance-off run arriving at ComfyUI as the enhanceless graph),
the download-retry sweep, the run-timer format, focal-point
zoom math, the hold for somebody else's work in ComfyUI's queue, every health
answer (no answer, a slow answer, a login page, a refusal, a nonsense address),
the queue surviving a killed process, the arithmetic the Upscale tab prints
under the picture (including a check that it still matches the workflow it
transcribes), and the shut down
route — including that a page which may not press the button is told so before it
presses it, and the three-workflow split (the enhanceless file, its own binding
map, one flag picking file + map + pre-flight together). 282 of them; they need
no network and no real
ComfyUI (`test/queue.test.js`, `test/retry.test.js`, `test/shutdown.test.js`,
`test/upscale.test.js`, `test/enhanceless.test.js` and `test/persist.test.js`
each run a fake ComfyUI from
the shared `test/helpers/fakeComfy.js`). Every temp root a test creates is
deleted again, so running the suite on the phone does not leave litter behind.

`test/reset.test.js` starts a second server on port 3082, `test/shutdown.test.js`
on 3083, `test/upscale.test.js` on 3084 and `test/enhanceless.test.js` on 3085,
each with `MOBILE_CFY_ROOT` pointed at
a temp directory, so they never touch the instance you are using. That temp root
has no `public/` in it on purpose: it proves the web page is served from the app
and not from wherever the data happens to live.

The server runs unchanged on Windows for development:

```bash
node server.js
```

### Layout

```
server.js          http server, router, static files
start.sh stop.sh   Termux launcher
config.json        generated; all node ids and paths
workflow_api.json  the ComfyUI workflow, API format (generate)
workflow_api_enhanceless.json  same graph, enhancer deleted (generate, enhance off)
upscale_api.json   the ComfyUI workflow, API format (upscale)
lib/               config, comfy, ws, payload, runner, download, gallery,
                   history, queuedb, uploads, multipart, env, retry, shutdown
public/            index.html, app.js, style.css, bindmark.js, durfmt.js,
                   zoommath.js, upmath.js   (no build step)
                   durfmt.js, zoommath.js and upmath.js are browser-side pure functions,
                   pulled out of app.js because the browser parts of app.js are
                   not unit-testable (see PLAN.md)
test/              node --test  (helpers/fakeComfy.js is the shared fake server)
data/
  history.json     prompt memory (300 newest)
  index.json       gallery index
  queue.json       the in-flight queue, so a restart does not lose it
  uploads/         reference images you attached
```

`PLAN.md` holds the design rationale, the full node map, and the reasoning behind
each binding.