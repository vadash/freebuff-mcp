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

A file's name names the screen it shows: `ready`, `continue`, `welcome`
(Welcome screen), `error` (ready box showing a CLI error),
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

- **Welcome or resumed ready**: the boot screen is saved as `welcome` (no Hour
  session) or `ready` (an unexpired session resumed after a kill), by the
  Countdown's presence.
- **Unknown-screen watch**: any stable frame no signature recognizes is dumped
  to `.probe/capture/unknown/` for review. Anything interesting there becomes a
  named fixture.
- **Expiry**: after a real Hour, `countdown-expiring` (the mm:ss Countdown of
  the last five minutes) and `welcome-expired` — the 0.1.0 post-expiry look:
  Countdown gone, box back to `Your first message starts the session`, transcript
  intact. It must recognize as the Welcome screen; the Supervisor submits the
  next task straight into it. The wait costs the rest of the hour.

## What the fixtures can't show

- **No model picker.** From 0.1.0 the CLI opens on the Welcome screen and the
  first message starts the session (ADR-0004). The pick rule, the picker
  fixtures, and the low-Freebucks capture are gone; `0.0.193`/`0.0.199`
  `picker-expanded.ansi` fixtures were pruned when the picker recognition was.
- **No pid record.** From 0.0.198 the CLI writes no
  `freebuff-instance-owner.json` or `freebuff.lock`. The Supervisor recovers
  with `Take over` and reads the Instance pid from its own PTY.
- **No Session-in-use dialog from 0.1.0.** A concurrent second spawn now takes
  the Hour session over silently: the first Instance's Countdown vanishes and
  its box reverts to the Welcome wording. The `single-instance` /
  `session-in-use` fixtures are older-generation captures; the dialog Markers
  stay for them.
- **No Continue screen at plain expiry.** With balance remaining, 0.1.0 expiry
  just reverts to the Welcome look (captured as `welcome-expired`). The
  `Press Enter to continue` dialog is the out-of-credits claim check — it
  cannot be captured while the balance lasts, so `continue.ansi` stays a
  0.0.193/0.0.199 fixture and the expire-mode tests replay those.
- **Errors.** A failing shell command during a Turn is not reliably rendered
  as an error, because the model neutralizes it. `error.ansi` therefore holds
  the CLI's own `Command not found: "/…"` rendering.
- **Countdown near expiry** switches from `<n>m left` to `m:ss left` at exactly
  5:00 and repaints every second.
- **Git-root rebind.** Started in a subdirectory of a git repo, freebuff
  announces `You started Freebuff in a subdirectory of a git repo` and rebinds
  to the git root.
- **Fallback Enter unexercised live.** The 0.1.0 capture run produced no
  unknown dumps, so Fallback Enter has only been exercised by stub tests.
