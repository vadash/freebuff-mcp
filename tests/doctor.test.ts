import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkMarkers } from '../src/doctor.ts';
import { flattenScreen } from '../src/protocol/screen.ts';

const screen = async (name: string): Promise<string> =>
  flattenScreen([readFileSync(new URL(`./fixtures/screen/${name}`, import.meta.url), 'utf8')]);

describe('checkMarkers', () => {
  it.each(['ready.ansi', 'continue.ansi'])('finds every expected Marker on %s', async (name) => {
    expect(checkMarkers(await screen(name))).toEqual([]);
  });

  it('finds every expected Marker on a hand-written 0.0.198 Model picker', () => {
    const picker = [
      'freebuff v0.0.198',
      'Start coding for free',
      'GLM 5.3 Flash',
      '0 Freebucks/hr',
      'FREE · 20/25 Freebucks daily · resets in 9h 12m',
      'H · History',
    ].join('\n');
    expect(checkMarkers(picker)).toEqual([]);
  });

  it('names the picker hint row missing from the 0.0.193 capture that predates it', async () => {
    // Real capture from 0.0.193; the `H · History` hint row was added by the 0.0.198
    // update. The capture refresh (slice 5) replaces this fixture; until then the
    // skew is the honest expectation.
    expect(checkMarkers(await screen('picker-expanded.ansi'))).toEqual([expect.stringMatching(/^HISTORY_HINT: /)]);
  });

  it('recognizes the Session-in-use dialog in both known wordings', () => {
    expect(checkMarkers('Session already in use\nLimited access without a subscription allows one session across CLI and Desktop.')).toEqual([]);
    expect(checkMarkers('Freebuff is already running\nOnly one freebuff instance is allowed at a time.')).toEqual([]);
  });

  it('finds every expected Marker on the captured 0.0.198 session-in-use fixture', async () => {
    expect(checkMarkers(await screen('session-in-use.ansi'))).toEqual([]);
  });

  it('recognizes the login gate', () => {
    expect(checkMarkers('Not authenticated\n\nPress ENTER to login...')).toEqual([]);
  });

  it('recognizes the connecting Screen without firing the ready Markers it renders underneath', () => {
    expect(checkMarkers('Connecting...\n\nEnd session  Enter a coding task or / for commands')).toEqual([]);
  });

  it('names the drifted Marker when the picker title wording changes', async () => {
    const text = (await screen('picker-expanded.ansi')).replace('Start coding for free', 'Pick a model');
    expect(checkMarkers(text)).toEqual([expect.stringMatching(/^PICKER_TITLE: /), expect.stringMatching(/^HISTORY_HINT: /)]);
  });

  it('names the drifted Countdown on a ready Screen', async () => {
    const text = (await screen('ready.ansi')).replace(/ left/g, ' remaining');
    expect(checkMarkers(text)).toEqual([expect.stringMatching(/^COUNTDOWN_REGEX: /)]);
  });

  it('reports a Screen matching no known screen, naming every table entry', () => {
    const [failure] = checkMarkers('something else entirely');
    expect(failure).toContain('no known screen');
    for (const name of ['PICKER_TITLE', 'PRICE_REGEX', 'FREEBUCKS_BALANCE_REGEX', 'HISTORY_HINT', 'READY_PROMPT', 'COUNTDOWN_REGEX', 'SESSION_ENDED', 'CONTINUE_PROMPT', 'FREEBUCKS_LEFT_REGEX', 'SINGLE_INSTANCE_MARKERS', 'LOGIN_REQUIRED', 'CONNECTING_REGEX']) {
      expect(failure).toContain(name);
    }
  });

  it('names a drifted picker hint row on a recognised picker', () => {
    const text = ['Start coding for free', 'GLM 5.3 Flash', '0 Freebucks/hr', 'FREE · 20/25 Freebucks daily · resets in 9h 12m', 'H · Past chats'].join('\n');
    expect(checkMarkers(text)).toEqual([expect.stringMatching(/^HISTORY_HINT: /)]);
  });
});
