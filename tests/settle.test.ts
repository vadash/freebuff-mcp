import { describe, expect, it } from 'vitest';
import { POLL_MS, UNKNOWN_SCREEN_FALLBACK_MS, UNSOLICITED_ENTER_MS } from '../src/config.ts';
import { recognizeScreen } from '../src/protocol/signatures.ts';
import { awaitSettled, type SettleIo } from '../src/settle.ts';

// Synthetic frames built from the Marker wordings; the precondition asserts keep them
// honest against the signature table, so a Marker change fails here, not live.
const DIR = 'C:\\repos\\demo';
const OTHER_DIR = 'C:\\repos\\other';
const dirLine = `DeepSeek V4.1 Flash • high · ${DIR} · /model to change`;

const readyFrame = ['Main prompt finished', 'Enter a coding task or / for commands', '7h 12m left', dirLine].join('\n');
// Drifted ready: the strong prompt Marker, the weak Countdown Marker missing.
const readyDegradedFrame = ['Enter a coding task or / for commands', dirLine].join('\n');
const welcomeFrame = ['freebuff', 'Your first message starts the session.', dirLine].join('\n');
const continueFrame = ['Remaining: 3 credits', 'Credit spending: pay per task', 'Press Enter to continue'].join('\n');
const dialogFrame = ['Session already in use', 'Take over', 'Esc to cancel'].join('\n');
// Drifted dialog: strong wording present, the weak 'Take over' Marker missing.
const dialogDegradedFrame = ['Session already in use', 'Esc to cancel'].join('\n');
const loginFrame = ['Not authenticated', 'Press any key to exit'].join('\n');
const unknownFrame = ['totally unknown frame', 'nothing recognized here'].join('\n');
const blankFrame = '';

describe('frame preconditions against the signature table', () => {
  it('frames recognize as intended', () => {
    expect(recognizeScreen(readyFrame)).toMatchObject({ screen: 'ready', level: 'pass' });
    expect(recognizeScreen(readyDegradedFrame)).toMatchObject({ screen: 'ready', level: 'degraded' });
    expect(recognizeScreen(welcomeFrame)).toMatchObject({ screen: 'Welcome screen', level: 'pass' });
    expect(recognizeScreen(continueFrame)).toMatchObject({ screen: 'Continue', level: 'pass' });
    expect(recognizeScreen(dialogFrame)).toMatchObject({ screen: 'Session-in-use dialog', level: 'pass' });
    expect(recognizeScreen(dialogDegradedFrame)).toMatchObject({ screen: 'Session-in-use dialog', level: 'degraded' });
    expect(recognizeScreen(loginFrame)).toMatchObject({ screen: 'login gate', level: 'pass' });
    expect(recognizeScreen(unknownFrame)).toMatchObject({ screen: null });
    expect(recognizeScreen(blankFrame)).toMatchObject({ screen: 'blank', level: 'pass' });
  });
});

/** Scripted io: frames advance when Enter is pressed (the stub flips its screen on
 *  input) or follow the clock; sleep advances virtual time. Times are milliseconds. */
const scriptIo = (frames: string[] | ((now: number) => string), alive?: (now: number) => boolean) => {
  let now = 0;
  let step = 0;
  const presses: number[] = [];
  const dumps: string[] = [];
  const io: SettleIo = {
    read: () => {
      if (typeof frames === 'function') return frames(now);
      return frames[Math.min(step, frames.length - 1)];
    },
    press: () => {
      presses.push(now);
      step++;
    },
    sleep: (ms: number) => {
      now += ms;
    },
    now: () => now,
    dump: (text: string) => {
      dumps.push(text);
    },
    alive: () => (alive ? alive(now) : true),
  };
  return { io, presses, dumps };
};

/** First POLL tick strictly past the throttle window (`now - last <= WINDOW` throttles). */
const FIRST_PRESS_AT = (Math.floor(UNSOLICITED_ENTER_MS / POLL_MS) + 1) * POLL_MS;

const settle = (io: SettleIo, opts: Partial<Parameters<typeof awaitSettled>[1]> = {}) =>
  awaitSettled(io, { readyMs: 30_000, idle: false, expectedDir: DIR, ...opts });

