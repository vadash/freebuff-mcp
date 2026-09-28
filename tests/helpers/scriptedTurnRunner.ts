import type { TurnOutcome, TurnRunnerLike } from '../../src/turnRunner.ts';

/** One scripted `run` outcome; `'hang'` never settles until the test releases it. */
export type RunnerScript = TurnOutcome | 'hang';

/**
 * The TurnRunner stand-in for Supervisor policy tests: canned verdicts, no timers.
 * The Supervisor's Queue, cancel, respawn and reply policies run against this seam;
 * the real TurnRunner's Watchdog behavior lives in `turnRunner.test.ts` instead.
 */
export class ScriptedTurnRunner implements TurnRunnerLike {
  // What the Supervisor handed over and how often it asked the Turn to stop.
  prompts: string[] = [];
  stops = 0;

  private scripts: RunnerScript[] = [];
  private pending: ((outcome: TurnOutcome) => void) | null = null;

  /** Queues `run` outcomes, consumed one per call. */
  script(...scripts: RunnerScript[]): this {
    this.scripts.push(...scripts);
    return this;
  }

  /** Settles a hung `run` with a verdict. */
  settle(outcome: TurnOutcome): void {
    const pending = this.pending;
    this.pending = null;
    pending?.(outcome);
  }

  async run(prompt: string): Promise<TurnOutcome> {
    this.prompts.push(prompt);
    const script = this.scripts.shift();
    if (script === 'hang') {
      const { promise, resolve } = Promise.withResolvers<TurnOutcome>();
      this.pending = resolve;
      return await promise;
    }
    return script ?? { ok: true, answer: `stub turn: ${prompt}` };
  }

  async stop(): Promise<void> {
    this.stops++;
    this.settle({ ok: false, reason: 'cancelled', message: 'task cancelled', screenExcerpt: '' });
  }
}
