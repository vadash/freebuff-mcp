import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { COUNTDOWN_REGEX, KNOWN_ERROR_STRINGS } from '../src/protocol/markers.ts';
import { CliTerminalScreen, classifyScreen, countdownMinutes, errorLines, flattenScreen, freezeKey, screenExcerpt } from '../src/protocol/screen.ts';

const dir = new URL('./fixtures/screen/', import.meta.url);
const load = (name: string): string => readFileSync(new URL(name, dir), 'utf8');
// Fixtures store the flattened screen with \n; the real PTY (ConPTY) emits \r\n, and LF
// alone keeps the column in the emulator, wrapping long rows. Replay as the PTY would.
const screen = async (name: string): Promise<string> => flattenScreen([load(name).replace(/\n/g, '\r\n')]);

// One screen oracle (ADR-0002 completed): classifyScreen returns the recognition and
// the strict parses; screen identity lives only in recognition.screen.
const verdict = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  banner: null,
  freebucksBalance: null,
  freebucksDaily: null,
  countdownMinutes: null,
  activeModel: null,
  ...over,
});
const assessed = (screenName: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  recognition: { screen: screenName, level: 'pass', missing: [] },
  verdict: verdict(over),
});

describe('classifyScreen', () => {
  // ADR-0004: the model is footer-derived; the pre-0.1.0 screens carried it on the
  // status line, so the old fixture reports no active model.
  it('reports a ready prompt with the Countdown from the status line', async () => {
    expect(classifyScreen(await screen('0.0.199/ready.ansi'))).toEqual(assessed('ready', { countdownMinutes: 58 }));
  });

  it('reports the connecting spinner even when the prompt is rendered below', async () => {
    expect(classifyScreen(await screen('synthetic/connecting.ansi'))).toEqual(assessed('connecting'));
  });

  it('becomes ready when the cursor-up rewrite erases Connecting', async () => {
    // Synthetic frames are hand-made and recognize degraded (Markers missing); identity
    // is the contract here — Marker completeness is the corpus tests' bar.
    expect(classifyScreen(await screen('synthetic/connecting-to-ready.ansi')).recognition.screen).toBe('ready');
  });

  it('binds a directory banner only for the expected dir', async () => {
    const text = await screen('synthetic/banner-ready.ansi');
    expect(classifyScreen(text, 'C:/work/demo-app').verdict).toEqual(verdict({ banner: 'C:/work/demo-app' }));
    expect(classifyScreen(text).recognition.screen).toBe('ready');
    expect(classifyScreen(text, 'C:/elsewhere').recognition.screen).toBe('ready');
  });

  it('expands the tilde-compressed home dir in the banner line', async () => {
    const text = (await screen('synthetic/banner-ready.ansi')).replace('C:/work/demo-app', '~/work/demo-app');
    const expected = homedir() + '/work/demo-app';
    expect(classifyScreen(text, expected).verdict).toEqual(verdict({ banner: expected }));
    expect(classifyScreen(text, 'C:/elsewhere').recognition.screen).toBe('ready');
  });
});

