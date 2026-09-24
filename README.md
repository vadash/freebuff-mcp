# freebuff-supervisor

An MCP server that lets a coding harness (Claude Code, etc.) hand tasks to the
freebuff CLI and get the final answer
back. freebuff has no API or headless mode, so a long-lived supervisor drives
one freebuff instance in a pseudo-terminal, reads its rendered screen for
state, and reads its on-disk chat log for the answer.

The repository is named `freebuff-mcp` after the upstream project it adapts;
the package and MCP server are named `freebuff-supervisor` because
`freebuff-mcp` is taken.

- Design and its reasons: [ADR-0001](docs/adr/0001-supervised-freebuff-cli.md)
- Vocabulary (Instance, Hour session, Bound directory, ...): [CONTEXT.md](CONTEXT.md)

> This README describes the code as it is today. Where ADR-0001 decides
> something different, see [Known issues](#known-issues).

## Prerequisites

- **Windows.** The supervisor uses a named pipe and ConPTY.
- **Node.js 22.6 or newer.** Sources run directly via
  `--experimental-strip-types`; there is no build step.
- **The freebuff CLI** on `PATH`, signed in once with `freebuff login`.

## Configure

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

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `bind` | `dir` | Binds freebuff to an existing directory and spawns the Instance in it. Refused while a task runs; purges queued tasks. Same directory is a no-op. The Bind lock refuses a switch while more than 30 minutes of the Hour session remain. |
| `run_prompt` | `dir`, `prompt` | Queues the prompt and waits for freebuff's final answer. `dir` must equal the bound directory. Prompts over 64 KB are written to a file in that directory and passed by reference. |
| `cancel_task` | none | Stops the active task by stopping freebuff; the next queued task then runs. |
| `new_session` | none | Starts a fresh conversation. Refused while a task is active or queued. |
| `status` | none | JSON with the fields below. |
| `doctor` | none | Checks the protocol markers against committed fixtures; returns `{ ok, failures }`. |

`status` fields:

| Field | Meaning |
|---|---|
| `state` | `stopped`, `spawning`, `picker`, `ready` or `busy` |
| `boundDir` | Bound directory, or `null` |
| `queueDepth` | Tasks waiting behind the active one (max 4) |
| `activeModel` | Model observed on the ready Screen status line; `null` while no model shows (e.g. at the Model picker) |
| `hourSessionMinutesLeft` | Minutes left in the Hour session, from the screen countdown |
| `freebucksDaily` | Freebucks line from the screen, as text |
| `needsLogin` | freebuff demands `freebuff login` |
| `updatePending` | A newer freebuff CLI is installed than the one running |

### Failures

Failed calls return `isError: true` with a message. Driver failures read
`freebuff driver failure: <reason>`; bind rejections read `bind rejected: <reason>`:

| Reason | Meaning |
|---|---|
| `needs_login` | Run `freebuff login` yourself; never retried automatically. |
| `dir_mismatch` | freebuff came up in a different directory than the bound one. |
| `ready_timeout` | freebuff never reached its input box (includes a screen excerpt). |
| `ack_missing` | freebuff did not record the prompt, even after one retry. |
| `process_exited` | freebuff exited; the watchdog respawns it and resends the prompt, up to 2 times. |
| `bound_dir_locked` | Switching to a different directory is refused while more than 30 minutes of the Hour session remain. The message carries the Bound directory and the minutes until it unlocks. The escape hatch is restarting the supervisor (the Bound directory is not persisted). Re-binding the same directory is a no-op; with no Hour session running, or 30 minutes or less left, switching is allowed. |

A full queue returns `{ "busy": true, "position": N }`, currently not flagged
as an error.

## How freebuff's usage works

- An **Hour session** starts when a model is picked at freebuff's model picker.
  It runs for one wall-clock hour whatever happens, is locked to the directory
  freebuff started in, and resumes if freebuff is relaunched there.
- Starting one costs **Freebucks** from a daily allowance (25 or 40); prices
  vary by model (e.g. 0/5/10). When a task arrives at the picker, the
  supervisor picks, in order: the first model whose name contains `deepseek`
  (case-insensitive) that the balance can afford, else the first containing
  `glm`, else the first containing `mimo`, else the top row.
- So this tool is economical only when you work in **one directory**: rebinding
  elsewhere starts a new Hour session while the old one keeps ticking.

## Known issues

Tracked against ADR-0001; fixes are being planned.

- **Multi-line prompts may submit early.** Prompts are typed as raw text, not
  as a bracketed paste.
- **Freeze detection is weak.** A task counts as frozen only after 10 minutes
  with no screen or chat-log change, and the on-screen countdown may keep it
  from ever firing. The 20-minute task timeout restarts on each respawn, and
  a respawn resends the prompt.
- **`doctor` does not look at the live screen.** It only compares the code's
  constants with committed fixtures, so it cannot detect a freebuff update.

## Real smoke test

`tests/real-smoke.test.ts` drives a live, signed-in freebuff CLI and consumes
Hour-session time. It is skipped by default; opt in with:

```
FREEBUFF_REAL_SMOKE=1 npx vitest run tests/real-smoke.test.ts
```

## Develop

```
npm install
npm test
npm run typecheck
```

`scripts/flashwatch.ps1` runs a command and reports every console window it
flashes on the desktop, with the process chain behind each (`-Trace` also logs
every process it starts). `npm test` should flash none:

```
pwsh -NoProfile -File scripts/flashwatch.ps1 npm test
```

## Credits

Terminal automation adapted from
[Praket7/freebuff-mcp](https://github.com/Praket7/freebuff-mcp) (MIT). Screen
rendering uses [@xterm/headless](https://www.npmjs.com/package/@xterm/headless)
(MIT), the xterm.js core build.
