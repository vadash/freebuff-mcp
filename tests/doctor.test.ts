// Issue #29: doctor keeps no marker table of its own — its verdict is the recognition
// function's output, so these tests run at that seam over the corpus fixtures: an
// intact frame reports pass, a drifted picker title (only weak Markers left) reports
// fail, and a drifted Countdown reports degraded, naming the Marker.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { recognizeScreen } from '../src/protocol/signatures.ts';
import { flattenScreen } from '../src/protocol/screen.ts';

const screen = async (name: string): Promise<string> =>
  // Fixtures store \n; the real PTY emits \r\n, and LF alone keeps the column in the
  // emulator and mangles long rows (see screen.test.ts). Replay as the PTY would.
  flattenScreen([readFileSync(new URL(`./fixtures/screen/${name}`, import.meta.url), 'utf8').replace(/\n/g, '\r\n')]);

describe('doctor (issue #29: the recognition seam)', () => {
  it.each([
    ['0.0.199/picker-expanded.ansi', 'Model picker'],
    ['0.0.199/ready.ansi', 'ready'],
    ['0.0.199/continue.ansi', 'Continue'],
    ['0.0.198/session-in-use.ansi', 'Session-in-use dialog'],
  ] as const)('reports pass on %s, naming the screen', async (name, expected) => {
    expect(recognizeScreen(await screen(name))).toEqual({ screen: expected, level: 'pass', missing: [] });
  });

  it('reports degraded on a drifted Countdown, naming COUNTDOWN_REGEX', async () => {
    const text = (await screen('0.0.199/ready.ansi')).replace(/ left/g, ' remaining');
    expect(recognizeScreen(text)).toEqual({ screen: 'ready', level: 'degraded', missing: ['COUNTDOWN_REGEX'] });
  });

  it('reports fail on a drifted picker title: only weak Markers are left', async () => {
    const text = (await screen('0.0.199/picker-expanded.ansi')).replace('Start coding for free', 'Pick a model');
    const report = recognizeScreen(text);
    expect(report.screen, 'the picker signature no longer recognizes the frame').toBeNull();
    expect(report.level).toBe('fail');
    expect(report.missing).toEqual([]);
  });

  it('reports fail on a Screen matching no known screen', () => {
    expect(recognizeScreen('something else entirely')).toEqual({ screen: null, level: 'fail', missing: [] });
  });
});
