// Issue #27: the per-version screen fixture corpus. Every fixture in a version folder is
// a real capture of a known screen, and its file name names the screen it shows, so the
// checks are table-driven over names. `negative/` holds hand-made frames that must match
// no known screen; `synthetic/` holds the hand-made emulator vectors (fixtures README).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOGIN_REQUIRED, mentionsSingleInstance } from '../src/protocol/markers.ts';
import { classifyScreen, flattenScreen, isKnownScreen, type ScreenVerdict } from '../src/protocol/screen.ts';

const corpusDir = new URL('./fixtures/screen/', import.meta.url);
// Fixtures store the flattened screen with \n; the real PTY (ConPTY) emits \r\n, and LF
// alone keeps the column in the emulator, wrapping long rows. Replay as the PTY would.
const load = async (folder: string, name: string): Promise<string> =>
  flattenScreen([readFileSync(new URL(`${folder}/${name}.ansi`, corpusDir), 'utf8').replace(/\n/g, '\r\n')]);

// The naming rule: a fixture's name names the screen it shows, and this table is the
// recognition that name must produce under today's known-screen check. Both dialog names
// (`single-instance`, `session-in-use`) recognize the same dialog via its two wordings.
const sessionInUse = (_v: ScreenVerdict, text: string): boolean => mentionsSingleInstance(text);
const RECOGNIZED_AS: Record<string, (verdict: ScreenVerdict, text: string) => boolean> = {
  'continue': (v) => v.continueScreen,
  'error': (v) => v.ready, // the error rendering rides on the ready input box
  // The `expanded` suffix is historical: 0.0.193 was born expanded, 0.0.199 collapsed;
  // classifyScreen reads title-plus-rows either way.
  'picker-expanded': (v) => v.picker !== null,
  'ready': (v) => v.ready,
  'session-in-use': sessionInUse,
  'single-instance': sessionInUse,
  'banner-ready': (v) => v.ready,
  'connecting': (v) => v.connecting,
  'connecting-to-ready': (v) => v.ready,
  'login-required': (_v, text) => text.includes(LOGIN_REQUIRED),
  'partial-line': (v) => v.connecting,
  'repaint': (v) => v.ready,
  'split-escape': (v) => v.ready,
};

// Version folders grow only by a deliberate capture or dump promotion (fixtures README).
const VERSIONS = ['0.0.193', '0.0.198', '0.0.199'];

const folders = (): string[] =>
  readdirSync(corpusDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

const fixtureNames = (folder: string): string[] =>
  readdirSync(new URL(`${folder}/`, corpusDir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ansi'))
    .map((entry) => entry.name.replace(/\.ansi$/, ''))
    .sort();

describe('screen fixture corpus (issue #27)', () => {
  it('holds one folder per CLI version on file', () => {
    expect(folders()).toEqual(VERSIONS);
  });

  describe.each(VERSIONS)('%s', (version) => {
    it.each(fixtureNames(version))('%s.ansi is the screen its name names, and known', async (name) => {
      const text = await load(version, name);
      const recognizedAs = RECOGNIZED_AS[name];
      expect(recognizedAs, `no table entry for ${version}/${name}.ansi: the name must name the screen it shows`).toBeDefined();
      expect(recognizedAs!(classifyScreen(text), text), `${version}/${name}.ansi`).toBe(true);
      expect(isKnownScreen(classifyScreen(text), text), `${version}/${name}.ansi`).toBe(true);
    });
  });

  describe('synthetic', () => {
    it.each(fixtureNames('synthetic'))('%s.ansi stays a known screen', async (name) => {
      const text = await load('synthetic', name);
      const recognizedAs = RECOGNIZED_AS[name];
      expect(recognizedAs, `no table entry for synthetic/${name}.ansi`).toBeDefined();
      expect(isKnownScreen(classifyScreen(text), text), `synthetic/${name}.ansi`).toBe(true);
    });
  });

  describe('negative', () => {
    it.each(fixtureNames('negative'))('%s.ansi matches no known screen', async (name) => {
      const text = await load('negative', name);
      expect(isKnownScreen(classifyScreen(text), text), `${name}.ansi must stay unknown`).toBe(false);
    });
  });
});
