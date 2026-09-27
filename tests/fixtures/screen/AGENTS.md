# Screen fixture corpus

Real freebuff screens, flattened, and the acceptance bar for every Screen
signature ([ADR-0002](../../../docs/adr/0002-tolerant-screen-signatures.md)).
`tests/corpus.test.ts` replays each file through the emulator and checks it
against a table keyed by file name. The files themselves are the record of
each screen's wording.

## Layout

- `<version>/`: one folder per freebuff CLI version. Folders accumulate; a
  capture never replaces another version's files. A folder simply lacks the
  screens never captured on that version. The Supervisor reads these folder
  names to decide `screenDrift`.
- `negative/`: hand-made frames a loosened signature must never recognize. The
  corpus test fails if one starts matching.
- `synthetic/`: hand-made emulator test vectors (split writes, repaints,
  scrollback). Not protocol captures.

A file's name names the screen it shows: `ready`, `continue`,
`picker-expanded` (Model picker), `error` (ready box showing a CLI error),
`single-instance` / `session-in-use` (the Session-in-use dialog in its
0.0.193 / 0.0.198+ wording). A new fixture needs that name and a row in the
corpus test's table.

Format: the flattened visible screen, trailing row padding trimmed, behind a
`\x1b[2J\x1b[H` clear+home prefix, so `flattenScreen([fixture])` reproduces
it. Tests replay with `\r\n` line endings, as the PTY emits them.

## Promote a Screen dump

When `screenDrift` is set, a dump under `<configDir>/screen-dumps/<version>/`
holds the drifted screen.

1. Copy the dump into `<version>/` here. Create the folder if the corpus lacks
   that version.
2. Rename it to the screen it shows, and add its row to the corpus test table.
3. If a Marker no longer matches, adjust `src/protocol/markers.ts` /
   `signatures.ts` until `npm test` passes on every version and every
   `negative/` frame.

The flag clears on the next `status`, with no restart.

## Capture

Captures come from the gated real smoke against the logged-in CLI, headless
in a 160x48 ConPTY, mirrored through the same emulator the Driver uses:

```
FREEBUFF_REAL_SMOKE=1 FREEBUFF_CAPTURE=1 npx vitest run tests/real-smoke.test.ts -t "captures the real protocol screens"
```

It writes into the folder of the installed CLI version (read from
`freebuff-metadata.json`), and refuses to write if that version is
unreadable. Raw PTY streams land in `.probe/capture/raw/` (gitignored).
**Review every capture for private data before committing.**

The run also covers:

- **Expanded picker**: presses `v`, waits for the full model list, and only
  then writes `picker-expanded.ansi`. It then runs the Pick rule against the
  real rows and fails if the choice is unaffordable.
- **Concurrent second spawn**: while one Instance holds an Hour session, a
  second spawn is watched for 120 s. It writes the Session-in-use dialog if
  one appears, and otherwise records
  `.probe/capture/raw/second-spawn-no-dialog.txt`.
- **Unknown-screen watch**: any stable frame no signature recognizes is dumped
  to `.probe/capture/unknown/` for review. Anything interesting there becomes a
  named fixture.

`FREEBUFF_LOW_CAPTURE=1` (test `captures the low-Freebucks screen`) captures
the exhausted-balance picker. It only writes on a day whose balance is already
below 5, because draining the balance means letting paid Hour sessions run
their full hour.

## What the fixtures can't show

- **Collapsed picker.** 0.0.193's picker was born expanded (four priced rows).
  0.0.199's is born collapsed to one `GLM 5.3 Flash` row with
  `↓  See all 5 models`, so `0.0.199/picker-expanded.ansi` is really collapsed.
  It predates the expanded-picker flow, and `classifyScreen` still reads it as
  the picker. On that wording the Pick rule lands on GLM and the deepseek
  affordability gate goes unexercised live; stub tests cover it with
  synthetic rows.
- **No pid record.** From 0.0.198 the CLI writes no
  `freebuff-instance-owner.json` or `freebuff.lock`. The Supervisor recovers
  with `Take over` and reads the Instance pid from its own PTY. A stale claim
  (Instance killed mid-session) also raises the dialog. A second spawn while
  the first sits at the picker shows none, and on 0.0.199 even a concurrent
  second spawn showed none.
- **`H · History`** (0.0.198+) is picker furniture, not a Marker. It also
  renders under the Session-in-use dialog.
- **Errors.** A failing shell command during a Turn is not reliably rendered
  as an error, because the model neutralizes it. `error.ansi` therefore holds
  the CLI's own `Command not found: "/…"` rendering.
- **Countdown near expiry** switches from `<n>m left` to `m:ss left` at exactly
  5:00 and repaints every second (seen in the 0.0.193 raw stream).
- **Git-root rebind.** Started in a subdirectory of a git repo, freebuff
  announces `You started Freebuff in a subdirectory of a git repo` and rebinds
  to the git root.
- **No low-Freebucks screen.** There is no low-Freebucks literal. The low
  state is the balance's left number (`0/25`, `0/40`) falling below a model's
  price, and no such fixture has been captured yet.
- **Fallback Enter unexercised live.** The 0.0.199 capture run produced no
  unknown dumps, so Fallback Enter has only been exercised by stub tests.
