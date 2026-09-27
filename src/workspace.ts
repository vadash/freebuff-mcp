import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative, resolve } from 'node:path';

// Prepended to every prompt the supervisor submits: the Instance always runs in the
// per-pipe workspace, so the caller's repo is reached through the `repo` junction.
export const PROMPT_PREAMBLE = 'Work inside the repo/ folder in the current directory.';

export const JUNCTION_NAME = 'repo';

// Per-pipe and stable across restarts: the Instance always spawns here and the
// caller's real repo is mounted at `<workspace>/repo`.
export const workspaceDirFor = (pipeName: string): string =>
  join(tmpdir(), 'freebuff-ws-' + createHash('sha1').update(pipeName).digest('hex').slice(0, 8));

// The caller's `dir` must never let the junction mount a whole drive (`C:\`, `\`,
// UNC `\\srv\share`) or point at the workspace itself or one of its ancestors,
// which would make `repo` contain its own parent and loop directory walks.
export const assertSafeTarget = (target: string, workspace: string): void => {
  const resolved = resolve(target);
  if (parse(resolved).root === resolved) throw new Error('unsafe target');
  // A different drive can never contain the workspace; on it relative() returns an
  // absolute fallback, so the ancestor check below only applies to the same root.
  if (parse(resolved).root.toLowerCase() !== parse(workspace).root.toLowerCase()) return;
  const rel = relative(resolved, workspace);
  if (rel === '' || !rel.startsWith('..')) throw new Error('unsafe target');
};

// Points `<workspace>/repo` at `target`, creating the workspace when needed. Windows
// junctions need no admin rights, and removing one deletes only the link, never the
// target. Idempotent: an existing junction already on `target` is left alone, so
// every run_prompt can call this as a self-heal.
export const ensureJunction = (workspace: string, target: string): void => {
  mkdirSync(workspace, { recursive: true });
  const junction = join(workspace, JUNCTION_NAME);
  const wanted = resolve(target);
  try {
    if (resolve(readlinkSync(junction)) === wanted) return;
  } catch {
    // No junction yet: create it below.
  }
  // A real directory named `repo` must fail loudly here; recursive removal over
  // this path would delete its contents instead of just the link.
  const existing = lstatSync(junction, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isSymbolicLink()) {
    throw new Error(`refusing to replace ${junction}: it exists and is not a junction`);
  }
  if (existing !== undefined) rmSync(junction, { force: true });
  symlinkSync(wanted, junction, 'junction');
};
