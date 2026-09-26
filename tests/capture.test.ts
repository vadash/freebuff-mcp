// Issue #32: captures write into the running CLI version's own corpus folder, resolved
// from the real profile's metadata file; an unreadable version refuses to guess rather
// than risk another version's fixtures.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { METADATA_FILENAME } from '../src/protocol/markers.ts';
import { captureFixturesDir } from './helpers/capture.ts';

describe('captureFixturesDir (issue #32)', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const configWith = (metadata: object): string => {
    dir = mkdtempSync(join(tmpdir(), 'freebuff-capture-'));
    writeFileSync(join(dir, METADATA_FILENAME), JSON.stringify(metadata));
    return dir;
  };

  it('names the corpus folder after the installed version', () => {
    expect(captureFixturesDir(configWith({ version: '0.0.199' }))).toMatch(/fixtures[\\/]screen[\\/]0\.0\.199[\\/]$/);
  });

  it('refuses to guess when the version is unreadable', () => {
    const missing = mkdtempSync(join(tmpdir(), 'freebuff-capture-'));
    rmSync(missing, { recursive: true, force: true });
    expect(() => captureFixturesDir(missing)).toThrow(/refusing to pick a corpus folder/);
    expect(() => captureFixturesDir(configWith({ version: 'unknown' }))).toThrow(/refusing to pick a corpus folder/);
    expect(() => captureFixturesDir(configWith({}))).toThrow(/refusing to pick a corpus folder/);
  });
});
