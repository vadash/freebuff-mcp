import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JUNCTION_NAME, assertSafeTarget, ensureJunction, workspaceDirFor } from '../src/workspace.ts';

describe('workspace', () => {
  it('refuses roots and workspace ancestors but allows sibling and cross-drive targets', () => {
    const ws = workspaceDirFor('\\\\.\\pipe\\ws-guard');
    expect(() => assertSafeTarget('C:\\', ws)).toThrow(/unsafe/);
    expect(() => assertSafeTarget('\\\\srv\\share', ws)).toThrow(/unsafe/);
    expect(() => assertSafeTarget(tmpdir(), ws)).toThrow(/unsafe/);
    expect(() => assertSafeTarget(ws, ws)).toThrow(/unsafe/);
    expect(() => assertSafeTarget(join(tmpdir(), 'sibling-repo'), ws)).not.toThrow();
    // A second drive can never contain the workspace, so it is a legal junction target.
    expect(() => assertSafeTarget('D:\\repos\\demo', ws)).not.toThrow();
  });
  it('derives a stable per-pipe directory under the temp root', () => {
    const dir = workspaceDirFor('\\\\.\\pipe\\ws-demo-1');
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(dir).toMatch(/freebuff-ws-[0-9a-f]{8}$/);
    expect(workspaceDirFor('\\\\.\\pipe\\ws-demo-1')).toBe(dir);
    expect(workspaceDirFor('\\\\.\\pipe\\ws-demo-2')).not.toBe(dir);
  });

  it('creates the workspace if missing and points the repo junction at the target', () => {
    const ws = join(tmpdir(), `freebuff-ws-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const target = mkdtempSync(join(tmpdir(), 'ws-repo-a-'));
    writeFileSync(join(target, 'marker.txt'), 'A');
    const junction = join(ws, JUNCTION_NAME);
    ensureJunction(ws, target);
    expect(resolve(readlinkSync(junction))).toBe(resolve(target));
    expect(readFileSync(join(junction, 'marker.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(target, 'marker.txt'), 'utf8')).toBe('A');
  });

  it('re-ensuring an already-correct junction keeps it pointing at the target', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-reidem-'));
    const target = mkdtempSync(join(tmpdir(), 'ws-repo-b-'));
    ensureJunction(ws, target);
    const before = readlinkSync(join(ws, JUNCTION_NAME));
    ensureJunction(ws, target);
    expect(readlinkSync(join(ws, JUNCTION_NAME))).toBe(before);
  });

  it('swaps the junction to the new target and leaves the old target intact', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-swap-'));
    const first = mkdtempSync(join(tmpdir(), 'ws-repo-c-'));
    const second = mkdtempSync(join(tmpdir(), 'ws-repo-d-'));
    writeFileSync(join(first, 'first.txt'), '1');
    writeFileSync(join(second, 'second.txt'), '2');
    const junction = join(ws, JUNCTION_NAME);
    ensureJunction(ws, first);
    ensureJunction(ws, second);
    expect(resolve(readlinkSync(junction))).toBe(resolve(second));
    expect(readFileSync(join(junction, 'second.txt'), 'utf8')).toBe('2');
    expect(existsSync(join(junction, 'first.txt'))).toBe(false);
    expect(existsSync(join(first, 'first.txt'))).toBe(true);
  });

  it('removing the junction deletes only the link, never the target contents', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-rm-'));
    const target = mkdtempSync(join(tmpdir(), 'ws-repo-e-'));
    writeFileSync(join(target, 'keep.txt'), 'kept');
    const junction = join(ws, JUNCTION_NAME);
    ensureJunction(ws, target);
    rmSync(junction, { force: true });
    expect(existsSync(junction)).toBe(false);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('kept');
  });

  // Safety rail: a swap must never be able to delete content through the junction.
  it('survives two retarget swaps with the canary and both targets intact', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-canary-'));
    const first = mkdtempSync(join(tmpdir(), 'ws-canary-a-'));
    const second = mkdtempSync(join(tmpdir(), 'ws-canary-b-'));
    writeFileSync(join(first, 'canary.txt'), 'alive');
    writeFileSync(join(second, 'other.txt'), 'also here');
    const junction = join(ws, JUNCTION_NAME);
    ensureJunction(ws, first);
    ensureJunction(ws, second);
    ensureJunction(ws, first);
    expect(lstatSync(junction).isSymbolicLink()).toBe(true);
    expect(resolve(readlinkSync(junction))).toBe(resolve(first));
    expect(readFileSync(join(first, 'canary.txt'), 'utf8')).toBe('alive');
    expect(readFileSync(join(second, 'other.txt'), 'utf8')).toBe('also here');
    expect(readFileSync(join(junction, 'canary.txt'), 'utf8')).toBe('alive');
  });

  it('refuses to replace a real directory named repo instead of deleting it', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-realdir-'));
    const repo = join(ws, JUNCTION_NAME);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'precious.txt'), 'keep me');
    const target = mkdtempSync(join(tmpdir(), 'ws-realdir-target-'));
    expect(() => ensureJunction(ws, target)).toThrow(/not a junction/);
    expect(lstatSync(repo).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(repo, 'precious.txt'), 'utf8')).toBe('keep me');
  });
});