describe('classifyScreen against the real captured fixtures (issue #11)', () => {
  // The Welcome and session fixtures are refreshed by every capture run, so these hold
  // the parse invariants that travel with any refresh — never the incidental numbers of
  // the last capture (the remaining balance legitimately drops over a day of use).
  it('reads the Welcome screen: idle, footer model, balance parsed', async () => {
    const { recognition, verdict: parsed } = classifyScreen(await screen('0.1.0/welcome.ansi'));
    expect(recognition.screen).toBe('Welcome screen');
    expect(parsed.activeModel).toEqual(expect.stringMatching(/.+/));
    expect(parsed.freebucksBalance).toEqual(expect.any(Number));
    expect(parsed.freebucksDaily).toEqual(expect.any(Number));
    expect(parsed.freebucksBalance as number).toBeLessThanOrEqual(parsed.freebucksDaily as number);
    expect(parsed.countdownMinutes).toBeNull();
  });

  it('reads the session screen: ready with Countdown, footer model, remaining balance', async () => {
    const { recognition, verdict: parsed } = classifyScreen(await screen('0.1.0/ready.ansi'));
    expect(recognition.screen).toBe('ready');
    expect(parsed.activeModel).toEqual(expect.stringMatching(/.+/));
    expect(parsed.freebucksBalance).toEqual(expect.any(Number));
    expect(parsed.freebucksDaily).toEqual(expect.any(Number));
    expect(parsed.freebucksBalance as number).toBeLessThanOrEqual(parsed.freebucksDaily as number);
    expect(parsed.countdownMinutes as number).toBeGreaterThan(0);
    expect(parsed.countdownMinutes as number).toBeLessThanOrEqual(60);
  });

  // The post-expiry look (0.1.2): Countdown gone, box back to the Welcome wording,
  // transcript intact. This is the screen the Supervisor must treat as idle after an
  // Hour session expires.
  it('reads the post-expiry look as the Welcome screen with no Countdown', async () => {
    const { recognition, verdict: parsed } = classifyScreen(await screen('0.1.2/welcome-expired.ansi'));
    expect(recognition.screen).toBe('Welcome screen');
    expect(parsed.countdownMinutes).toBeNull();
  });

  it('sees the Continue screen; 0.0.199 no longer shows a remaining balance', async () => {
    const { recognition, verdict: parsed } = classifyScreen(await screen('0.0.199/continue.ansi'));
    expect(recognition.screen).toBe('Continue');
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

  it('reads the single-instance dialog wording as the Session-in-use dialog', async () => {
    expect(classifyScreen(await screen('0.0.193/single-instance.ansi')).recognition.screen).toBe('Session-in-use dialog');
  });

  it('reads the session-in-use dialog wording as the Session-in-use dialog', async () => {
    expect(classifyScreen(await screen('0.0.198/session-in-use.ansi')).recognition.screen).toBe('Session-in-use dialog');
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

  it('balance missing on the Welcome screen: no balance, the screen still reads idle', async () => {
    const { recognition, verdict: parsed } = classifyScreen(await withoutLinesContaining('0.1.0/welcome.ansi', 'Freebucks remaining'));
    expect(recognition.screen).toBe('Welcome screen');
    expect(parsed.freebucksBalance).toBeNull();
    expect(parsed.freebucksDaily).toBeNull();
  });

  it('countdown missing: minutes left unknown, never zero', async () => {
    const { recognition, verdict: parsed } = classifyScreen(await withoutLinesContaining('0.0.199/ready.ansi', '58m left'));
    expect(recognition.screen).toBe('ready');
    expect(parsed.countdownMinutes).toBeNull();
  });

  it('footer model missing: no active model reported, the Countdown still parses', async () => {
    const { recognition, verdict: parsed } = classifyScreen(await withoutLinesContaining('0.1.0/ready.ansi', '/model to change'));
    expect(recognition.screen).toBe('ready');
    expect(parsed.countdownMinutes).toBe(60);
    expect(parsed.activeModel).toBeNull();
  });

  it('banner missing on ready: no banner, which fails the Driver dir_mismatch check', async () => {
    const { recognition, verdict: parsed } = classifyScreen(await withoutLinesContaining('synthetic/banner-ready.ansi', 'C:/work/demo-app'), 'C:/work/demo-app');
    expect(recognition.screen).toBe('ready');
    expect(parsed.banner).toBeNull();
  });

  it('reads the recognized screen: a dialog over the Welcome screen is the dialog, never idle', async () => {
    const { recognition } = classifyScreen(await screen('synthetic/dialog-over-picker.ansi'));
    expect(recognition.screen).toBe('Session-in-use dialog');
  });
});

describe('flattenScreen', () => {
  it('renders chunks through one shared screen', async () => {
    expect(classifyScreen(await flattenScreen([load('0.0.199/ready.ansi').replace(/\n/g, '\r\n')]))).toEqual(assessed('ready', { countdownMinutes: 58 }));
  });

  it('reassembles an escape sequence split mid-sequence', async () => {
    const raw = load('synthetic/split-escape.ansi');
    const cut = raw.indexOf('\x1b[2J') + '\x1b[2'.length;
    const flat = await flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(classifyScreen(flat).recognition.screen).toBe('ready');
    expect(flat).toBe(await flattenScreen([raw]));
  });

  it('completes a partial line across writes', async () => {
    const raw = load('synthetic/partial-line.ansi');
    const cut = raw.indexOf('Connecting') + 'Connect'.length;
    const flat = await flattenScreen([raw.slice(0, cut), raw.slice(cut)]);
    expect(flat).toContain('Connecting...');
    expect(classifyScreen(flat)).toEqual(assessed('connecting'));
  });

  it('keeps the last repaint', async () => {
    const flat = await flattenScreen([load('synthetic/repaint.ansi')]);
    expect(flat).not.toContain('Connecting');
    expect(classifyScreen(flat).recognition.screen).toBe('ready');
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

  // The mid-Turn status line ticks elapsed seconds; a per-second key change would
  // blind the Watchdog's freeze check for every hung Turn.
  it('ignores the ticking mid-Turn status line', async () => {
    const midTurn = await screen('negative/mid-turn-esc.ansi');
    expect(COUNTDOWN_REGEX.test(midTurn)).toBe(false);
    const ticked = midTurn.replace('working · 3s ·', 'working · 4s ·');
    expect(ticked).not.toBe(midTurn);
    expect(freezeKey(ticked)).toBe(freezeKey(midTurn));
  });

  it('ignores the Freebucks lines on the Welcome screen and the Continue screen', async () => {
    const welcome = await screen('0.1.0/welcome.ansi');
    expect(freezeKey(welcome.replace(/\d+\/(\d+) Freebucks remaining/, '3/$1 Freebucks remaining'))).toBe(freezeKey(welcome));
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