describe('awaitSettled', () => {
  it('returns ready on a recognized ready screen, touching nothing', async () => {
    const { io, presses, dumps } = scriptIo([readyFrame]);
    expect(await settle(io)).toEqual({ ok: 'ready' });
    expect(presses).toEqual([]);
    expect(dumps).toEqual([]);
  });

  it('returns idle on the Welcome screen without pressing, idle or not', async () => {
    for (const idle of [true, false]) {
      const { io, presses } = scriptIo([welcomeFrame]);
      expect(await settle(io, { idle })).toEqual({ ok: 'idle' });
      expect(presses).toEqual([]);
    }
  });

  it('fails dir_mismatch when the ready screen shows a foreign directory', async () => {
    const { io } = scriptIo([readyFrame]);
    expect(await settle(io, { expectedDir: OTHER_DIR })).toEqual({ error: 'dir_mismatch' });
  });

  it('fails dir_mismatch on the Welcome screen with a foreign directory', async () => {
    const { io } = scriptIo([welcomeFrame]);
    expect(await settle(io, { expectedDir: OTHER_DIR })).toEqual({ error: 'dir_mismatch' });
  });

  it('fails needs_login on the login gate without pressing or dumping', async () => {
    const { io, presses, dumps } = scriptIo([loginFrame]);
    expect(await settle(io)).toEqual({ error: 'needs_login' });
    expect(presses).toEqual([]);
    expect(dumps).toEqual([]);
  });

  it('answers the Session-in-use dialog with one throttled Enter, dumping nothing at pass level', async () => {
    // Dialog until Enter flips it to ready; the throttle floor delays the first press.
    const { io, presses, dumps } = scriptIo([dialogFrame, readyFrame]);
    expect(await settle(io, { readyMs: 10_000 })).toEqual({ ok: 'ready' });
    expect(presses).toEqual([FIRST_PRESS_AT]);
    expect(dumps).toEqual([]);
  });

  it('spaces repeated dialog Enters at least the throttle apart', async () => {
    // Dialog persists past the first Enter (a re-entry): the second press waits for the throttle.
    const { io, presses } = scriptIo((now) => (now < 7_000 ? dialogFrame : readyFrame));
    expect(await settle(io, { readyMs: 15_000 })).toEqual({ ok: 'ready' });
    expect(presses.length).toBe(2);
    expect(presses[1]! - presses[0]!).toBeGreaterThanOrEqual(UNSOLICITED_ENTER_MS);
  });

  it('presses one Fallback Enter after ~10 s of continuously unrecognized screen', async () => {
    const { io, presses, dumps } = scriptIo([unknownFrame, readyFrame]);
    expect(await settle(io, { readyMs: 20_000 })).toEqual({ ok: 'ready' });
    expect(presses).toEqual([UNKNOWN_SCREEN_FALLBACK_MS]);
    // Every unknown frame is offered to the dump seam; dedupe is the dump writer's job.
    expect(dumps.length).toBeGreaterThanOrEqual(1);
    expect(dumps.every((frame) => frame === unknownFrame)).toBe(true);
  });

  it('re-fires the Fallback Enter every ~10 s window and fails ready_timeout with an excerpt at the deadline', async () => {
    const { io, presses } = scriptIo([unknownFrame]);
    const outcome = await settle(io, { readyMs: 25_000 });
    expect(outcome).toMatchObject({ error: 'ready_timeout' });
    expect('error' in outcome ? outcome.excerpt : undefined).toContain('totally unknown frame');
    expect(presses).toEqual([10_000, 20_000]);
  });

  it('never lets a blank paint-transition frame reset the unknown-screen stretch', async () => {
    // One blank read mid-stretch: the fallback must still fire at ~10 s from the first unknown.
    const { io, presses } = scriptIo((now) => (now === 5 * POLL_MS ? blankFrame : unknownFrame));
    expect(await settle(io, { readyMs: 20_000 })).toMatchObject({ error: 'ready_timeout' });
    expect(presses).toEqual([UNKNOWN_SCREEN_FALLBACK_MS]);
  });

  it('presses Continue exactly once per arrival, then settles ready', async () => {
    const { io, presses } = scriptIo([continueFrame, readyFrame]);
    expect(await settle(io, { readyMs: 10_000 })).toEqual({ ok: 'ready' });
    expect(presses).toEqual([0]);
  });

  it('leaves an idle Instance on the Continue screen untouched', async () => {
    const { io, presses } = scriptIo([continueFrame]);
    expect(await settle(io, { readyMs: 10_000, idle: true })).toEqual({ ok: 'idle' });
    expect(presses).toEqual([]);
  });

  it('dumps a degraded ready frame but still settles ready on it', async () => {
    const { io, presses, dumps } = scriptIo([readyDegradedFrame]);
    expect(await settle(io)).toEqual({ ok: 'ready' });
    expect(dumps).toEqual([readyDegradedFrame]);
    expect(presses).toEqual([]);
  });

  it('dumps degraded dialog frames and still Enters them', async () => {
    const { io, presses, dumps } = scriptIo([dialogDegradedFrame, readyFrame]);
    expect(await settle(io, { readyMs: 10_000 })).toEqual({ ok: 'ready' });
    expect(dumps.every((frame) => frame === dialogDegradedFrame)).toBe(true);
    expect(presses.length).toBe(1);
  });

  it('fails process_exited once the Instance dies', async () => {
    const { io } = scriptIo([unknownFrame], (now) => now < 1_000);
    expect(await settle(io, { readyMs: 10_000 })).toEqual({ error: 'process_exited' });
  });
});
