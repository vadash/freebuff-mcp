# Real screen fixtures

These fixtures are captured from the real freebuff CLI, not written by hand. They back
`src/protocol/markers.ts` and the screen-classification tests. The stub freebuff
(`tests/stub-freebuff.mjs`) replays `picker-expanded.ansi` and `continue.ansi` verbatim
(with env-overridable balance numbers and picker rows), so the stub cannot drift from the
real wording; its ready-box status line uses the captured Countdown formats with an env
control for the minutes.

`banner-ready`, `connecting*`, `login-required`, `partial-line`, `repaint` and
`split-escape` are NOT protocol captures: they are hand-made emulator test vectors for
split writes, repaints and scrollback behavior. Every wording-bearing fixture below is a
real capture.

- CLI: freebuff 0.0.193 (win32-x64, npm wrapper `freebuff@0.0.193`)
- Captured: 2026-09-24 by the gated real smoke's capture mode
- How: `FREEBUFF_REAL_SMOKE=1 FREEBUFF_CAPTURE=1 npx vitest run tests/real-smoke.test.ts -t "captures the real protocol screens"`
  against the logged-in CLI, headless in a 160x48 ConPTY, mirrored through the same
  `@xterm/headless` emulator the driver uses. Each fixture is the flattened visible screen
  (trailing row padding trimmed) behind a `\x1b[2J\x1b[H` clear+home prefix, so
  `flattenScreen([fixture])` reproduces the screen. Raw PTY streams land in
  `.probe/capture/raw/` (gitignored) for human review; review captures for private data
  before committing.

## picker-expanded.ansi

Model picker, born expanded after connect. No Hour session starts until a model is picked.

Exact strings the protocol depends on:

- Title: `Start coding for free` (plus `6 day streak  ●●●●●●○` streak badge)
- Picker rows (name, then a price line):
  - `GLM 5.3 Flash` — `0 Freebucks/hr`
  - `MiMo 2.6 Flash` — `0 Freebucks/hr`
  - `Solar Mini 4` — `0 Freebucks/hr`
  - `DeepSeek V4.1 Flash` — `5 Freebucks/hr` (plus `May use data for AI training`, `Get 7x usage for $5 →`)
- Price format: `<n> Freebucks/hr`
- Balance format: `FREE · 20/25 Freebucks daily · resets in 9h 12m`
  (`<plan> · <left>/<daily> Freebucks daily · resets in <h>h <m>m`). The daily allowance is
  not hardcoded — 25 some days, 40 others; an exhausted day shows `0/25` or `0/40`.
- Cursor: the highlighted row is prefixed `›` in the flattened text
- Expanded state ends in `↑  Show fewer`

