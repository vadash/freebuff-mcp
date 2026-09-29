# freebuff-supervisor

An MCP server that lets a coding harness (Claude Code, etc.) hand tasks to the
freebuff CLI and get the final answer back. freebuff has no API or headless
mode, so a long-lived supervisor drives one freebuff instance in a
pseudo-terminal, reads its rendered screen for state, and reads its on-disk
chat log for the answer.

The repository is named `freebuff-mcp` after the upstream project it adapts;
the package and MCP server are named `freebuff-supervisor` because
`freebuff-mcp` is taken.

## Prerequisites

- **Windows.** The supervisor uses a named pipe and ConPTY.
- **Node.js 22.6 or newer.** Sources run directly via
  `--experimental-strip-types`; there is no build step.
- **The freebuff CLI** on `PATH`, signed in once with `freebuff login`.

## Install and configure

```
npm install
```

```json
{
  "mcpServers": {
    "freebuff-supervisor": {
      "command": "node",
      "args": ["--experimental-strip-types", "<path-to-repo>/src/server.ts"]
    }
  }
}
```

The MCP server starts the supervisor in the background on first use. The
supervisor keeps running when the harness restarts, so a running task or live
freebuff instance survives it.

## What it costs

freebuff's free usage comes in one-hour **Hour sessions**, each started by the
first message you send and paid for in **Freebucks** from a daily allowance.
The supervisor runs freebuff in one fixed Workspace directory and mounts your
repo inside it, so **all repos share one Hour session**: switching repos is
free. The Hour session keeps ticking while idle, and the supervisor never ends
one early. There is no model selection: freebuff runs the model it remembers
([ADR-0004](docs/adr/0004-no-model-selection.md)). The terms are defined in
[CONTEXT.md](CONTEXT.md#freebuffs-economy).

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `run_prompt` | `dir`, `prompt` | Queues the prompt against the repo `dir` and waits for freebuff's final answer. Each task runs in a fresh conversation, so a prompt must be self-contained. The supervisor mounts `dir` at the `repo` junction inside the Workspace (swapping it while no task runs; a switch while a task is active is refused). The prompt is sent as one bracketed paste and submitted once, so multi-line prompts arrive intact. Prompts over 64 KB are written to a file in the Workspace and passed by reference. |
| `cancel_task` | none | Stops the active task by stopping freebuff; the next queued task then runs. |
| `status` | none | JSON with the fields below. |
| `screen` | none | The running Instance's current Screen, flattened to text — the exact text the supervisor reads. Works in every supervisor state; empty until the Instance first paints. |
| `doctor` | none | Reports the showing Screen's verdict against its Screen signature: `pass` (every Marker present), `degraded` (Drift has started — threshold still met, some Marker missing, named in `missing`) or `fail` (below threshold). Returns `{ ok, skipped, screen, level, missing }`; `skipped` (with `ok: false`) when no idle instance is running. Advisory: a drift report never blocks a task. |

`status` fields:

| Field | Meaning |
|---|---|
| `state` | `stopped`, `spawning`, `idle`, `ready` or `busy` ([Supervisor states](CONTEXT.md#supervisor-states)) |
| `workspaceDir` | The Workspace — the fixed directory the Instance always runs in |
| `targetDir` | The repo the `repo` junction currently points at, or `null` before the first task |
| `queueDepth` | Tasks waiting behind the active one (max 4) |
| `activeModel` | Model observed on the footer status line; `null` while no Instance runs or the footer is not recognized |
| `hourSessionMinutesLeft` | Minutes left in the Hour session, from the screen countdown |
| `freebucksDaily` | Daily Freebucks allowance parsed from the screen's balance line (e.g. 25); `null` while no Instance runs or no balance is on screen |
| `needsLogin` | freebuff demands `freebuff login`; never retried automatically |
| `screenDrift` | The installed CLI version has an unknown or degraded Screen on record (a [Screen dump](#screen-dumps)) that the fixture corpus does not cover yet; clears when an update changes the installed version or the dump is promoted into the corpus |
| `instancePid` | OS pid of the running freebuff Instance, or `null` |
| `fingerprint` | The daemon's code identity (ADR-0005); the MCP server compares it with its own and swaps the daemon on mismatch |

### Failures

Failed calls return `isError: true` with a message. Driver failures read
`freebuff driver failure: <reason>`; watchdog failures read
`watchdog failure: <reason>: <detail>` followed by the
last screen lines. After a watchdog failure the supervisor respawns freebuff
(the Hour session resumes) and the next queued task runs normally. The prompt
is never resent: a half-run coding task is not safe to repeat.

| Reason | Meaning |
|---|---|
| `needs_login` | Run `freebuff login` yourself; never retried automatically. |
| `dir_mismatch` | freebuff came up in a different directory than the Workspace. |
| `ready_timeout` | freebuff never reached its input box (includes a screen excerpt). |
| `ack_missing` | freebuff did not record the prompt, even after one retry. |
| `no_answer` | The turn ended without a final answer. freebuff stays up and the next queued task runs. |
| `process_exited` | freebuff exited while starting up. |
| `frozen` | Watchdog: neither the screen (ignoring the countdown and Freebucks lines) nor the chat log changed for 3 minutes. |
| `crashed` | Watchdog: freebuff exited mid-task. |
| `deadline` | Watchdog: the task was still running 20 minutes after it started, even if it kept producing output. |

A full queue fails with `isError: true` and the text `{ "busy": true, "position": N }`.

### Error log

While a task runs, screen lines matching freebuff's known error strings (e.g.
`Command not found: …`) are appended to
`%LOCALAPPDATA%\freebuff-supervisor\errors.jsonl`, one JSON line per entry with
`time`, `workspace` and the matched `lines`. A line is logged once per task.
Nothing acts on the log, and the task carries on. Set `FREEBUFF_ERROR_LOG` in
the supervisor's environment to write it elsewhere.

### Screen dumps

When a freebuff update changes a screen the supervisor reads, that screen is
saved under `<configDir>\screen-dumps\<version>\<hash>.ansi` and `status`
reports `screenDrift: true`. Tasks keep running; the dump is the evidence a
maintainer needs to teach the supervisor the new wording. Nothing reads dumps
back.

## Streak keeper

freebuff rewards a daily login streak. The optional streak keeper runs one
small read-only task per day, but only when no task has run since the daily
allowance reset (21:00 UTC). It never ends an Hour session, and it stops the
supervisor afterwards only if it started that supervisor itself.

```
npm run streak:register     # Windows scheduled task, daily at 21:00 local time
npm run streak:unregister
npm run streak              # run once now
```

It logs to `streak-keeper.log` in the repo and shows a Windows toast when it
fails (e.g. `needs_login`). The 21:00 schedule assumes a UTC+3 clock; edit
`scripts/register-streak-task.ps1` for another time zone.

## Credits

Terminal automation adapted from
[Praket7/freebuff-mcp](https://github.com/Praket7/freebuff-mcp) (MIT). Screen
rendering uses [@xterm/headless](https://www.npmjs.com/package/@xterm/headless)
(MIT), the xterm.js core build.
