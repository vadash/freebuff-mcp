# ADR-0002: Tolerant Screen signatures with an accumulating fixture corpus

- **Status:** Accepted (2026-09-26). Decided in issue #25; implemented by #26–#32.

## Context

The freebuff CLI ships roughly weekly, and each release rewords or reshuffles the
screens the Supervisor reads. Recognition rested on **exact literals** — often two
that both had to match (the Continue screen needs `Session ended` *and* the full
sentence `Press Enter to continue in a new session`) — so one reworded word turned a
known screen into an unknown one and cost a maintenance session per release.

That loop was expensive in four compounding ways:

- What counts as a "known screen" was written by hand in four places (classifier
  known-screen check, doctor's marker table, the capture harness's looser list, the
  fixtures README), and they disagreed.
- Recaptures were scheduled by version, not driven by evidence: on 0.0.199 both
  Continue Markers still matched, yet the gated live capture **replaced** the fixtures
  with near-identical re-records. Old captures survived only in git history.
- Drift was invisible: Screen dumps were write-only and doctor ran only when someone
  called it.

## Decision

Recognition becomes **tolerant and declared once**; the fixture corpus
**accumulates**; a recapture happens only when a **Drift signal** fires, never just
because a version shipped.

- Each known screen has one **Screen signature**: its Markers, each **strong**
  (specific to the screen) or **weak** (generic), a threshold (N of M, at least one
  strong), and the **region** of the Screen the Markers are searched in (bottom rows
  for the bottom-anchored screens, the whole Screen for the picker, login gate and
  connecting line). Markers match case-insensitively and whitespace-tolerantly.
- One table (`src/protocol/signatures.ts`) feeds every consumer — the classifier's
  recognition, the settle loop's known-screen check, doctor, and the capture
  harness's unknown-screen watch — so they can never disagree. A fixed priority
  resolves overlaps (Session-in-use dialog over picker, connecting over ready).
- Recognition is tolerant; **parsing stays strict** and fails safely: a reworded
  balance line can never make the pick rule unaffordable, a reworded Countdown means
  "time left unknown", never zero.
- The fixtures are a **corpus**: one folder per CLI version (0.0.193, 0.0.198,
  0.0.199 on file), plus negative fixtures a loosened signature must not match. Every
  signature must recognize its screen in every version on file. Fixing Drift mostly
  means promoting a Screen dump into the corpus.
- Doctor reports **pass** (every Marker present), **degraded** (threshold met, some
  Marker missing: Drift has started, the missing Markers are named) or **fail**
  (below threshold). Its output is the recognition function's output — it keeps no
  table of its own. The settle loop runs the same check on every settled screen, so
  Drift is caught without anyone calling `doctor` (see issue #30).

## Rejected alternatives

- **Exact literals with fixtures replaced on every version.** It is the status quo
  this ADR replaces. Every release rewords something eventually, so each release
  costs either a code change or a gated live recapture session; replacing fixtures
  destroys the history that proves a Marker change still recognizes older CLIs; and
  a single reworded word silently turns a known screen into an unknown one.
- **LLM-read screens.** Letting a model read the Screen and name the state absorbs
  any rewording, but it is nondeterministic where the pick rule needs a contract, it
  costs a model call per settle poll, and it moves the failure mode (misreading a
  screen) from a test failure to a wrong live action. A full screen redesign remains
  out of scope either way (issue #25, "Out of Scope").

## Consequences

- A release that only rewords part of a screen needs no code change: the screen
  reads as degraded, the missing Markers are named, and the fix is promoting a dump
  into the corpus.
- Thresholds, regions and strong/weak labels are tuned against the corpus; the
  corpus tests (`tests/corpus.test.ts`) are the acceptance bar, not numbers fixed
  here.
- A loosened signature that starts matching the wrong screen fails a corpus test
  (the negative fixtures) instead of misreading screens live.
- The Drift record is keyed by the **installed** CLI version (freebuff's metadata
  file — the same key the dump writer and the corpus folders use), not the banner
  would-be "running" version: real captured screens display no parseable version
  banner, so the installed version is the only version observable exactly when
  degraded and unknown frames must be recorded. The signal clears when an update
  changes the installed version, or when a dump is promoted into a corpus folder
  for the version.
- The corpus folder names are re-read live on every `status`, not once at startup:
  promoting a dump into the corpus clears the signal without a supervisor restart
  (user story 18).
