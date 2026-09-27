// Issue #28: the per-version screen fixture corpus, replayed through the pure
// recognition function (Seam 1 in ADR-0001's testing decisions). Every fixture in a
// version folder is a real capture of a known screen, and its file name names the
// screen it shows, so the checks are table-driven over names. `negative/` holds
// hand-made frames a loosened signature must never recognize; `synthetic/` holds the
// hand-made emulator vectors (tests/fixtures/screen/AGENTS.md).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recognizeScreen, type KnownScreen } from '../src/protocol/signatures.ts';
import { flattenScreen } from '../src/protocol/screen.ts';

const corpusDir = new URL('./fixtures/screen/', import.meta.url);
// Fixtures store the flattened screen with \n; the real PTY (ConPTY) emits \r\n, and LF
// alone keeps the column in the emulator, wrapping long rows. Replay as the PTY would.
const load = async (folder: string, name: string): Promise<string> =>
  flattenScreen([readFileSync(new URL(`${folder}/${name}.ansi`, corpusDir), 'utf8').replace(/\n/g, '\r\n')]);

// The naming rule: a fixture's name names the screen it shows, and this table is the
// screen that name must produce at level pass. Both dialog names (`single-instance`,
// `session-in-use`) name the same dialog via its two wordings; `connecting-to-ready` is
// the screen after the cursor-up rewrite erases Connecting.
const RECOGNIZED_AS: Record<string, KnownScreen> = {
  'continue': 'Continue',
  'error': 'ready',
  'welcome': 'Welcome screen',
  'welcome-expired': 'Welcome screen',
  'ready': 'ready',
  'session-in-use': 'Session-in-use dialog',
  'single-instance': 'Session-in-use dialog',
  'banner-ready': 'ready',
  'connecting': 'connecting',
  'connecting-to-ready': 'ready',
  'dialog-over-picker': 'Session-in-use dialog',
  'login-required': 'login gate',
  'partial-line': 'connecting',
  'repaint': 'ready',
  'split-escape': 'ready',
};

// Version folders grow only by a deliberate capture or dump promotion (tests/fixtures/screen/AGENTS.md).
const VERSIONS = ['0.0.193', '0.0.198', '0.0.199', '0.1.0', '0.1.2'];

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
    it.each(fixtureNames(version))('%s.ansi is the screen its name names, at level pass', async (name) => {
      const expected = RECOGNIZED_AS[name];
      expect(expected, `no table entry for ${version}/${name}.ansi: the name must name the screen it shows`).toBeDefined();
      const recognition = recognizeScreen(await load(version, name));
      expect(recognition.screen, `${version}/${name}.ansi`).toBe(expected);
      expect(recognition.level, `${version}/${name}.ansi`).toBe('pass');
    });
  });

  describe('synthetic', () => {
    it.each(fixtureNames('synthetic'))('%s.ansi is the screen its name names', async (name) => {
      const expected = RECOGNIZED_AS[name];
      expect(expected, `no table entry for synthetic/${name}.ansi`).toBeDefined();
      expect(recognizeScreen(await load('synthetic', name)).screen, `synthetic/${name}.ansi`).toBe(expected);
    });
  });

  describe('negative', () => {
    // Ready frames baiting a loosened Continue signature (issue #28): an Answer carrying
    // the Continue wording, and a mid-Turn status line showing Esc. The Answer's quoted
    // prompt sits in the transcript area, above the Continue signature's bottom-rows
    // region, and the mid-Turn frame lost the Countdown line — both stay ready, never
    // Continue.
    const NOT_CONTINUE: Record<string, { level: 'pass' | 'degraded'; missing: string[] }> = {
      'continue-wording-answer': { level: 'pass', missing: [] },
      'mid-turn-esc': { level: 'degraded', missing: ['COUNTDOWN_REGEX'] },
    };

    it('accounts for every fixture in the folder', () => {
      expect(['ad-panel', 'generic-words', ...Object.keys(NOT_CONTINUE)].sort()).toEqual(fixtureNames('negative'));
    });

    it.each(['ad-panel', 'generic-words'])('%s.ansi matches no known screen', async (name) => {
      const recognition = recognizeScreen(await load('negative', name));
      expect(recognition.screen, `${name}.ansi must stay unknown`).toBeNull();
    });

    it.each(Object.keys(NOT_CONTINUE))('%s.ansi is not the Continue screen', async (name) => {
      const recognition = recognizeScreen(await load('negative', name));
      expect(recognition.screen, `${name}.ansi must not read as Continue`).toBe('ready');
      expect(recognition.level, `${name}.ansi`).toBe(NOT_CONTINUE[name]!.level);
      expect(recognition.missing, `${name}.ansi`).toEqual(NOT_CONTINUE[name]!.missing);
    });
  });

  describe('degradation (issue #28)', () => {
    // Drift starts with one Marker reworded: the fixture keeps its screen at level
    // degraded, naming the missing Marker; with too few Markers left (the strong ones
    // gone, weak Markers alone) it is not recognized at all.
    const withoutLinesContaining = async (folder: string, name: string, fragment: string): Promise<string> => {
      const text = await load(folder, name);
      return text.split('\n').filter((line) => !line.includes(fragment)).join('\n');
    };

    it('ready without its Countdown line is degraded, naming COUNTDOWN_REGEX', async () => {
      const recognition = recognizeScreen(await withoutLinesContaining('0.0.199', 'ready', '58m left'));
      expect(recognition.screen).toBe('ready');
      expect(recognition.level).toBe('degraded');
      expect(recognition.missing).toEqual(['COUNTDOWN_REGEX']);
    });

    it('ready with only its Countdown left is not recognized: weak Markers never recognize', async () => {
      const recognition = recognizeScreen(await withoutLinesContaining('0.0.199', 'ready', 'Enter a coding task'));
      expect(recognition.screen).toBeNull();
    });

    it('the dialog with only its Take over button left is not recognized', async () => {
      const recognition = recognizeScreen(await withoutLinesContaining('0.0.198', 'session-in-use', 'Session already in use'));
      expect(recognition.screen).toBeNull();
    });

    it('Continue without its prompt Marker is not recognized', async () => {
      const recognition = recognizeScreen(await withoutLinesContaining('0.0.199', 'continue', 'Press Enter to continue'));
      expect(recognition.screen).toBeNull();
    });

    it('the login gate without its Marker is not recognized', async () => {
      const recognition = recognizeScreen(await withoutLinesContaining('synthetic', 'login-required', 'Not authenticated'));
      expect(recognition.screen).toBeNull();
    });
  });
});
