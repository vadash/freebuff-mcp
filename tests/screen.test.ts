import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COUNTDOWN_REGEX, KNOWN_ERROR_STRINGS, mentionsSingleInstance } from '../src/protocol/markers.ts';
import { pickModelIndex } from '../src/driver.ts';
import { CliTerminalScreen, classifyScreen, countdownMinutes, errorLines, flattenScreen, freezeKey, screenExcerpt } from '../src/protocol/screen.ts';

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
    expect(classifyScreen(await screen('0.0.199/ready.ansi'))).toEqual(verdict({ ready: true, countdownMinutes: 58, activeModel: 'GLM 5.3 Flash' }));
  });

  it('reports the connecting spinner even when the prompt is rendered below', async () => {
    expect(classifyScreen(await screen('synthetic/connecting.ansi'))).toEqual(verdict({ connecting: true }));
  });

  it('becomes ready when the cursor-up rewrite erases Connecting', async () => {
    expect(classifyScreen(await screen('synthetic/connecting-to-ready.ansi'))).toEqual(verdict({ ready: true }));
  });

  it('binds a directory banner only for the expected dir', async () => {
    const text = await screen('synthetic/banner-ready.ansi');
    expect(classifyScreen(text, 'C:/work/demo-app')).toEqual(verdict({ ready: true, banner: 'C:/work/demo-app' }));
    expect(classifyScreen(text)).toEqual(verdict({ ready: true }));
    expect(classifyScreen(text, 'C:/elsewhere')).toEqual(verdict({ ready: true }));
  });

  it('sees an expanded model picker', async () => {
    expect(classifyScreen(await screen('0.0.199/picker-expanded.ansi')).picker).toBe('expanded');
  });
});

