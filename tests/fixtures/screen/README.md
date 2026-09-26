# Screen fixture corpus

One folder per CLI version, so fixtures accumulate instead of being replaced on every
recapture; a version folder simply lacks the screens never captured on it.

- `0.0.193/` — freebuff 0.0.193 (win32-x64, npm wrapper), captured 2026-09-24 by the
  issue #9 capture run; restored from git history (commit `8e94913`) when the corpus
  became per-version (issue #27)
- `0.0.198/` — the Session-in-use dialog, captured on freebuff 0.0.198 after a SIGKILL
- `0.0.199/` — freebuff 0.0.199 (win32-x64), captured 2026-09-26 by the issue #24 refresh run
- `negative/` — hand-made frames a loosened signature must never recognize (most match
  NO known screen; two are ready frames that must never read as Continue, issue #28)
- `synthetic/` — hand-made emulator test vectors, not protocol captures

The stub freebuff (`tests/stub-freebuff.mjs`) replays `0.0.199/picker-expanded.ansi` and
`0.0.199/continue.ansi` verbatim (with env-overridable balance numbers and picker rows),
so the stub cannot drift from the real wording. `tests/corpus.test.ts` replays every
fixture through the emulator, table-driven over file names.

## Naming rule

A fixture's file name names the screen it shows: `continue.ansi` the Continue screen,
`ready.ansi` ready, `picker-expanded.ansi` the Model picker, `single-instance.ansi` /
`session-in-use.ansi` the Session-in-use dialog in its 0.0.193 / 0.0.198 wording,
`error.ansi` the ready box showing the CLI's error rendering. The corpus test maps each
name to the recognition it must produce, so a new fixture needs a name and a table entry.

## Capture and replay

Real captures come from the gated real smoke against the logged-in CLI, headless in a
160x48 ConPTY, mirrored through the same `@xterm/headless` emulator the driver uses:

`FREEBUFF_REAL_SMOKE=1 FREEBUFF_CAPTURE=1 npx vitest run tests/real-smoke.test.ts -t "captures the real protocol screens"`

It writes into the captured version's folder (issue #32 generalizes that to the running
CLI's own folder). Each fixture is the flattened visible screen (trailing row padding
trimmed) behind a `\x1b[2J\x1b[H` clear+home prefix, so `flattenScreen([fixture])`
reproduces the screen; tests replay with `\r\n` line endings, as the PTY emits them. Raw
PTY streams land in `.probe/capture/raw/` (gitignored); review captures for private data
before committing.

## 0.0.193

### picker-expanded.ansi

Born expanded with four rows — `GLM 5.3 Flash` 0, `MiMo 2.6 Flash` 0, `Solar Mini 4` 0,
`DeepSeek V4.1 Flash` 5 (plus `May use data for AI training`, `Get 7x usage for $5 →`) —
and no `H · History` hint row. Those prices still matter: the pick rule (ADR-0001 §6) and
`FREEBUFF_STUB_PICKER` rows reference them. The name keeps its `expanded` suffix; the
0.0.199 capture below is born collapsed.

### ready.ansi

Ready input box with the Hour-session status line, captured after a Turn finished; here
`Solar Mini 4 · 1h left · 12.9K (3%)` with `✕ End session` on the right. Countdown
wording and formats as on 0.0.199 (below).

### continue.ansi

`Session ended  ·  20 Freebucks left` centered in the top border of a box over the frozen
transcript, `Press Enter to continue in a new session`, `Change model   Esc` button. The
`20 Freebucks left` band is the `FREEBUCKS_LEFT_REGEX` wording; 0.0.199 dropped the
balance. The 0.0.193 capture run's raw stream (local scratch only, never committed)
showed the Countdown on the way to expiry: `1h 1m left`, `59m left`, `9m left`, `1m left`,
then `m:ss left` from exactly 5:00 down, repainting every second — the `COUNTDOWN_REGEX`
wording.

### error.ansi

`Command not found: "/definitely-not-a-freebuff-command"` above the ready box (same
rendering as 0.0.199, below).

### single-instance.ansi

The Session-in-use dialog's 0.0.193 wording: `Freebuff is already running` /
`Only one freebuff instance is allowed at a time.`, buttons `Take over` and `Exit`.
`mentionsSingleInstance` covers both wordings. A second spawn while the first Instance
merely sits at the picker (no Hour session) does NOT show this dialog; the dialog can also
appear with a STALE lock file (Instance killed mid-session), so `Take over` is the
recovery path after verifying any recorded pid is dead.

## 0.0.198

### session-in-use.ansi

The same dialog as reworded by freebuff 0.0.198 (2026-09 update), captured after SIGKILL
of a mid-session Instance:

- `Session already in use`
- `Limited access without a subscription allows one session across CLI and Desktop.`
- Buttons: `Take over` and `Choose model`; hint `H · History`

0.0.198+ writes NO pid record to `~/.config/manicode` (no
`freebuff-instance-owner.json`, no `freebuff.lock`); the supervisor must recover via
`Take over` and read the Instance pid from its own PTY.

## 0.0.199

### picker-expanded.ansi

Born COLLAPSED (verified on 0.0.199): a single `GLM 5.3 Flash` box
(`Deep reasoning · Reasoning: max · Images · NEW`) priced `0 Freebucks/hr`, cursor `›` on
it (the remembered model), `↓  See all 5 models` below. `classifyScreen` still reads the
title-plus-rows as `expanded` — the recognition is heuristic, not a layout claim. No real
expanded 0.0.199 capture exists; the capture flow does not expand the picker.

Exact strings the protocol depends on:

- Title: `Start coding for free` (plus `7 day streak  ●●●●●●●` streak badge)
- Price format: `<n> Freebucks/hr`; balance format
  `FREE · 25/25 Freebucks daily · resets in 19h 50m · 15 in wallet`
  (`<plan> · <left>/<daily> Freebucks daily · resets in <h>h <m>m[ · <n> in wallet]`;
  0.0.199 added the wallet suffix). The daily allowance is not hardcoded — 25 some days,
  40 others; an exhausted day shows `0/25` or `0/40`.
- Streak-perk line: `🎁 Streak perk: +15 Freebucks every Pacific day`
- Hint row: `H · History` above the bottom border (added by the 0.0.198 update; picker
  furniture, not a picker Marker — it also renders under the Session-in-use dialog, so
  it must never recognize the picker)
- `✦ Refer friends → earn Freebucks:` / `⎘ Copy invite link  Open Earn ↵`

### ready.ansi

- Input box placeholder: `Enter a coding task or / for commands` (focused cursor `▍` before it)
- Status line: `GLM 5.3 Flash · 58m left · 12.8K (1%)`, `✕ End session` on the right
- Countdown formats: `<n>m left` (minutes), `1h left` (hour), `2:58 left` (mm:ss near
  expiry); during a Turn: `working · 3s · ■ Esc` (no countdown)
- Transcript meta after an answer: `⎘ • 4s • △▽`; prompt echoes render as `[04:12 AM] <prompt> ⎘`

Notes: this capture also shows a real startup notice — freebuff started in a subdirectory
of a git repo announces `You started Freebuff in a subdirectory of a git repo.` /
`Switch to git root (<path>)` and rebinds itself to the git root. Anything comparing the
Screen against the Bound directory must expect the git root, not the spawn cwd.

### continue.ansi

Boxed banner over the frozen transcript; `Session ended` embedded in the box border;
`Press Enter to continue in a new session`; `Change model   Esc` button (boxed, right
side). NO remaining balance is shown anymore, so `FREEBUCKS_LEFT_REGEX` is not a
Continue Marker. Enter starts a fresh Hour session; Esc reopens the model picker. The
supervisor confirms this screen lazily, only when the next task arrives.

### error.ansi

CLI error rendering for an unknown slash command, captured while an Hour session runs:
`Command not found: "/definitely-not-a-freebuff-command"`. Red in the live TUI; the
flattened fixture keeps the wording. A failing shell command during a Turn is NOT
reliably rendered as an error — the model neutralizes it — so this deterministic
CLI-level error is the captured specimen.

## negative/

Hand-made frames a signature loosened too far must NEVER recognize (`tests/corpus.test.ts`
fails if one starts matching):

- `ad-panel.ansi` — the picker's referral panel alone (`Refer friends`, `Copy invite
  link`): picker furniture, not a known screen.
- `generic-words.ansi` — `Esc`, `↵ Enter  select`, `H · History` with no strong Marker:
  generic words never recognize a screen by themselves.
- `continue-wording-answer.ansi` — a ready Screen whose Answer carries the Continue
  wording (`Session ended`, `Press Enter to continue in a new session`): the wording
  rides in the transcript, above the Continue signature's bottom-rows region, so the
  frame stays ready, never Continue (issue #28).
- `mid-turn-esc.ansi` — a ready Screen mid-Turn (`working · 3s · ■ Esc`, no Countdown
  line): recognized as the degraded ready it is, never Continue (issue #28).

## synthetic/

Hand-made emulator test vectors for split writes, repaints and scrollback behavior:
`banner-ready` (directory banner on ready), `connecting`, `connecting-to-ready`
(cursor-up rewrite erases Connecting), `dialog-over-picker` (the Session-in-use dialog
wording and buttons over a full Model picker — the fixed priority must read the dialog,
issue #28), `login-required`, `partial-line` (a line completed across writes), `repaint`
(the last repaint wins), `split-escape` (escape sequence split mid-sequence).

## low-freebucks.ansi — deliberately absent

The exhausted-balance state could not be reached programmatically: ending a seconds-old
DeepSeek session deducts nothing, so draining means letting paid sessions run their full
hour. There is NO low-Freebucks literal in `markers.ts`; the low state is the captured
balance format showing a left number (`0/25`, `0/40`) below a model's price. The opt-in
variant (`FREEBUFF_REAL_SMOKE=1 FREEBUFF_CAPTURE=1 FREEBUFF_LOW_CAPTURE=1 npx vitest run
tests/real-smoke.test.ts -t "captures the low-Freebucks screen"`) expands the collapsed
picker, picks DeepSeek (5 Freebucks/hr), ends the session and re-reads the balance until
it is exhausted, then captures the unaffordable rendering (and, if the paid row is still
selectable, `low-freebucks-refused.ansi`). Run it on a day real work has spent the balance
below 5; it refuses to write a fixture at any other balance. The TUI may also hide or
disable the unaffordable row instead of refusing a pick.

## Promoting a Screen dump into the corpus

Screen dumps land in `<configDir>/screen-dumps/<version>/<freeze-key-hash>.ansi`
(write-only; degraded and unrecognized frames, deduplicated per Freeze key). While a
dump is on record for the running version and the corpus lacks that version's folder,
`status` reports `screenDrift: true` — promoting the dump here is what clears the
signal (and a version the corpus covers never raises it). Promotion is deliberate and
reviewed: copy the dump into the running version's folder here, rename it to the screen
it shows, add its exact strings to this README, and let `tests/corpus.test.ts` confirm
it is recognized.

## chat-store location

The CLI writes chat logs under
`~/.config/manicode/projects/<cwd basename>/chats/<timestamp>/log.jsonl` (ack line
mentioning the prompt, then turn end with `data.fullResponse`); re-verified on the 0.0.199
capture run. `~/.freebuff` holds per-project state for older builds.

## unknown screens

While a capture flow runs, a watchdog classifies the emulated screen every couple of
seconds; any stable frame matching no known pattern (picker, ready box, countdown,
continue screen, Session-in-use dialog, login gate, ad panel, turn end, transition blanks)
is dumped to `.probe/capture/unknown/unknown-<hash>.ansi` (flattened, replayable) plus
`.raw.ansi` (the full raw byte stream up to that point). Review the dumps after a run —
anything interesting becomes a named fixture or a new marker; the directory is gitignored
scratch.

The 0.0.199 capture run (2026-09-26) produced NO unknown dumps and the Driver's own dump
path stayed empty: every settle frame matched a known class, so the issue #23 fallback was
never exercised live — its cadence is covered by the stub tests (`driver.test.ts`,
`supervisor.test.ts`).