Note: this is the 0.0.193 capture. The 0.0.198 update added a `H · History` hint row
above the bottom border (visible under the dialog in `session-in-use.ansi`);
`doctor` expects it on the Model picker (issue #22) until the capture refresh (slice 5)
replaces this fixture.

Notes: the picker is expanded on arrival for a profile that has submitted a prompt before;
no keyboard path to a collapsed "See all N models" state was found, so there is no real
collapsed capture. The remembered model holds the cursor, not necessarily the top row.

## ready.ansi

Ready input box with the Hour-session status line, captured after a Turn finished.

- Input box placeholder: `Enter a coding task or / for commands` (focused cursor rendered as `▍` before it)
- Status line: `Solar Mini 4 · 1h left · 12.9K (3%)` with `✕ End session` on the right
- Countdown formats: `<n>m left` (minutes), `1h left` (hour), `2:58 left` (mm:ss near expiry)
- During a Turn the status line reads `working · 3s · ■ Esc` (no countdown)
- Transcript meta after an answer: `⎘ • 5s • △▽`; prompt echoes render as `[02:27 PM] <prompt> ⎘`

Notes: this capture also shows a real startup notice — when freebuff is started in a
subdirectory of a git repo it announces
`You started Freebuff in a subdirectory of a git repo.` / `Switch to git root (<path>)`
and rebinds itself to the git root. Anything comparing the Screen against the Bound
directory must expect the git root, not the spawn cwd.

## single-instance.ansi

Dialog shown by a second Instance spawned while one holds an Hour session.

- `Freebuff is already running`
- `Only one freebuff instance is allowed at a time.`
- Buttons: `Take over` and `Exit`

Notes: a second spawn while the first Instance merely sits at the picker (no session) does
NOT show this dialog — the lock (`freebuff-instance-owner.json` in `~/.config/manicode`,
pid-checked) only belongs to an Instance running an Hour session. The dialog can also
appear with a STALE lock file (Instance killed mid-session, dead pid left behind): the CLI
raised it both at spawn and at session start, so the supervisor must treat `Take over` as
the recovery path after verifying the recorded pid is dead.

## session-in-use.ansi

The same dialog as reworded by freebuff 0.0.198 (2026-09 update), captured after SIGKILL
of a mid-session Instance.

- `Session already in use`
- `Limited access without a subscription allows one session across CLI and Desktop.`
- Buttons: `Take over` and `Choose model`; hint `H · History`

Notes: 0.0.198 writes NO pid record to `~/.config/manicode` (no
`freebuff-instance-owner.json`, no `freebuff.lock`); the supervisor must recover via the
dialog's `Take over` and read the Instance pid from its own PTY.

## error.ansi

CLI error rendering for an unknown slash command, captured while an Hour session runs.

- Exact string: `Command not found: "/definitely-not-a-freebuff-command"`

Notes: red in the live TUI; the flattened fixture keeps the wording. A failing shell
command during a Turn is NOT reliably rendered as an error — the model neutralizes it
(`cmd /c exit 42; echo "exit code: $?"` renders as a normal `$` command block), so this
deterministic CLI-level error is the captured specimen.

## continue.ansi

The screen after the Hour session expires.

- Header band: `Session ended  ·  20 Freebucks left` (double space around `·`; the number is
  the remaining daily balance at expiry, here lowered by a prior paid pick)
- `Press Enter to continue in a new session`
- `Change model   Esc` (button, boxed)

Notes: pressing Enter starts a fresh Hour session; Esc reopens the model picker. The
supervisor confirms this screen lazily, only when the next task arrives. Countdown formats
seen in the raw stream (`continue.raw.ansi`) on the way to expiry: `1h 1m left`, `59m left`,
`9m left`, `1m left`, then `m:ss left` from exactly 5:00 down, repainting every second —
too fast for the capture helper's 1.5s stability window, so no separate
`countdown-expiring.ansi` exists; the formats above are now the `COUNTDOWN_REGEX` wording
in `src/protocol/markers.ts`.

## low-freebucks.ansi

Not committed: the exhausted-balance state could not be reached programmatically. There is
therefore NO low-Freebucks literal in `markers.ts`: the low state is the captured balance
format showing a left number (`0/25`, `0/40`) below a model's price, not a separate screen
string. The opt-in drain variant
(`FREEBUFF_REAL_SMOKE=1 FREEBUFF_CAPTURE=1 FREEBUFF_LOW_CAPTURE=1 npx vitest run tests/real-smoke.test.ts -t "captures the low-Freebucks screen"`)
is ready and does: pick DeepSeek (5 Freebucks/hr) → wait for the session status line →
click the `✕ End session` status-bar button → re-read the balance — repeated while the
parsed balance covers the price, then it captures the picker as it renders the
unaffordable state (and, if the paid row is still selectable, `low-freebucks-refused.ansi`
with whatever refusing rendering appears). 0.0.193 has no slash command for ending a
session: `/end-session` (v0.0.188 era) no longer ends anything, it just opens a new chat.
Verified against the live CLI on 2026-09-24: a DeepSeek session started and ended seconds
later deducts NOTHING (balance stayed 20/25), so draining programmatically would mean
letting paid sessions run their full hour. Run the variant on a day when real work has
spent the balance below 5 (`0/25` or `0/40`); it refuses to write a fixture at any other
balance. The TUI may also hide or disable the unaffordable row instead of refusing a pick.

## chat-store location

The 0.0.193 CLI writes chat logs under `~/.config/manicode/projects/<cwd basename>/chats/<timestamp>/log.jsonl`
(ack line mentioning the prompt, then turn end with `data.fullResponse`). `~/.freebuff`
holds per-project state for older builds.

## unknown screens

While a capture flow runs, a watchdog classifies the emulated screen every couple of
seconds; any stable frame matching no known pattern (picker, ready box, countdown,
continue screen, single-instance dialog, login gate, ad panel, turn end, transition
blanks) is dumped to `.probe/capture/unknown/unknown-<hash>.ansi` (flattened, replayable)
plus `.raw.ansi` (the full raw byte stream up to that point). Review the dumps after a run
— anything interesting becomes a named fixture or a new marker; the directory is
gitignored scratch.
