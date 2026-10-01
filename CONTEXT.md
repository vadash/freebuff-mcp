# freebuff-supervisor: context

Domain language for this repo: what each word means. Where the code for a
term lives: [AGENTS.md](AGENTS.md#code-map).

## Glossary

### Processes

- **Supervisor**: the long-lived daemon that owns the Instance, the Queue and
the Watchdog. Outlives harness restarts. At most one runs per pipe name; a
second start with the same code exits immediately, and a start with different
code replaces the holder (ADR-0005).
- **MCP server**: the stdio proxy the harness launches. Holds no state.
- **Driver**: the code that runs the Instance in a pseudo-terminal, types into
  it, and reads the Screen and Chat store.
- **Instance**: one running freebuff process. The Supervisor runs at most one
  at a time. The CLI writes no pid record to disk — the Supervisor reads the
  pid from its own PTY. Killing it is cheap because the Hour session resumes
  on relaunch. _Avoid:_ "session" (for the process).
- **Session-in-use dialog**: freebuff's claim check at startup, shown when the
  Hour session is still claimed elsewhere. `Take over` is the recovery path.
  Older CLIs worded it "Freebuff is already running" or "Session already in
  use"; from 0.1.0 a concurrent spawn takes the Hour session over silently —
  the first Instance's Countdown just vanishes. _Avoid:_ "single-instance
  dialog".

### Freebuff's economy

- **Hour session**: freebuff's one-hour, wall-clock usage window. It starts
  with the Instance's first message from the Welcome screen, is locked to the
  directory the Instance was started in, keeps ticking whatever we do, and
  resumes when freebuff is relaunched in that directory. The Supervisor never
  ends one early. _Avoid:_ "trial session", "trial clock",
  bare "session".
- **Countdown**: the minutes-left marker on the Screen's status line
  (`7h 12m left`, `1h left`, `59m left`, `2:58 left`), i.e. minutes left in the
  Hour session.
- **Freebucks**: freebuff's daily allowance (25 or 40), shown on the session
  screen's account box as `<remaining>/<daily> Freebucks remaining`. From 0.1.2
  the Welcome screen no longer shows it.
- **Freebucks reset**: the moment the daily allowance refreshes: 21:00 UTC
  (00:00 Istanbul). The Welcome screen's "+15 Freebucks every Pacific day"
  perk line notwithstanding, the measured allowance clock is 21:00 UTC, not
  Pacific midnight.
  _Avoid:_ "Pacific midnight" (for the reset).
- **Streak keeper**: the daily routine that keeps freebuff's login streak
  alive: if the Chat store shows no activity in the current allowance window,
  it runs one small read-only Task; otherwise it does nothing. The keeper
  never ends an Hour session and shuts down only a Supervisor it started
  itself.
- **Welcome screen**: the screen the Instance idles on when no Hour session is
  running: logo, account info box ("Your first message starts the session."),
  and the ready input box. Submitting a Task there is the first message: it
  starts the Hour session. There is no model choice.
  _Avoid:_ "model picker", "start screen".
- **Active model**: the model shown before the first `·` on the status line,
  whenever the Instance runs — session or not. Freebuff remembers the model;
  the supervisor never changes it. Re-derived from the Screen on every read,
  never stored; null when the Instance is not running.
  _Avoid:_ "selected model", "current model", "picked model".
- **Continue screen**: the out-of-credits claim check — a credits summary
  (remaining balance, spending rule) ending in "Press Enter to continue".
  Enter starts the next Hour session; the Supervisor presses it only when a
  task arrives. Plain expiry with balance remaining shows no such dialog: the
  Countdown vanishes and the screen reverts to the Welcome look.

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
  Supervisor sends it before every Task. _Avoid:_ "session" (for the context).
- **Turn**: the model's run on one Task, from submit to Turn end. The prompt
goes in as one bracketed paste and is submitted once.
- **TurnRunner**: the module that runs one Task's Turn: submits the prompt (the
  fixed preamble; over 64 KB as a file referral), owns the Watchdog for the
  Turn's duration, and classifies the outcome: Answer, deadline, frozen,
  crashed, cancelled, no Answer. Respawn policy stays with the Supervisor.
