# freebuff-supervisor: context

Domain language for this repo. Decisions and their reasons live in
[`docs/adr/`](docs/adr/); start with
[ADR-0001](docs/adr/0001-supervised-freebuff-cli.md).

## Moving parts

```
MCP client (harness)
   │ stdio
   ▼
MCP server  src/server.ts        thin proxy; starts the Supervisor on demand
   │ named pipe \\.\pipe\freebuff-supervisor
   ▼
Supervisor  src/supervisor.ts    Queue, Bound directory, Bind lock, Watchdog
   │
   ▼
Driver      src/driver.ts        keystrokes in; reads Screen and Chat store
   │ ConPTY (node-pty)
   ▼
Instance    freebuff.exe         one at a time, started in the Bound directory
   ├─► Screen      rendered by @xterm/headless → state only (src/protocol/screen.ts)
   └─► Chat store  <configDir>/…/log.jsonl → Ack, Turn end, Answer (src/protocol/chatStore.ts)
```

## Glossary

### Processes

- **Supervisor**: the long-lived daemon that owns the Instance, the Queue and
  the Watchdog. Outlives harness restarts.
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
  early. Code: `hourSession`. _Avoid:_ "trial session", "trial clock",
  bare "session".
- **Countdown**: the minutes-left marker on the Screen's status line
  (`7h 12m left`, `1h left`, `59m left`, `2:58 left`), i.e. minutes left in the
  Hour session.
- **Freebucks**: freebuff's daily allowance (25 or 40). Starting an Hour
  session costs the picked model's price (e.g. 0/5/10).
- **Model picker**: the screen titled "Start coding for free" that lists models
  and prices. Picking one starts an Hour session. The Instance idles here when
  no Hour session is running.
- **Continue screen**: shown after an Hour session expires ("press Enter to
  continue"). Enter starts the next Hour session. The Supervisor presses it
  only when a task arrives.

### Work

- **Bound directory**: the single directory the Supervisor serves, set by
  `bind`. Every `run_prompt` must name it. _Avoid:_ "project dir", "target
  dir", "working directory", `cwd` (except for the OS process cwd). "Project"
  is kept only for freebuff's Chat store key (the directory basename).
- **Bind lock**: `bind` to a different directory is refused while more than 30
  minutes of the Hour session remain (`bound_dir_locked`).
- **Task**: one `run_prompt` call: a prompt queued against the Bound directory.
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
- **Big payload**: a prompt over 64 KB, written to a file in the Bound
  directory and sent as a file reference.

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
  Turn, appended with a timestamp and the Bound directory, once per Turn. Never
  acted on.
- **Screen dump**: an unrecognized or degraded Screen saved as
  `<configDir>/screen-dumps/<version>/<hash>.ansi` while the settle loop waits.
  The hash is of the Freeze key, so Countdown repaints dedupe to one file.
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
stopped ──bind──► spawning ──► picker ──Task arrives, model picked──► busy ⇄ ready
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
- `spawning`: Instance starting in the Bound directory.
- `picker`: Instance at the Model picker or the Continue screen; no Hour
  session is ticking for this directory.
- `ready`: Hour session running, input box idle, Queue empty.
- `busy`: a Task's Turn is running.

Flags reported by `status` alongside the state: `needsLogin` (freebuff demands
`freebuff login`, never retried automatically) and `updatePending` (a newer
CLI is installed than the running Instance).
