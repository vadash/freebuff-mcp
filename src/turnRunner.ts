/// <reference lib="es2024" />
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ERROR_LOG_PATH, ERROR_LOG_POLL_MS, FAILURE_SCREEN_LINES, FREEZE_POLL_MAX_MS, FREEZE_POLL_MIN_MS, FREEZE_THRESHOLD_MS, PASTE_THRESHOLD_BYTES, TASK_TIMEOUT_MS } from './config.ts';
import type { DriverLike } from './driver.ts';
import { FreebuffDriverError } from './driver.ts';
import { errorLines, freezeKey, screenExcerpt } from './protocol/screen.ts';
import { errorMessage } from './util.ts';
import { PROMPT_PREAMBLE } from './workspace.ts';

/**
 * The timers the TurnRunner runs on; injected so tests drive freeze and deadline
 * on a virtual clock instead of fake global timers. Production passes `realClock`.
 */
export interface Clock {
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (id: unknown) => void;
  readonly setInterval: (fn: () => void, ms: number) => unknown;
  readonly clearInterval: (id: unknown) => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as NodeJS.Timeout),
};

export type TurnFailureReason = 'deadline' | 'frozen' | 'crashed' | 'cancelled' | 'no_answer' | 'driver_error';

/** The one Turn's verdict. The failure taxonomy is the type: no errors cross this seam. */
export type TurnOutcome =
  | { ok: true; answer: string }
  | { ok: false; reason: TurnFailureReason; message: string; screenExcerpt: string };

/** The Supervisor's seam onto a Turn: run one Task to a verdict, or stop it. */
export interface TurnRunnerLike {
  run(prompt: string): Promise<TurnOutcome>;
  stop(): Promise<void>;
}

export interface TurnRunnerConfig {
  driver: DriverLike;
  workspace: string;
  taskTimeoutMs?: number;
  freezeMs?: number;
  errorLogPath?: string;
  clock?: Clock;
}

const formatDuration = (ms: number): string => {
  if (ms % 60_000 !== 0) return `${ms / 1000}s`;
  const minutes = ms / 60_000;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
};

// A stopped Turn reads no Screen and carries no excerpt: the Supervisor replies the
// literal 'task cancelled' for this reason.
const cancelledOutcome: TurnOutcome = { ok: false, reason: 'cancelled', message: 'task cancelled', screenExcerpt: '' };

/**
 * One Task's Turn, from submit to verdict (CONTEXT: TurnRunner). Runs on the
 * injected Driver and Clock: composes the prompt (fixed preamble; over the paste
 * threshold as a temp-file referral in the workspace), owns the Watchdog for the
 * Turn's duration, and classifies the outcome. Never resubmits: a half-run coding
 * task is not idempotent (issue #16). A serial seam: the Supervisor runs one
 * `run` at a time; `stop` is the only external mutator of cancellation.
 */
export class TurnRunner implements TurnRunnerLike {
  private readonly driver: DriverLike;
  private readonly workspace: string;
  private readonly taskTimeoutMs: number;
  private readonly freezeMs: number;
  private readonly errorLogPath: string;
  private readonly clock: Clock;
  private tempCounter = 0;
  // Set by stop(); classified into 'cancelled' when the rejected work surfaces.
  private stopped = false;

  constructor(config: TurnRunnerConfig) {
    this.driver = config.driver;
    this.workspace = config.workspace;
    this.taskTimeoutMs = config.taskTimeoutMs ?? TASK_TIMEOUT_MS;
    this.freezeMs = config.freezeMs ?? FREEZE_THRESHOLD_MS;
    this.errorLogPath = config.errorLogPath ?? ERROR_LOG_PATH;
    this.clock = config.clock ?? realClock;
  }

  async run(rawPrompt: string): Promise<TurnOutcome> {
    this.stopped = false;
    let tempFile: string | null = null;
    try {
      let prompt = rawPrompt;
      if (Buffer.byteLength(prompt, 'utf8') > PASTE_THRESHOLD_BYTES) {
        tempFile = join(this.workspace, `.freebuff-task-${++this.tempCounter}.md`);
        writeFileSync(tempFile, prompt);
        prompt = `Read the instructions in ${basename(tempFile)} in the current directory and follow them.`;
      }
      // The Instance's cwd is the workspace, never the caller's repo.
      const work = this.driver.runTask(this.workspace, `${PROMPT_PREAMBLE}\n${prompt}`);
      work.catch(() => {}); // the race below owns the verdict; never an unhandled rejection
      const { promise: tripped, resolve: trip } = Promise.withResolvers<TurnOutcome>();
      const deadline = this.clock.setTimeout(
        () => trip(this.failure('deadline', `still running at its ${formatDuration(this.taskTimeoutMs)} deadline`)),
        this.taskTimeoutMs,
      );
      const freeze = this.watchFreeze(() =>
        trip(this.failure('frozen', `no Screen or Chat store change for ${formatDuration(this.freezeMs)}`)),
      );
      const errors = this.watchErrors();
      try {
        const settled = await Promise.race([
          work.then(
            (answer): TurnOutcome => ({ ok: true, answer }),
            (error): TurnOutcome => this.classify(error),
          ),
          tripped,
        ]);
        // A stop() overrides any Watchdog verdict: a cancelled Task is never a respawn.
        if (!settled.ok && this.stopped && settled.reason !== 'cancelled') {
          return cancelledOutcome;
        }
        return settled;
      } finally {
        this.clock.clearTimeout(deadline);
        freeze.stop();
        errors.stop();
      }
    } finally {
      if (tempFile !== null) rmSync(tempFile, { force: true });
    }
  }