- **Ack**: the Chat store line proving freebuff received the prompt; the Screen
  showing the working state corroborates receipt. One retry only when neither
  signal appears.
- **Turn end**: the `Main prompt finished` line in the Chat store after the
  Task's baseline.
- **Answer**: `data.fullResponse` of the Turn end line; what `run_prompt`
  returns. A Turn end without one fails the Task with `no_answer`.
- **Big payload**: a prompt over 64 KB, written to a file in the Workspace
  and sent as a file reference.

### Observation

- **Observation**: the snapshot the Driver hands the Supervisor on every read:
  the Screen text exactly as the Driver and the Watchdog read it, Instance
  liveness and pid, the login flag, and the Hour-session facts observed on the
  Screen. Memory-only; the Drift record is a separate, disk-backed read.
- **Screen**: the rendered terminal, flattened to text. Used for state only,
  never for the Answer.
- **Chat store**: freebuff's on-disk chat logs (`log.jsonl` per chat dir).
- **Marker**: one screen or chat pattern the protocol depends on, backed by
  fixtures. A screen Marker is strong (specific to its screen) or weak
  (generic, e.g. `Esc`). _Avoid:_ "cue".
- **Holding banner**: the line freebuff paints over a settled Screen while the
  CLI holds queued input until it rejoins the Hour session ("Freebuff session
  over; holding queued messages until rejoin"). It swallows Enters: anything
  typed into it flushes as one merged line when it clears. The Settle loop
  rides it out; `/new` waits until it clears.
  _Avoid:_ "reconnect banner".
- **Working screen**: the mid-Turn Screen: the elapsed spinner with the
  Esc hint over the settled Screen. Its appearance after a submit corroborates
  the Ack.
  _Avoid:_ "spinner screen".
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
- **Settle loop**: the Driver's wait, at spawn and before each Task, for a settled
  Screen: `ready`, or `idle` at the Welcome screen or Continue screen. While it
  waits it names each Screen through the one recognition table, rides the
  Holding banner out without keystrokes, saves unknown and
  degraded Screens as Screen dumps, answers the Session-in-use dialog through the
  one Enter throttle shared with the Fallback Enter, and presses the Continue
  screen once per Task arrival. Its deadline fails the Task with `ready_timeout`.
  _Avoid:_ "settle check", "ready wait".
- **Fallback Enter**: in the Settle loop, a Screen that stays
  unrecognized for ~10 s gets one Enter, then another every ~10 s until a
  recognized screen shows. Accepted cost: a stray Enter on an unrecognized
  screen lands in the input box and submits nothing.

_Avoid:_ "park", "parked", "parking". The Instance idles; it is never parked,
and `/end-session` is never sent.

## Supervisor states

```
stopped ──run_prompt──► spawning ──► idle ──Task arrives, first message starts the session──► busy ⇄ ready
                                  ▲                                     │
                                  └──── Hour session expired ◄──────────┘
```

- `spawning` lands in `idle` (no Hour session for this directory) or `ready`
  (an unexpired Hour session resumed).
- `ready ──Task──► busy ──Turn end──► ready`.
- After expiry the screen reverts to the Welcome look (no Countdown) and counts
  as `idle`; the next Task is the first message of a fresh Hour session. The
  Continue screen (out of credits) also counts as `idle`; there the next Task
  presses Enter first.
- Kill, crash, freeze or cancel respawns the Instance back through `spawning`.
- A spawn failure (e.g. `needs_login`) returns to `stopped`.

- `stopped`: no Instance.
- `spawning`: Instance starting in the Workspace.
- `idle`: Instance at the Welcome screen or the Continue screen; no Hour
  session is ticking for this directory.
- `ready`: Hour session running, input box idle, Queue empty.
- `busy`: a Task's Turn is running.
