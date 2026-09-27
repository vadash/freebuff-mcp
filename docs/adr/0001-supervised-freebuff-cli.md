# ADR-0001: Supervise one freebuff CLI Instance behind an MCP proxy

- **Status:** Accepted (2026-09-24). Records the design decided after the v1
  review; the code lags it in places (see README "Known issues").
  Partially superseded (2026-09-27): §4's eager spawn at bind and all of §5 by
  [ADR-0003](0003-workspace-junction-replaces-bind.md).
- **Supersedes:** the parking design in spec #1 (park at the model picker via
  `/end-session`).

## Context

Freebuff is TUI-only: no headless mode, no `--prompt` flag, no API. It enforces
a single running instance. Its free usage comes in **Hour sessions**: picking a
model at the picker starts a one-hour wall-clock timer, locked to the directory
freebuff was started in. The timer runs whatever we do (idle, busy, or with
freebuff closed). Relaunching freebuff in the same directory resumes an
unexpired Hour session; `/end-session` ends it early and returns nothing.
Starting an Hour session costs Freebucks (e.g. 0/5/10 per model, from a daily
allowance of 25 or 40).

A harness (Claude Code, etc.) wants to hand freebuff coding tasks and get the
final answer back, and it restarts often.

## Decision

### 1. Architecture: thin MCP proxy, long-lived supervisor

- `src/server.ts` is a stdio MCP server that only forwards tool calls. It
  starts the supervisor on demand if none is listening, through `start /b`
  under a hidden cmd: the supervisor outlives the server and owns a hidden
  console, which everything it starts inherits.
- `src/supervisor.ts` is a daemon that owns the single freebuff **Instance**,
  the task **Queue**, and the watchdog. It outlives harness restarts, so
  closing the harness never kills a running task or the Hour session.
- They talk over a Windows **named pipe** (`\\.\pipe\freebuff-supervisor`):
  Windows-native local IPC, no TCP port to collide with or open in a firewall,
  unreachable from other machines, and the fixed name doubles as the
  "supervisor already running" check.
- `src/driver.ts` runs freebuff in a pseudo-terminal (node-pty ConPTY).

### 2. Protocol: keystrokes in, chat store out

- Prompts go in as keystrokes. Answers come from freebuff's **Chat store**
  (`log.jsonl`: the ack line, then `Main prompt finished` with
  `data.fullResponse`). The **Screen** (rendered by `@xterm/headless`) is read
  only for state (ready, picker, login, countdown, Freebucks), never for the
  answer.
- CLI only. The Freebuff Desktop HTTP backend and the "backend interface seam"
  from spec #1 are dropped permanently.

### 3. Never end an Hour session early

- The supervisor never sends `/end-session`.
- With no Hour session running, the Instance idles at the **Model picker**
  (free). A model is picked only when a task arrives.
- With an Hour session running, the Instance idles at the ready input box; the
  timer runs anyway.
- When an Hour session expires, freebuff lets the current turn finish and then
  shows a "press Enter to continue" screen. The supervisor presses Enter
  lazily, only when the next task arrives, so a fresh hour never starts idle.

### 4. Spawn and ownership

- `bind` spawns the Instance straight away and leaves it at the picker, so
  `needs_login`, updates, and bad directories surface before any task.
- A live freebuff the supervisor did not start: legacy builds record the holder
  pid in a lock file, which the supervisor kills at spawn
  (`taskkill /PID <pid> /T /F`). The 2026-09 CLI (0.0.198+) writes no pid
  record — it refuses a second spawn itself with the Session-in-use dialog,
  and the settle loop answers it with `Take over` unconditionally (killing is
  cheap since the Hour session resumes on relaunch).
- Stopping the supervisor's own Instance is always a kill, including
  `cancel_task`.

### 5. One Bound directory, with a Bind lock

> Superseded by [ADR-0003](0003-workspace-junction-replaces-bind.md) — kept for
> the record of why the Bind lock existed.

