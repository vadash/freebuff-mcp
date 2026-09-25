import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNOWN_ERROR_STRINGS, SINGLE_INSTANCE } from '../src/protocol/markers.ts';
import { CliTerminalScreen, classifyScreen, countdownMinutes, flattenScreen, freezeSignature, screenExcerpt } from '../src/protocol/screen.ts';

const dir = new URL('./fixtures/screen/', import.meta.url);
const load = (name: string): string => readFileSync(new URL(name, dir), 'utf8');
// Fixtures store the flattened screen with \n; the real PTY (ConPTY) emits \r\n, and LF
// alone keeps the column in the emulator, wrapping long rows. Replay as the PTY would.
const screen = async (name: string): Promise<string> => flattenScreen([load(name).replace(/\n/g, '\r\n')]);

const verdict = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ready: false,
  connecting: false,
  picker: null,
  banner: null,
  entries: [],
  freebucksBalance: null,
  freebucksDaily: null,
  countdownMinutes: null,
  activeModel: null,
  continueScreen: false,
  ...over,
});

describe('classifyScreen', () => {
  it('reports a ready prompt with the Countdown from the status line', async () => {
    expect(classifyScreen(await screen('ready.ansi'))).toEqual(verdict({ ready: true, countdownMinutes: 60, activeModel: 'Solar Mini 4' }));
  });

  it('reports the connecting spinner even when the prompt is rendered below', async () => {
    expect(classifyScreen(await screen('connecting.ansi'))).toEqual(verdict({ connecting: true }));
  });

  it('becomes ready when the cursor-up rewrite erases Connecting', async () => {
    expect(classifyScreen(await screen('connecting-to-ready.ansi'))).toEqual(verdict({ ready: true }));
  });

  it('binds a directory banner only for the expected dir', async () => {
    const text = await screen('banner-ready.ansi');
    expect(classifyScreen(text, 'C:/work/demo-app')).toEqual(verdict({ ready: true, banner: 'C:/work/demo-app' }));
    expect(classifyScreen(text)).toEqual(verdict({ ready: true }));
    expect(classifyScreen(text, 'C:/elsewhere')).toEqual(verdict({ ready: true }));
  });

  it('sees an expanded model picker', async () => {
    expect(classifyScreen(await screen('picker-expanded.ansi')).picker).toBe('expanded');
  });
});

describe('classifyScreen against the real captured fixtures (issue #11)', () => {
  it('extracts the real picker entries with their displayed prices', async () => {
    const parsed = classifyScreen(await screen('picker-expanded.ansi'));
    expect(parsed.entries).toEqual([
      { name: 'GLM 5.3 Flash', price: 0 },
      { name: 'MiMo 2.6 Flash', price: 0 },
      { name: 'Solar Mini 4', price: 0 },
      { name: 'DeepSeek V4.1 Flash', price: 5 },
    ]);
  });

  it('extracts the Freebucks balance and daily allowance from the real picker', async () => {
    const parsed = classifyScreen(await screen('picker-expanded.ansi'));
    expect(parsed.freebucksBalance).toBe(20);
    expect(parsed.freebucksDaily).toBe(25);
    expect(parsed.countdownMinutes).toBeNull();
    expect(parsed.continueScreen).toBe(false);
  });

  it('sees no Continue screen on the picker', async () => {
    expect(classifyScreen(await screen('picker-expanded.ansi')).continueScreen).toBe(false);
  });

  it('sees the Continue screen with its remaining balance', async () => {
    const parsed = classifyScreen(await screen('continue.ansi'));
    expect(parsed.continueScreen).toBe(true);
    expect(parsed.ready).toBe(false);
    expect(parsed.picker).toBeNull();
    expect(parsed.freebucksBalance).toBe(20);
    expect(parsed.freebucksDaily).toBeNull();
    expect(parsed.countdownMinutes).toBeNull();
  });

  it('matches the captured error screen against the known error strings', async () => {
    const text = await screen('error.ansi');
    expect(KNOWN_ERROR_STRINGS.some((marker) => text.includes(marker))).toBe(true);
  });

  it('matches the single-instance dialog marker against the real capture', async () => {
    expect(classifyScreen(await screen('single-instance.ansi')).ready).toBe(false);
    expect(load('single-instance.ansi')).toContain(SINGLE_INSTANCE);
  });

  it('parses every Countdown wording captured in the wild', () => {
    expect(countdownMinutes('Solar Mini 4 · 7h 12m left · 12.9K (3%)')).toBe(432);
    expect(countdownMinutes('Solar Mini 4 · 1h 1m left · 12.9K (3%)')).toBe(61);
    expect(countdownMinutes('Solar Mini 4 · 1h left · 12.9K (3%)')).toBe(60);
    expect(countdownMinutes('Solar Mini 4 · 59m left · 12.9K (3%)')).toBe(59);
    expect(countdownMinutes('Solar Mini 4 · 9m left · 12.9K (3%)')).toBe(9);
    expect(countdownMinutes('Solar Mini 4 · 2:58 left · 12.9K (3%)')).toBe(2);
    expect(countdownMinutes('resets in 9h 12m')).toBeNull();
    expect(countdownMinutes('working · 3s · ■ Esc')).toBeNull();
    expect(countdownMinutes('')).toBeNull();
  });
});

