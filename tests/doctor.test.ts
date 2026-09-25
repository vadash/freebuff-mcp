import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkMarkers } from '../src/doctor.ts';
import { flattenScreen } from '../src/protocol/screen.ts';

const screen = async (name: string): Promise<string> =>
  flattenScreen([readFileSync(new URL(`./fixtures/screen/${name}`, import.meta.url), 'utf8')]);

describe('checkMarkers', () => {
  it.each(['picker-expanded.ansi', 'ready.ansi', 'continue.ansi'])('finds every expected Marker on %s', async (name) => {
    expect(checkMarkers(await screen(name))).toEqual([]);
  });

  it('names the drifted Marker when the picker title wording changes', async () => {
    const text = (await screen('picker-expanded.ansi')).replace('Start coding for free', 'Pick a model');
    expect(checkMarkers(text)).toEqual([expect.stringMatching(/^PICKER_TITLE: /)]);
  });

  it('names the drifted Countdown on a ready Screen', async () => {
    const text = (await screen('ready.ansi')).replace(/ left/g, ' remaining');
    expect(checkMarkers(text)).toEqual([expect.stringMatching(/^COUNTDOWN_REGEX: /)]);
  });

  it('reports a Screen matching no known screen', () => {
    expect(checkMarkers('something else entirely')).toEqual([expect.stringContaining('no known screen')]);
  });
});
