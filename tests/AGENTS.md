# Tests

Vitest picks up every `*.test.ts` / `*.test.mjs` here. Four tiers:

- **Pure**: modules tested through their exported functions, no processes:
  `screen`, `chatStore`, `workspace`, `supervisor-lock`, `doctor`, `capture`,
  `settle`, `streak-keeper` (its pure helpers only).
- **Corpus**: `corpus.test.ts` replays every Screen fixture through the
  emulator and signature table. See
  [fixtures/screen/AGENTS.md](fixtures/screen/AGENTS.md) before changing a
  fixture, Marker or signature.
- **Supervisor policy**: `supervisor-policy.test.ts` drives the real
  Supervisor in-process through `helpers/scriptedDriver.ts`, a `DriverLike`
  test adapter (the C4 seam), and `helpers/scriptedTurnRunner.ts`, a
  `TurnRunnerLike` adapter that dishes canned verdicts. Queue, purge, cancel,
  respawn and reply-ordering policies run with no timers and no processes.
  The Watchdog itself — freeze, deadline, crash, error log — is tested at the
  Turn seam in `turnRunner.test.ts`, on `helpers/virtualClock.ts`.
- **Stub e2e**: `driver`, `server`, and the `supervisor` daemon smoke run the
  real processes against `stub-freebuff.mjs`, a protocol-faithful fake of the
  freebuff TUI. `helpers/harness.ts` starts a Supervisor or MCP server on a
  unique pipe per test. The stub's header comment lists every
  `FREEBUFF_STUB_*` knob.

The stub copies the marker strings on purpose, so the driver under test is
the only side that imports `src/protocol`. When a Marker's wording changes,
update the stub's copy too. The stub replays the captured Welcome screen and
Continue fixtures verbatim, so those two can't drift.

## Real smoke

`real-smoke.test.ts` drives the live, signed-in freebuff CLI. It is skipped
unless `FREEBUFF_REAL_SMOKE=1`:

```
FREEBUFF_REAL_SMOKE=1 npx vitest run tests/real-smoke.test.ts
```

It spends real Hour-session time and Freebucks. It runs its own Supervisor on
a unique pipe, so it uses its own Workspace, and freebuff allows one session at
a time: let your everyday supervisor's work finish first. Its capture variants
(`FREEBUFF_CAPTURE=1`) write fixtures; see
[fixtures/screen/AGENTS.md](fixtures/screen/AGENTS.md#capture).