  /** Marks the Turn cancelled and asks the Driver to stop it gracefully (ESC, Ctrl-C). */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.driver.cancelActive();
  }

  // One attempt per Task: a rejected `runTask` classifies once, right here.
  private classify(error: unknown): TurnOutcome {
    if (this.stopped) return cancelledOutcome;
    if (error instanceof FreebuffDriverError) {
      if (error.reason === 'process_exited') return this.failure('crashed', 'freebuff exited mid-task');
      // The Turn ended cleanly without a `fullResponse`; keep the Instance.
      if (error.reason === 'no_answer') return { ok: false, reason: 'no_answer', message: error.message, screenExcerpt: '' };
    }
    return { ok: false, reason: 'driver_error', message: errorMessage(error), screenExcerpt: '' };
  }

  // Frozen: neither the Screen (minus the Countdown and Freebucks lines) nor the Chat
  // store changed for the freeze threshold. The tick never masks a freeze: freezeKey
  // strips timer lines, so a ticking Countdown resets nothing (issue #31).
  private watchFreeze(onFrozen: () => void): { stop: () => void } {
    let lastLog = this.driver.newestLogSize(this.workspace);
    let lastScreen = freezeKey(this.driver.observe().screenText);
    let lastChange = this.clock.now();
    const pollMs = Math.min(FREEZE_POLL_MAX_MS, Math.max(FREEZE_POLL_MIN_MS, Math.floor(this.freezeMs / 4)));
    const timer = this.clock.setInterval(() => {
      // A stopped Turn's verdict is 'cancelled'; its Screen reads are pointless.
      if (this.stopped) {
        this.clock.clearInterval(timer);
        return;
      }
      const log = this.driver.newestLogSize(this.workspace);
      const screen = freezeKey(this.driver.observe().screenText);
      if (log !== lastLog || screen !== lastScreen) {
        lastLog = log;
        lastScreen = screen;
        lastChange = this.clock.now();
        return;
      }
      if (this.clock.now() - lastChange >= this.freezeMs) {
        this.clock.clearInterval(timer);
        onFrozen();
      }
    }, pollMs);
    return { stop: () => this.clock.clearInterval(timer) };
  }

  // Issue #17: Screen lines carrying a known error Marker during a Turn are appended to
  // the error log for later analysis; nothing acts on them. A line counts once it shows
  // more often than when the Turn started (earlier Turns' copies stay on the Screen), and
  // is logged once per Turn.
  private watchErrors(): { stop: () => void } {
    const workspace = this.workspace;
    const tally = (): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const line of errorLines(this.driver.observe().screenText)) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    // A dead Instance's last Screen is not what the respawned one will show.
    const baseline = this.driver.observe().alive ? tally() : new Map<string, number>();
    const logged = new Set<string>();
    const scan = (): void => {
      const lines = [...tally()]
        .filter(([line, count]) => count > (baseline.get(line) ?? 0) && !logged.has(line))
        .map(([line]) => line);
      if (lines.length === 0) return;
      for (const line of lines) logged.add(line);
      try {
        mkdirSync(dirname(this.errorLogPath), { recursive: true });
        appendFileSync(this.errorLogPath, JSON.stringify({ time: new Date().toISOString(), workspace, lines }) + '\n');
      } catch {
        // The log is best-effort; it never fails a Task.
      }
    };
    const timer = this.clock.setInterval(scan, ERROR_LOG_POLL_MS);
    // A final scan catches lines printed just before the Turn ended.
    return {
      stop: () => {
        this.clock.clearInterval(timer);
        scan();
      },
    };
  }

  // The verdict carries the last Screen lines for the caller, as the reply string.
  private failure(reason: TurnFailureReason, detail: string): TurnOutcome {
    const excerpt = screenExcerpt(this.driver.observe().screenText, FAILURE_SCREEN_LINES);
    return {
      ok: false,
      reason,
      screenExcerpt: excerpt,
      message: `watchdog failure: ${reason}: ${detail}\nlast screen lines:\n${excerpt}`,
    };
  }
}
