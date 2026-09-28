// The settle loop as a deep module: the whole "wait until the Instance reaches a
// settled screen" policy behind one function. The Driver passes a PTY-backed SettleIo;
// tests pass a scripted one with a virtual clock — two adapters, one real seam.
import { POLL_MS, UNKNOWN_SCREEN_FALLBACK_MS, UNSOLICITED_ENTER_MS } from './config.ts';
import { classifyScreen } from './protocol/screen.ts';

/** The loop's only effects, injected. press() is Enter — the one keystroke this policy
 *  ever sends. dump() receives every unknown/degraded frame; dedupe is the dump
 *  writer's job. now()/sleep() carry the clock, so tests run in virtual time. */
export interface SettleIo {
  read(): string;
  press(): void | Promise<void>;
  sleep(ms: number): void | Promise<void>;
  now(): number;
  dump(text: string): void;
  alive(): boolean;
}

export interface SettleOpts {
  /** Whole settle deadline; expiry fails with `ready_timeout`. */
  readyMs: number;
  /** true before a Task (an idle Instance at the Continue screen is left untouched);
   *  false while a Task arrival may press Continue. */
  idle: boolean;
  /** The target directory the Screen's dir line must show; anything else is dir_mismatch. */
  expectedDir?: string;
}

export type SettleOutcome =
  | { ok: 'idle' | 'ready' }
  | { error: 'needs_login' | 'dir_mismatch' | 'process_exited' | 'ready_timeout'; excerpt?: string };

/** Waits for a settled screen: `ready`, or `idle` at the Welcome or Continue screen.
 *  One classifyScreen per frame (the one screen oracle, ADR-0002). Presses Enter only
 *  through one shared throttle (dialog re-entries + the Fallback Enter), presses
 *  Continue once per Task arrival, and dumps unknown/degraded frames as drift record. */
export const awaitSettled = async (io: SettleIo, opts: SettleOpts): Promise<SettleOutcome> => {
  const deadline = io.now() + opts.readyMs;
  let lastEnterAt = 0;
  let continuePressed = false;
  // Issue #23: start of the current stretch of continuously unrecognized Screen.
  let unknownSince: number | null = null;
  // One throttle for every unsolicited Enter: the Session-in-use dialog's re-entries
  // and the Fallback Enter.
  const unsolicitedEnter = async (): Promise<boolean> => {
    const now = io.now();
    if (now - lastEnterAt <= UNSOLICITED_ENTER_MS) return false;
    await io.press();
    lastEnterAt = io.now();
    return true;
  };
  while (io.now() < deadline) {
    if (!io.alive()) return { error: 'process_exited' };
    const text = io.read();
    // One screen oracle: one classifyScreen per frame names the screen (tolerant
    // recognition) and parses it (strict); nothing here matches raw literals, so
    // Drift on any screen degrades through the same table doctor reads.
    const { recognition, verdict } = classifyScreen(text, opts.expectedDir);
    // Issue #31: degraded frames are dumped like unknown ones — dialog frames too,
    // the Freeze-key dedupe bounds its repaints — into the same per-version folder,
    // so normal use collects the specimens the corpus needs. The dump is the drift
    // record `status` reads.
    if (recognition.screen === null || recognition.level === 'degraded') io.dump(text);
    if (recognition.screen === 'login gate') return { error: 'needs_login' };
    if (recognition.screen === 'Session-in-use dialog') {
      // The Session-in-use dialog clears on ENTER, and any dialog frame is a
      // recognized screen: seeing it stops any running unknown-screen fallback.
      unknownSince = null;
      await unsolicitedEnter();
      await io.sleep(POLL_MS);
      continue;
    }
    if (recognition.screen === null) {
      // Issue #23: after ~10 s of continuously unrecognized Screen, press Enter once
      // and let the loop re-evaluate; any recognized screen restarts the wait.
      const now = io.now();
      if (unknownSince === null) unknownSince = now;
      if (now - unknownSince >= UNKNOWN_SCREEN_FALLBACK_MS && (await unsolicitedEnter())) unknownSince = now;
    } else if (recognition.screen !== 'blank') {
      // The blank-frame paint-transition rule lives inside recognizeScreen.
      unknownSince = null;
    }
    if (recognition.screen === 'ready') {
      if (verdict.banner === null) return { error: 'dir_mismatch' };
      return { ok: 'ready' };
    }
    if (recognition.screen === 'Continue' && !continuePressed) {
      if (opts.idle) {
        // ADR-0001 #3: the Continue screen counts as idle; the supervisor presses it
        // only when a task arrives.
        return { ok: 'idle' };
      }
      // Issue #12: the Continue screen clears on one ENTER per task arrival; an idle
      // Instance at the Continue screen must not be touched.
      continuePressed = true;
      await io.press();
      await io.sleep(POLL_MS);
    } else if (recognition.screen === 'Welcome screen') {
      // ADR-0004: the input box on the Welcome screen accepts a prompt directly —
      // the first message starts the Hour session.
      if (verdict.banner === null) return { error: 'dir_mismatch' };
      return { ok: 'idle' };
    }
    await io.sleep(POLL_MS);
  }
  return { error: 'ready_timeout', excerpt: io.read().replace(/\n{2,}/g, '\n').slice(0, 2000) };
};