describe('classifyScreen against the real captured fixtures (issue #11)', () => {
  // The picker fixture is refreshed by every capture run of its version (issue #32
  // expands it), so these hold the parse invariants that travel with any refresh —
  // never the incidental rows or balance of the last capture.
  it('parses the real picker rows with their displayed prices', async () => {
    const parsed = classifyScreen(await screen('0.0.199/picker-expanded.ansi'));
    expect(parsed.entries.length).toBeGreaterThan(0);
    for (const entry of parsed.entries) {
      expect(entry.name.trim(), JSON.stringify(entry)).not.toBe('');
      expect(entry.price).toBeGreaterThanOrEqual(0);
    }
  });

  it('extracts the Freebucks balance and daily allowance from the real picker', async () => {
    const parsed = classifyScreen(await screen('0.0.199/picker-expanded.ansi'));
    expect(parsed.freebucksBalance).not.toBeNull();
    expect(parsed.freebucksDaily).toBeGreaterThanOrEqual(parsed.freebucksBalance!);
    expect(parsed.countdownMinutes).toBeNull();
    expect(parsed.continueScreen).toBe(false);
  });

  it('sees no Continue screen on the picker', async () => {
    expect(classifyScreen(await screen('0.0.199/picker-expanded.ansi')).continueScreen).toBe(false);
  });

  it('sees the Continue screen; 0.0.199 no longer shows a remaining balance', async () => {
    const parsed = classifyScreen(await screen('0.0.199/continue.ansi'));
    expect(parsed.continueScreen).toBe(true);
    expect(parsed.ready).toBe(false);
    expect(parsed.picker).toBeNull();
    expect(parsed.freebucksBalance).toBeNull();
    expect(parsed.freebucksDaily).toBeNull();
    expect(parsed.countdownMinutes).toBeNull();
  });

  it('matches the captured error screen against the known error strings', async () => {
    const text = await screen('0.0.199/error.ansi');
    expect(KNOWN_ERROR_STRINGS.some((marker) => text.includes(marker))).toBe(true);
  });

  it('extracts the error lines from the captured error screen, trimmed, one per occurrence', async () => {
    const text = await screen('0.0.199/error.ansi');
    const line = 'Command not found: "/definitely-not-a-freebuff-command"';
    expect(errorLines(`${text}\n${text}`)).toEqual([line, line]);
    expect(errorLines(await screen('0.0.199/ready.ansi'))).toEqual([]);
  });

  it('matches the single-instance dialog marker against the real capture', async () => {
    expect(classifyScreen(await screen('0.0.193/single-instance.ansi')).ready).toBe(false);
    expect(mentionsSingleInstance(await load('0.0.193/single-instance.ansi'))).toBe(true);
  });

  it('matches the 0.0.198 session-in-use dialog marker against the real capture', async () => {
    expect(classifyScreen(await screen('0.0.198/session-in-use.ansi')).ready).toBe(false);
    expect(classifyScreen(await screen('0.0.198/session-in-use.ansi')).picker).toBeNull();
    expect(mentionsSingleInstance(await load('0.0.198/session-in-use.ansi'))).toBe(true);
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

// Issue #30 (Testing Decisions): one test per parsed field, with that field removed
// from a real fixture; every fallback must be safe — recognition is tolerant, parsing
// stays strict and a missing field degrades to the action freebuff itself would take,
// never a wrong action.
describe('safe parsing fallbacks (issue #30)', () => {
  const withoutLinesContaining = async (name: string, ...fragments: string[]): Promise<string> => {
    const text = await screen(name);
    return text.split('\n').filter((line) => !fragments.some((fragment) => line.includes(fragment))).join('\n');
  };

  it('picker rows missing: no entries, the pick rule Enters the highlighted row', async () => {
    const parsed = classifyScreen(await withoutLinesContaining('0.0.199/picker-expanded.ansi', 'GLM 5.3 Flash', 'Freebucks/hr'));
    expect(parsed.picker).not.toBeNull();
    expect(parsed.entries).toEqual([]);
    expect(parsed.freebucksBalance).toBe(25);
    expect(pickModelIndex(parsed.entries, parsed.freebucksBalance)).toBe(0);
  });

  it('balance missing: the pick rule keeps its safe default and never picks an unproven deepseek', async () => {
    const parsed = classifyScreen(await withoutLinesContaining('0.0.193/picker-expanded.ansi', 'Freebucks daily'));
    expect(parsed.freebucksBalance).toBeNull();
    expect(parsed.freebucksDaily).toBeNull();
    const deepseek = parsed.entries.findIndex((entry) => entry.name.toLowerCase().includes('deepseek'));
    expect(deepseek).toBeGreaterThanOrEqual(0);
    expect(pickModelIndex(parsed.entries, parsed.freebucksBalance)).not.toBe(deepseek);
    expect(pickModelIndex(parsed.entries, parsed.freebucksBalance)).toBe(parsed.entries.findIndex((entry) => entry.name.toLowerCase().includes('glm')));
  });

  it('countdown missing: minutes left unknown, never zero', async () => {
    const parsed = classifyScreen(await withoutLinesContaining('0.0.199/ready.ansi', '58m left'));
    expect(parsed.ready).toBe(true);
    expect(parsed.countdownMinutes).toBeNull();
  });

  it('status-line model missing: no active model reported, the Countdown still parses', async () => {
    const parsed = classifyScreen((await screen('0.0.199/ready.ansi')).replace(' GLM 5.3 Flash', ''));
    expect(parsed.countdownMinutes).toBe(58);
    expect(parsed.activeModel).toBeNull();
  });

  it('banner missing on ready: no banner, which fails the Driver dir_mismatch check', async () => {
    const parsed = classifyScreen(await withoutLinesContaining('synthetic/banner-ready.ansi', 'C:/work/demo-app'), 'C:/work/demo-app');
    expect(parsed.ready).toBe(true);
    expect(parsed.banner).toBeNull();
  });

  it('reads the recognized screen: a dialog over the picker is the dialog, never a picker', async () => {
    const parsed = classifyScreen(await screen('synthetic/dialog-over-picker.ansi'));
    expect(parsed.ready).toBe(false);
    expect(parsed.picker).toBeNull();
    expect(parsed.continueScreen).toBe(false);
  });
});

describe('flattenScreen', () => {
  it('renders chunks through one shared screen', async () => {
    expect(classifyScreen(await flattenScreen([load('0.0.199/ready.ansi').replace(/\n/g, '\r\n')]))).toEqual(verdict({ ready: true, countdownMinutes: 58, activeModel: 'GLM 5.3 Flash' }));
  });

  it('reassembles an escape sequence split mid-sequence', async () => {
    const raw = load('synthetic/split-escape.ansi');
    const cut = raw.indexOf('\x1b[2J') + '\x1b[2'.length;
    const flat = await flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(classifyScreen(flat)).toEqual(verdict({ ready: true }));
    expect(flat).toBe(await flattenScreen([raw]));
  });

  it('completes a partial line across writes', async () => {
    const raw = load('synthetic/partial-line.ansi');
    const cut = raw.indexOf('Connecting') + 'Connect'.length;
    const flat = await flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(flat).toContain('Connecting...');
    expect(classifyScreen(flat)).toEqual(verdict({ connecting: true }));
  });

  it('keeps the last repaint', async () => {
    const flat = await flattenScreen([load('synthetic/repaint.ansi')]);
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

describe('freezeKey', () => {
  it('ignores the ticking Countdown on the ready status line', async () => {
    const ready = await screen('0.0.199/ready.ansi');
    const ticked = ready.replace('58m left', '57m left');
    expect(ticked).not.toBe(ready);
    expect(freezeKey(ticked)).toBe(freezeKey(ready));
  });

  // Issue #31: drifted Countdown wording misses COUNTDOWN_REGEX, yet its ticking
  // minutes must never enter the key — degraded repaints would multiply dumps.
  it('ignores a drifted Countdown whose wording misses the Countdown regex', async () => {
    const ready = await screen('0.0.199/ready.ansi');
    const drifted = ready.replace('58m left', '58m remaining');
    expect(COUNTDOWN_REGEX.test(drifted)).toBe(false);
    const ticked = drifted.replace('58m remaining', '57m remaining');
    expect(freezeKey(ticked)).toBe(freezeKey(drifted));
    expect(freezeKey(drifted)).toBe(freezeKey(ready));
  });

  it('ignores the Freebucks lines on the picker and the Continue screen', async () => {
    const picker = await screen('0.0.199/picker-expanded.ansi');
    expect(freezeKey(picker.replace(/\d+\/(\d+) Freebucks daily/, '3/$1 Freebucks daily'))).toBe(freezeKey(picker));
    const cont = await screen('0.0.199/continue.ansi');
    expect(freezeKey(cont.replace(/\d+ Freebucks left/, '7 Freebucks left'))).toBe(freezeKey(cont));
  });

  it('still sees any other Screen change', async () => {
    const ready = await screen('0.0.199/ready.ansi');
    expect(freezeKey(ready + '\nThinking...')).not.toBe(freezeKey(ready));
  });
});

describe('screenExcerpt', () => {
  it('keeps the last non-blank lines, right-trimmed', () => {
    const text = ['one   ', '', 'two', '   ', 'three  ', '', ''].join('\n');
    expect(screenExcerpt(text, 2)).toBe('two\nthree');
    expect(screenExcerpt(text, 10)).toBe('one\ntwo\nthree');
  });
});
