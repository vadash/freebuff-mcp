/// <reference lib="es2024" />
import { FreebuffDriverError, type DriverFailureReason, type DriverLike } from '../../src/driver.ts';

/** The probe payload the Supervisor relays onto status, verbatim. */
export interface ScriptedProbe {
  hourSessionMinutesLeft: number | null;
  freebucksBalance: number | null;
  freebucksDaily: number | null;
}

/** One scripted `runTask` outcome; `hang` never settles until the test releases it. */
export type RunScript =
  | { kind: 'answer'; answer: string }
  | { kind: 'fail'; reason: DriverFailureReason; detail?: string }
  | { kind: 'hang' };

/**
 * The Driver stand-in for in-process Supervisor policy tests (C4 seam): implements
 * `DriverLike` and simulates exactly the Supervisor's branching inputs — screen text
 * per read, Turn end with and without a `fullResponse` (`no_answer`), mid-task exit
 * (`process_exited`), the `needsLogin` flag, `newestLogSize` growth, kill/stop
 * flipping liveness, and any `FreebuffDriverError` on demand (e.g. dir_mismatch).
 * The test mutates its fields between virtual-time steps and scripts `runTask`
 * outcomes; every injected failure is a real FreebuffDriverError.
 */
export class ScriptedDriver implements DriverLike {
  // Branching inputs, mutated by the test between time steps.
  alive = true;
  screen = '';
  logSize = 0;
  needsLoginFlag = false;
  pid = 4242;
  probeResult: ScriptedProbe = { hourSessionMinutesLeft: null, freebucksBalance: null, freebucksDaily: null };

  // What the Supervisor submitted and how often it drove each seam call.
  prompts: string[] = [];
  dirs: string[] = [];
  calls = { runTask: 0, cancelActive: 0, newConversation: 0, awaitIdle: 0, stop: 0, kill: 0 };

  private scripts: RunScript[] = [];
  private hung: { resolve: (answer: string) => void; reject: (error: FreebuffDriverError) => void } | null = null;
  private awaitIdleFailure: FreebuffDriverError | null = null;
  private holdConversations = false;
  private conversationRelease: (() => void) | null = null;

  // -- test-side controls --------------------------------------------------

  /** Queues `runTask` outcomes, consumed one per call. */
  script(...scripts: RunScript[]): this {
    this.scripts.push(...scripts);
    return this;
  }

  /** Settles a hung `runTask` with an Answer. */
  settleRunTask(answer: string): void {
    const hung = this.hung;
    this.hung = null;
    hung?.resolve(answer);
  }

  /** Fails a hung `runTask` with a real FreebuffDriverError (e.g. a mid-task exit). */
  failRunTask(reason: DriverFailureReason, detail?: string): void {
    const hung = this.hung;
    this.hung = null;
    hung?.reject(new FreebuffDriverError(reason, detail));
  }

  /** Makes the next `awaitIdle` throw, so the Supervisor's respawn fails. */
  failNextAwaitIdle(reason: DriverFailureReason = 'process_exited'): void {
    this.awaitIdleFailure = new FreebuffDriverError(reason);
  }

  /** Makes `newConversation` wait for `releaseNewConversation` (the /new dance in flight). */
  holdNewConversation(): void {
    this.holdConversations = true;
  }

  releaseNewConversation(): void {
    this.conversationRelease?.();
    this.conversationRelease = null;
  }

  // -- DriverLike -----------------------------------------------------------

  isAlive(): boolean {
    return this.alive;
  }

  screenText(): string {
    return this.screen;
  }

  needsLogin(): boolean {
    return this.needsLoginFlag;
  }

  instancePid(): number | null {
    return this.alive ? this.pid : null;
  }

  probe(): ScriptedProbe {
    return this.probeResult;
  }

  newestLogSize(_dir: string): number {
    return this.logSize;
  }

  kill(): void {
    this.calls.kill++;
    this.alive = false;
  }

  async stop(_timeoutMs?: number): Promise<void> {
    this.calls.stop++;
    this.alive = false;
  }

  async cancelActive(): Promise<void> {
    this.calls.cancelActive++;
  }

  async newConversation(): Promise<void> {
    this.calls.newConversation++;
    if (!this.holdConversations) return;
    await new Promise<void>((resolve) => {
      this.conversationRelease = resolve;
    });
    this.holdConversations = false;
  }

  async awaitIdle(_dir: string): Promise<'idle' | 'ready'> {
    this.calls.awaitIdle++;
    if (this.awaitIdleFailure !== null) {
      const failure = this.awaitIdleFailure;
      this.awaitIdleFailure = null;
      throw failure;
    }
    return 'ready';
  }

  async runTask(dir: string, prompt: string): Promise<string> {
    this.calls.runTask++;
    this.dirs.push(dir);
    this.prompts.push(prompt);
    const script = this.scripts.shift() ?? { kind: 'answer', answer: `stub(DeepSeek V4.1 Flash): ${prompt}` };
    if (script.kind === 'fail') throw new FreebuffDriverError(script.reason, script.detail);
    if (script.kind === 'hang') {
      return await new Promise<string>((resolve, reject) => {
        this.hung = { resolve, reject };
      });
    }
    return script.answer;
  }
}
