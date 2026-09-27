# 0005 - supervisor code-identity takeover

Date: 2026-09-28
Status: accepted

## Context

The Supervisor outlives MCP reloads (ADR-0001 #1), and the MCP server trusts
whatever holds the supervisor pipe. After a code update, a reload therefore
kept serving the old daemon's logic behind the same pipe: status fields
contradicted the new CLI's screens, and nothing flagged the mismatch. The only
recovery was finding and killing the stale process by hand.

The pid lock behind the pipe knew nothing about code. A lock record was a bare
pid; a second start exited regardless of what code the holder ran.

## Decision

The lock record carries the holder's code fingerprint — a content hash of the
supervisor's `src/` tree, computed at startup.

- Same fingerprint: the second start exits (the singleton guarantee, unchanged).
- Different fingerprint (or a legacy bare-pid record): the holder predates the
  new code, and the fresh start replaces it — `shutdown` over the pipe first,
  force-kill if it will not leave within a few seconds.

Replacing a busy daemon kills its running Turn. That is accepted: updates are
deliberate, the failed call is visible to the caller, and a Turn can be
re-run — while silent stale-code service is invisible and wrong.

## Consequences

- After every code update, the next supervisor start swaps the daemon; no
  manual process hunting. The MCP server drives this: each request's
  `ensureStarted` compares its fingerprint with the daemon's `status` reply and
  spawns a replacement on mismatch.
- The duplicate-pipe probe runs only after the lock, and never on the takeover
  path: the stale daemon's socket is still open during its shutdown window, so
  a reachability check would misread the replacement as the duplicate.
- During development, each src/ edit rotates the fingerprint, so the daemon is
  replaced on the next start — desired: the code under test is the code that
  serves.
- An orphaned `freebuff.exe` from a force-killed daemon reclaims its Hour
  session through the normal path (0.1.x: silent session takeover).