describe('flattenScreen', () => {
  it('renders chunks through one shared screen', async () => {
    expect(classifyScreen(await flattenScreen([load('ready.ansi').replace(/\n/g, '\r\n')]))).toEqual(verdict({ ready: true, countdownMinutes: 60, activeModel: 'Solar Mini 4' }));
  });

  it('reassembles an escape sequence split mid-sequence', async () => {
    const raw = load('split-escape.ansi');
    const cut = raw.indexOf('\x1b[2J') + '\x1b[2'.length;
    const flat = await flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(classifyScreen(flat)).toEqual(verdict({ ready: true }));
    expect(flat).toBe(await flattenScreen([raw]));
  });

  it('completes a partial line across writes', async () => {
    const raw = load('partial-line.ansi');
    const cut = raw.indexOf('Connecting') + 'Connect'.length;
    const flat = await flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(flat).toContain('Connecting...');
    expect(classifyScreen(flat)).toEqual(verdict({ connecting: true }));
  });

  it('keeps the last repaint', async () => {
    const flat = await flattenScreen([load('repaint.ansi')]);
    expect(flat).not.toContain('Connecting');
    expect(classifyScreen(flat)).toEqual(verdict({ ready: true }));
  });

  it('reads the viewport, not scrollback, once output exceeds the screen', async () => {
    const screen = new CliTerminalScreen();
    for (let i = 0; i < 60; i++) screen.write(`line-${i}\r\n`);
    await screen.flush();
    const text = screen.text();
    expect(text).toContain('line-59');
    expect(text).toContain('line-13\n');
    expect(text).not.toContain('line-12\n');
    expect(text).not.toContain('line-0\n');
  });
});

describe('freezeSignature', () => {
  it('ignores the ticking Countdown on the ready status line', async () => {
    const ready = await screen('ready.ansi');
    const ticked = ready.replace('1h left', '59m left');
    expect(ticked).not.toBe(ready);
    expect(freezeSignature(ticked)).toBe(freezeSignature(ready));
  });

  it('ignores the Freebucks lines on the picker and the Continue screen', async () => {
    const picker = await screen('picker-expanded.ansi');
    expect(freezeSignature(picker.replace(/\d+\/(\d+) Freebucks daily/, '3/$1 Freebucks daily'))).toBe(freezeSignature(picker));
    const cont = await screen('continue.ansi');
    expect(freezeSignature(cont.replace(/\d+ Freebucks left/, '7 Freebucks left'))).toBe(freezeSignature(cont));
  });

  it('still sees any other Screen change', async () => {
    const ready = await screen('ready.ansi');
    expect(freezeSignature(ready + '\nThinking...')).not.toBe(freezeSignature(ready));
  });
});

describe('screenExcerpt', () => {
  it('keeps the last non-blank lines, right-trimmed', () => {
    const text = ['one   ', '', 'two', '   ', 'three  ', '', ''].join('\n');
    expect(screenExcerpt(text, 2)).toBe('two\nthree');
    expect(screenExcerpt(text, 10)).toBe('one\ntwo\nthree');
  });
});