- The supervisor serves one Bound directory at a time. Rebinding to another
  directory starts a new Hour session there (costing Freebucks) while the old
  one keeps ticking, so this tool is only economical for work in one directory.
- **Bind lock:** `bind` to a different directory fails with `bound_dir_locked`
  (reporting `unlocksInMinutes` and the Bound directory) while more than 30
  minutes of the Hour session remain, as read from the Screen countdown.
  Re-binding the same directory is a no-op; binding with no Hour session
  running, or with 30 minutes or less left, is allowed.
- No `force` flag. The Bound directory is not persisted, so restarting the
  supervisor is the human escape hatch.
- `bind` purges queued tasks (spec #5) and is refused while a task runs.
- Multi-directory support (e.g. via symlinks) is out of scope for v1.

### 6. Hardcoded model pick

At the picker, in order:

1. If the Freebucks balance covers the price shown on the first row containing
   `deepseek`, pick it.
2. Else the first row containing `glm`.
3. Else the first row containing `mimo`.
4. Else the top row.

Matching is a case-insensitive substring in displayed order; affordability gates
only the deepseek candidate. The rule runs over the picker rows and balance
parsed from the Screen (`classifyScreen().entries`, `freebucksBalance`), not raw
lines. Verified against the 0.0.199 capture (2026-09-26): the picker is born
collapsed to a single `GLM 5.3 Flash` row (`0 Freebucks/hr`, `↓  See all 5
models` below), so the rule lands on GLM and the deepseek affordability gate is
not exercised by today's wording; the seam stays covered by stub tests with
synthetic rows. `status.activeModel` reports the model observed on the ready
status line. The model policy file (`FREEBUFF_MODELS_FILE`) and the
`settings.json` `freebuffModel` write are removed: CLI v0.0.188 ignores that
setting. This reverses spec #1's "never switch models with arrow keys", which
relied on that setting. The rule is hardcoded for v1 and easy to reverse.

### 7. Watchdog and deadline

- **Freeze:** no change for 3 minutes in either the Screen (ignoring the
  countdown and Freebucks lines) or the Chat store.
- On freeze or crash: respawn the Instance (cheap, the Hour session resumes)
  and fail the task with `frozen` or `crashed` plus the last screen lines.
  Never resubmit the prompt automatically; a half-run coding task is not
  idempotent. This removes the per-task respawn cap.
- One 20-minute deadline per task, measured from task start.
- Error-looking output (red text, known error strings) triggers no action. It
  is appended to a log for later analysis. Red alone is ambiguous: diffs show
  deleted lines in red.

### 8. Accepted divergences from spec #1

- Two extra MCP tools: `doctor`, and `screen` (issue #21), which returns the
  raw Screen text the Driver reads, blank rows included.
- A `shutdown` pipe op (used by tests and for clean teardown).
- Node.js 22.6+: sources run via `--experimental-strip-types`, no build step.
- `cancel_task` kills the Instance instead of confirming it went idle.
- No backup turn-end signal (transcript mtime). A finished turn with no
  `fullResponse` fails the task with `no_answer`.
- No visible console window: the Instance runs headless in ConPTY, and the
  supervisor's hidden console keeps the helpers it starts (node-pty's kill
  agent, `taskkill`) from opening one each. A detached, console-less
  supervisor flashed a window for every one of them.

## Consequences

- Windows-only (named pipe, `freebuff.exe`/`.cmd` lookup, `taskkill`).
- The tool is economical only when the harness works in one directory; the Bind
  lock keeps a confused caller from burning a fresh Hour session every call.
- Model choice drives how many Hour sessions a day allows (DeepSeek at 5
  Freebucks vs GLM at about 8).
- Everything hinges on screen wording (picker lines, prices, countdown, expiry
  screen), so real screen captures must back `src/protocol/markers.ts`.
