---
status: accepted (2026-09-27)
---

# ADR-0003: Workspace junction replaces bind

- **Supersedes:** ADR-0001 §4's "`bind` spawns the Instance straight away" and
  all of §5 (One Bound directory, with a Bind lock).

## Context

The Bind lock made switching directories clunky: `bind` to another directory
was refused while more than 30 minutes of the Hour session remained (escape
hatch: restart the supervisor), and every real switch respawned the Instance at
the Model picker — stranding the old session's remainder and starting a fresh
Hour session, costing Freebucks. A spike (2026-09-27) proved the alternative:
freebuff works unmodified through a Windows junction, and the supervisor's
banner check only needed tilde expansion (freebuff prints `~\…` for directories
under the user profile).

## Decision

- The Instance always runs in one **Workspace** per pipe name
  (`%TEMP%\freebuff-ws-<sha1(pipe)[:8]>`), stable across restarts, so the Hour
  session locks there permanently and a repo switch never restarts it.
- The caller's repo is mounted at `<workspace>/repo`, a Windows junction (no
  admin rights). `run_prompt.dir` names the real repo; when it changes, the
  supervisor swaps the junction while no task is active and purges the queue.
  The `bind` op and tool, `bound_dir_locked`, and the 30-minute grace are
  deleted. The Instance spawns lazily on the first task.
- Every submitted prompt gets a fixed preamble ("Work inside the repo/ folder
  in the current directory.") so callers write prompts as if the repo were the
  cwd.

### Considered options

- Keep `bind` as an explicit target-setter: a two-step ritual with no benefit
  left once switching is free.
- Caller-side `repo/` prefix convention: every prompt, forever, carries the
  leak instead of one constant preamble.

### Safety

A caller may pass anything as `dir`, including `C:\`. Therefore: filesystem
roots, the Workspace itself, and its ancestors are refused as targets (a
junction loop); the junction is removed only after `lstat` proves it is a link,
never recursively; a real directory named `repo` fails loudly instead of being
deleted. No `rm -rf` can reach the target through the link.

## Consequences

- One Hour session is shared by all repos: switching is free, but the clock is
  serial and keeps ticking while idle (as before).
- The chat-store key becomes the Workspace basename for every repo: one shared
  chat history, and Screen dumps dedupe under one dir line.
- The Workspace lives in `%TEMP%`: disk cleanup may delete it; the next task
  recreates it identically, so the Hour session still resumes.
- `needs_login`, CLI updates, and bad directories surface at the first task
  instead of at bind time.
