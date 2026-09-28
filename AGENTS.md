# freebuff-supervisor: agent guide

What the tool does and its user contract (tools, `status` fields, failure
reasons): [README.md](README.md). Domain terms: [CONTEXT.md](CONTEXT.md); use
them exactly. Decisions and their reasons: [docs/adr/](docs/adr/); read the ones
touching your area before changing it.

## Code map

```
MCP client (harness)
   │ stdio
   ▼
src/server.ts        MCP server: stateless proxy; starts the Supervisor on demand
   │ named pipe \\.\pipe\freebuff-supervisor   (src/ipc.ts)
   ▼
src/supervisor.ts    Supervisor: Queue, Watchdog, state machine, status flags
   │                   src/supervisorLock.ts  one Supervisor per pipe name
   │                   src/workspace.ts       Workspace dir, Junction, prompt preamble
   ▼
src/driver.ts        Driver: spawn, keystrokes, PTY adapter for the settle loop
   │                   src/settle.ts          Settle loop: settled-screen wait, Enter throttle, dump-on-drift
   │ ConPTY (node-pty)
   ▼
freebuff.exe         Instance
   ├─► Screen      src/protocol/screen.ts      @xterm/headless render, classifyScreen, freezeKey
   │                 src/protocol/signatures.ts  Screen signatures: the one recognition table
   │                 src/protocol/markers.ts     every Marker: screen/chat patterns, keys, records
   │                 src/protocol/screenDump.ts  Screen dumps; installed CLI version
   │                 src/protocol/corpus.ts      corpus versions, for the screenDrift flag
   └─► Chat store  src/protocol/chatStore.ts   Ack, Turn end, Answer; DEFAULT_CONFIG_DIR + readChats
```

`src/config.ts` holds every timing and limit. `scripts/streak-keeper.mjs` is
the Streak keeper, a pipe client outside the MCP path.

## Where each fact lives

Each fact has one owner. Edit the owner and link to it from anywhere else:

| Kind of fact | Owner |
|---|---|
| User contract: install, tools, `status` fields, failure reasons | `README.md` |
| What a domain word means, Supervisor states | `CONTEXT.md` (no file paths or symbols) |
| Why a decision was made | `docs/adr/`. Frozen once accepted; only `status:` changes |
| How to do a maintenance procedure | the nearest nested `AGENTS.md` |
| How the code works | a comment beside the code |
| Wording of a freebuff screen | the fixture file itself, plus `src/protocol/markers.ts` |

## Checks

`npm test` and `npm run typecheck` must pass. `npm test` must also flash no
console window. Check that with
`pwsh -NoProfile -File scripts/flashwatch.ps1 npm test`, which lists every
flashed window with its process chain (`-Trace` logs every process started).

## Go deeper

- **Tests**: before adding a test, touching the stub freebuff, or running the
  live CLI, read [tests/AGENTS.md](tests/AGENTS.md).
- **Screens**: when freebuff changes its wording, `screenDrift` is set, or you
  change a Marker, signature or fixture, read
  [tests/fixtures/screen/AGENTS.md](tests/fixtures/screen/AGENTS.md).

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `vadash/freebuff-mcp`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: five canonical roles, label string equals role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.
