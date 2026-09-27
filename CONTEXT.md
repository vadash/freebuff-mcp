# freebuff-supervisor: context

Domain language for this repo: what each word means. Where the code for a
term lives: [AGENTS.md](AGENTS.md#code-map).

## Glossary

### Processes

- **Supervisor**: the long-lived daemon that owns the Instance, the Queue and
  the Watchdog. Outlives harness restarts. At most one runs per pipe name; a
  second start exits immediately.
- **MCP server**: the stdio proxy the harness launches. Holds no state.
- **Driver**: the code that runs the Instance in a pseudo-terminal, types into
  it, and reads the Screen and Chat store.
- **Instance**: one running freebuff process. The Supervisor runs at most one
  at a time. The CLI writes no pid record to disk — the Supervisor reads the
  pid from its own PTY. Killing it is cheap because the Hour session resumes
  on relaunch. _Avoid:_ "session" (for the process).
- **Session-in-use dialog**: freebuff's claim check at startup, shown when the
  Hour session is still claimed elsewhere (seen after an Instance was killed
  mid-session). `Take over` is the recovery path. Older CLIs worded it
  "Freebuff is already running". _Avoid:_ "single-instance dialog".

### Freebuff's economy

- **Hour session**: freebuff's one-hour, wall-clock usage window. It starts
  when a model is picked at the Model picker, is locked to the directory the
  Instance was started in, keeps ticking whatever we do, and resumes when
  freebuff is relaunched in that directory. The Supervisor never ends one
  early. _Avoid:_ "trial session", "trial clock",
  bare "session".
- **Countdown**: the minutes-left marker on the Screen's status line
  (`7h 12m left`, `1h left`, `59m left`, `2:58 left`), i.e. minutes left in the
  Hour session.
- **Freebucks**: freebuff's daily allowance (25 or 40). Starting an Hour
  session costs the picked model's price (e.g. 0/5/10).
- **Freebucks reset**: the moment the daily allowance refreshes: 21:00 UTC
  (00:00 Istanbul), measured from the picker's `resets in` countdown. The
  picker's "+15 Freebucks every Pacific day" perk line notwithstanding, the
  measured allowance clock is 21:00 UTC, not Pacific midnight.
  _Avoid:_ "Pacific midnight" (for the reset).
- **Streak keeper**: the daily routine that keeps freebuff's login streak
  alive: if the Chat store shows no activity in the current allowance window,
  it runs one small read-only Task; otherwise it does nothing. The keeper
  never ends an Hour session and shuts down only a Supervisor it started
  itself.
- **Model picker**: the screen titled "Start coding for free" that lists models
  and prices. Picking one starts an Hour session. The Instance idles here when
  no Hour session is running.
- **Pick rule**: how the Driver picks at the Model picker, in order: the first
  deepseek row the Freebucks balance can afford (an unreadable balance counts
  as unaffordable), else the first glm row, else the first mimo row, else the
  top row. Names match case-insensitively, in displayed order. Re-applied on
  every Task that finds the picker. _Avoid:_ "model strategy", "preferred model".
- **Active model**: the model an Hour session runs with, shown before the first
  `·` on the ready status line. Re-derived from the Screen on every read,
  never stored; null whenever no Hour session is running.
  _Avoid:_ "selected model", "current model".
- **Continue screen**: shown after an Hour session expires ("press Enter to
  continue"). Enter starts the next Hour session. The Supervisor presses it
  only when a task arrives.

### Work

- **Workspace**: the fixed directory, derived from the pipe name, that the
  Instance always runs in (`%TEMP%\freebuff-ws-<hash>`). Stable across
  restarts, so switching repos never restarts the Instance or the Hour
  session. _Avoid:_ "bound directory", "working directory", `cwd` (except for
  the OS process cwd).
- **Junction**: the `repo` link inside the Workspace, pointing at the
  **target directory**. A Windows junction: no admin rights to create, and
  removing it deletes only the link. Swapped only while no Task runs;
  recreated by itself if deleted. _Avoid:_ "symlink", "mount".
- **Target directory**: the caller's real repo, named by every `run_prompt`.
  Filesystem roots, the Workspace itself, and its ancestors are refused as
  unsafe targets. "Project" is kept only for freebuff's Chat store key (the
  Workspace basename). _Avoid:_ "bound directory".
- **Task**: one `run_prompt` call: a prompt queued against the target
  directory. The supervisor prepends a fixed preamble pointing the model at
  `repo/`, so prompts can name repo paths as if the repo were the cwd.
- **Queue**: FIFO of Tasks waiting behind the active one, depth 4. A full Queue
  fails with `busy` and a position.
- **Conversation**: freebuff's chat context. `/new` starts a fresh one; the
  Supervisor sends it before every Task. The `new_session` tool sends `/new` to the
  running Instance, which is never killed for it. _Avoid:_ "session" (for the context).
- **Turn**: the model's run on one Task, from submit to Turn end. The prompt
  goes in as one bracketed paste and is submitted once.
- **Ack**: the Chat store line proving freebuff received the prompt. One retry
  if it is missing.
- **Turn end**: the `Main prompt finished` line in the Chat store after the
  Task's baseline.
- **Answer**: `data.fullResponse` of the Turn end line; what `run_prompt`
  returns. A Turn end without one fails the Task with `no_answer`.
- **Big payload**: a prompt over 64 KB, written to a file in the Workspace
  and sent as a file reference.

### Observation

- **Screen**: the rendered terminal, flattened to text. Used for state only,
  never for the Answer.
- **Chat store**: freebuff's on-disk chat logs (`log.jsonl` per chat dir).
- **Marker**: one screen or chat pattern the protocol depends on, backed by
  fixtures. A screen Marker is strong (specific to its screen) or weak
  (generic, e.g. `Esc`). _Avoid:_ "cue".
- **Screen signature**: how a known screen is recognized: its Markers, how
  many must match (at least one strong), and the region of the Screen they
  are searched in. When two signatures match, a fixed priority decides.
  _Avoid:_ "screen rule".
- **Freeze key**: the Screen minus its Countdown and Freebucks lines; what the
  Watchdog compares for freezes and what names a Screen dump. _Avoid:_
  "freeze signature".
- **Watchdog**: fails a Task on freeze (Freeze key and Chat store unchanged
  for 3 minutes), crash, or its 20-minute deadline, then respawns the
  Instance. Never resubmits the prompt.
- **Doctor**: checks the showing screen against its Screen signature: pass
  (every Marker), degraded (Drift: threshold met, some Marker missing) or
  fail. Not run while the Instance starts.
- **Error log**: Screen lines matching the known error Markers seen during a
  Turn, appended with a timestamp and the Workspace, once per Turn. Never
  acted on.
- **Screen dump**: an unrecognized or degraded Screen saved while the settle
  loop waits, one file per Freeze key, so Countdown repaints dedupe to one file.
  Write-only diagnostics; drift shows up as data, not as failed Tasks. Fixing
  Drift mostly means promoting a dump into the fixture corpus.
- **Drift**: a CLI update changing a known screen so that some of its Markers
  no longer match. Detected, not prevented; a recapture follows a drift
  signal, never a version bump alone.
- **Fallback Enter**: while the Instance starts, a Screen that stays
  unrecognized for ~10 s gets one Enter, then another every ~10 s until a
  recognized screen shows. Accepted cost: if the unrecognized screen is a
  drifted Model picker, Enter starts an Hour session on the highlighted model.
  _Avoid:_ "fallback pick".

_Avoid:_ "park", "parked", "parking". The Instance idles; it is never parked,
and `/end-session` is never sent.

## Supervisor states

```
stopped ──run_prompt──► spawning ──► picker ──Task arrives, model picked──► busy ⇄ ready
                                  ▲                                     │
                                  └──── Hour session expired ◄──────────┘
```

- `spawning` lands in `picker` (no Hour session for this directory) or `ready`
  (an unexpired Hour session resumed).
- `ready ──Task──► busy ──Turn end──► ready`.
- After expiry the Continue screen counts as `picker`; the next Task presses
  Enter and goes to `busy`.
- Kill, crash, freeze or cancel respawns the Instance back through `spawning`.
- A spawn failure (e.g. `needs_login`) returns to `stopped`.

- `stopped`: no Instance.
- `spawning`: Instance starting in the Workspace.
- `picker`: Instance at the Model picker or the Continue screen; no Hour
  session is ticking for this directory.
- `ready`: Hour session running, input box idle, Queue empty.
- `busy`: a Task's Turn is running.
