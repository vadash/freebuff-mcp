/// <reference lib="es2024" />
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_DEPTH } from '../src/config.ts';
import { defaultDriverOptions } from '../src/driver.ts';
import { Supervisor, type SupervisorRequest, type SupervisorResponse } from '../src/supervisor.ts';
import { PROMPT_PREAMBLE, workspaceDirFor } from '../src/workspace.ts';
import { uniquePipe } from './helpers/harness.ts';
import { ScriptedDriver } from './helpers/scriptedDriver.ts';

// Spec'd policy knobs, explicit so each test reads as its scenario.
const TASK_TIMEOUT_MS = 20 * 60_000;
const STEP_MS = 1_000;

// The captured ready Screen: the ticking Countdown line (`1h left · …`) is what the
// freeze tests mutate, and its ready classification drives state-dependent policies.
const readyScreen = readFileSync(new URL('./fixtures/screen/0.1.0/ready.ansi', import.meta.url), 'utf8');

let sup: Supervisor | null = null;
let scripted: ScriptedDriver;
let pipeName = '';
let workspace = '';
let dirs: { configDir: string; taskDir: string; otherDir: string };

const boot = (): ScriptedDriver => {
  dirs = {
    configDir: mkdtempSync(join(tmpdir(), 'freebuff-policy-config-')),
    taskDir: mkdtempSync(join(tmpdir(), 'freebuff-policy-task-')),
    otherDir: mkdtempSync(join(tmpdir(), 'freebuff-policy-other-')),
  };
  scripted = new ScriptedDriver();
  pipeName = uniquePipe('policy');
  workspace = workspaceDirFor(pipeName);
  sup = new Supervisor({
    pipeName,
    driver: scripted,
    // status reads driverOptions.configDir even with an injected Driver (screenDrift);
    // point it at the test's dir so a pending dump on the dev machine can't leak in.
    driverOptions: { ...defaultDriverOptions(), configDir: dirs.configDir },
    taskTimeoutMs: TASK_TIMEOUT_MS,
    errorLogPath: join(dirs.configDir, 'errors.jsonl'),
  });
  return scripted;
};

// Starts an op without awaiting its reply; virtual time drives the machinery.
const request = (supervisor: Supervisor, op: SupervisorRequest): { promise: Promise<SupervisorResponse>; done: () => boolean } => {
  const { promise, resolve } = Promise.withResolvers<SupervisorResponse>();
  let settled = false;
  void supervisor.handle(op, (response) => {
    settled = true;
    resolve(response);
  });
  return { promise, done: () => settled };
};

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(STEP_MS);

// Narrows a failure reply to its error text; every watchdog test reads this field.
const errorOf = (reply: SupervisorResponse): string => {
  if (!reply.ok && reply.kind === 'error') return reply.error;
  throw new Error(`expected an error reply: ${JSON.stringify(reply)}`);
};

// Advances virtual time until `done` turns true or the budget is exhausted; `eachStep`
// runs before every step so the test can mutate the scripted Driver mid-Turn.
const advanceUntil = async (done: () => boolean, budgetMs: number, eachStep?: (goneMs: number) => void): Promise<void> => {
  for (let gone = 0; gone < budgetMs && !done(); gone += STEP_MS) {
    eachStep?.(gone);
    await flush();
  }
  if (!done()) throw new Error(`virtual time budget of ${budgetMs}ms exhausted before the reply`);
};

describe('supervisor policies (in-process, virtual time)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // No shutdown op here: it process.exit()s the vitest worker.
    sup = null;
    if (workspace !== '') rmSync(workspace, { recursive: true, force: true });
    if (dirs) {
      for (const dir of [dirs.configDir, dirs.taskDir, dirs.otherDir]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers a run_prompt through the injected Driver with the preamble composed', async () => {
    boot().script({ kind: 'answer', answer: 'stub(DeepSeek V4.1 Flash): hello driver' });
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'hello driver' });
    await advanceUntil(task.done, 60_000);
    await expect(task.promise).resolves.toEqual({
      ok: true,
      kind: 'answer',
      answer: 'stub(DeepSeek V4.1 Flash): hello driver',
    });
    expect(scripted.prompts).toEqual([`${PROMPT_PREAMBLE}\nhello driver`]);
    // The Instance always runs in the per-pipe workspace; the caller's repo is the junction inside it.
    expect(scripted.dirs).toEqual([workspace]);
  });

  it('fails a task frozen after the virtual 3 minutes when only the Countdown ticks, and never resubmits it', async () => {
    boot().script({ kind: 'hang' });
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'frozen task' });
    await advanceUntil(task.done, 6 * 60_000, (gone) => {
      // The Countdown ticks every step while the Chat store never grows; freezeKey
      // strips timer lines, so the ticking must never reset the freeze clock.
      scripted.screen = readyScreen.replace('1h left', `${Math.max(0, 179 - Math.floor(gone / STEP_MS))}m left`);
    });
    await expect(task.promise).resolves.toMatchObject({
      ok: false,
      kind: 'error',
      error: expect.stringContaining('watchdog failure: frozen: no Screen or Chat store change for 3 minutes'),
    });
    const error = errorOf(await task.promise);
    // The verdict carries the last Screen lines — including the ticking Countdown itself.
    expect(error).toContain('Enter a coding task');
    expect(error).toContain(' left');
    // Issue #16: one attempt per Task — the prompt is never resubmitted.
    expect(scripted.calls.runTask).toBe(1);
  });

  it('fails a task at its 20-minute deadline while the Screen and Chat store keep changing', async () => {
    boot().script({ kind: 'hang' });
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'endless task' });
    await advanceUntil(task.done, 21 * 60_000, (gone) => {
      // Real Turn output: fresh non-timer Screen lines and log growth keep resetting
      // the freeze clock, so only the deadline can end this Task.
      scripted.screen = `${readyScreen}\nstreaming chunk ${Math.floor(gone / STEP_MS)}`;
      scripted.logSize += 100;
    });
    await expect(task.promise).resolves.toMatchObject({
      ok: false,
      kind: 'error',
      error: expect.stringContaining('watchdog failure: deadline: still running at its 20 minutes deadline'),
    });
    expect(scripted.calls.runTask).toBe(1);
    // The Watchdog respawns the Instance behind the failed Task.
    await flush();
    expect(scripted.calls).toMatchObject({ stop: 1, awaitIdle: 1 });
  });

  it('fails a task crashed when freebuff exits mid-turn, respawns, and never resubmits the prompt', async () => {
    boot().script({ kind: 'hang' });
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'doomed task' });
    await flush();
    scripted.screen = readyScreen;
    scripted.alive = false;
    scripted.failRunTask('process_exited');
    await advanceUntil(task.done, 60_000);
    await expect(task.promise).resolves.toMatchObject({
      ok: false,
      kind: 'error',
      error: expect.stringContaining('watchdog failure: crashed: freebuff exited mid-task'),
    });
    const error = errorOf(await task.promise);
    expect(error).toContain('Enter a coding task');
    expect(scripted.calls.runTask).toBe(1);
    await flush();
    expect(scripted.calls).toMatchObject({ stop: 1, awaitIdle: 1 });
    // The next Task spawns a fresh Instance and runs normally.
    scripted.script({ kind: 'answer', answer: 'recovered' });
    const next = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after the crash' });
    await advanceUntil(next.done, 60_000);
    await expect(next.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'recovered' });
    expect(scripted.prompts[1]).not.toBe(scripted.prompts[0]);
  });

  it('fails a task whose Turn ends without an Answer with no_answer, keeping the Instance', async () => {
    boot().script({ kind: 'fail', reason: 'no_answer', detail: 'the Turn ended without a fullResponse' });
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'silent task' });
    await advanceUntil(task.done, 60_000);
    await expect(task.promise).resolves.toMatchObject({
      ok: false,
      kind: 'error',
      error: expect.stringContaining('no_answer'),
    });
    expect(errorOf(await task.promise)).toContain('fullResponse');
    // No respawn, no kill: the Turn ended cleanly and the Instance stays up.
    expect(scripted.calls).toMatchObject({ runTask: 1, stop: 0, kill: 0, awaitIdle: 0, cancelActive: 0 });
    expect(scripted.alive).toBe(true);
    scripted.screen = readyScreen;
    await expect(request(sup!, { op: 'status' }).promise).resolves.toMatchObject({ ok: true, state: 'ready' });
    // The next Task reuses the kept Instance.
    scripted.script({ kind: 'answer', answer: 'second try' });
    const next = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'again' });
    await advanceUntil(next.done, 60_000);
    await expect(next.promise).resolves.toMatchObject({ ok: true, kind: 'answer', answer: 'second try' });
    expect(scripted.calls.runTask).toBe(2);
  });

  it('cancels the active task mid-Turn and the queued survivor completes', async () => {
    boot().script({ kind: 'hang' }, { kind: 'answer', answer: 'survivor answer' });
    const victim = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'victim' });
    await flush();
    const survivor = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'survivor' });
    await expect(request(sup!, { op: 'status' }).promise).resolves.toMatchObject({ state: 'busy', queueDepth: 1 });
    await expect(request(sup!, { op: 'cancel_task' }).promise).resolves.toEqual({ ok: true, kind: 'ok' });
    expect(scripted.calls.cancelActive).toBe(1);
    scripted.failRunTask('process_exited');
    await advanceUntil(survivor.done, 60_000);
    await expect(victim.promise).resolves.toEqual({ ok: false, kind: 'error', error: 'task cancelled' });
    await expect(survivor.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'survivor answer' });
    expect(scripted.prompts).toHaveLength(2);
  });

  it('leaves the supervisor stopped when the respawn after a watchdog failure fails, and the next Task spawns', async () => {
    boot().script({ kind: 'hang' });
    scripted.screen = readyScreen;
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'first task' });
    await advanceUntil(task.done, 5 * 60_000); // static Screen and Chat store: frozen
    await expect(task.promise).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('watchdog failure: frozen'),
    });
    scripted.failNextAwaitIdle('process_exited');
    await flush(); // the respawn behind the failed task: stop(), then awaitIdle() rejects, then kill()
    expect(scripted.alive).toBe(false);
    await expect(request(sup!, { op: 'status' }).promise).resolves.toMatchObject({ ok: true, state: 'stopped' });
    // A failed respawn never fails the next Task: it spawns on demand.
    scripted.script({ kind: 'answer', answer: 'after failed respawn' });
    const next = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after failed respawn' });
    await advanceUntil(next.done, 60_000);
    await expect(next.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'after failed respawn' });
    expect(scripted.calls.runTask).toBe(2);
  });

  it('drains the queue FIFO, rejects overflow with a position, and purges queued tasks on a retarget', async () => {
    boot().script(
      { kind: 'hang' }, // p1's Turn hangs; `settleRunTask` below is its Answer
      { kind: 'answer', answer: 'two' },
      { kind: 'answer', answer: 'three' },
      { kind: 'answer', answer: 'four' },
      { kind: 'answer', answer: 'five' },
      { kind: 'answer', answer: 'after purge' }, // the retargeting task after the purge
    );
    const first = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'p1' });
    await flush();
    const rest = ['p2', 'p3', 'p4', 'p5'].map((prompt) => request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt }));
    await expect(request(sup!, { op: 'status' }).promise).resolves.toMatchObject({ state: 'busy', queueDepth: QUEUE_DEPTH });
    // QUEUE_DEPTH: one more queued task overflows with its 1-based position.
    await expect(request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'overflow' }).promise).resolves.toMatchObject({
      ok: false,
      kind: 'busy',
      position: QUEUE_DEPTH + 1,
      error: `queue full: ${QUEUE_DEPTH} tasks queued ahead`,
    });
    // FIFO: settle the active Turn; the queue promotes in submission order.
    scripted.settleRunTask('one');
    await advanceUntil(rest[rest.length - 1]!.done, 60_000);
    const replies = await Promise.all([first.promise, ...rest.map((task) => task.promise)]);
    expect(replies.map((reply) => (reply.ok && reply.kind === 'answer' ? reply.answer : ''))).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
    expect(scripted.prompts.map((prompt) => prompt.split('\n')[1])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);

    // Purge: with the /new dance in flight a task queues behind it, and a retarget
    // in that window purges it; the retargeting task then runs against the new directory.
    scripted.screen = readyScreen;
    scripted.holdNewConversation();
    const held = request(sup!, { op: 'new_session' });
    await flush();
    const purged = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'stale queued task' });
    await flush();
    const retarget = request(sup!, { op: 'run_prompt', dir: dirs.otherDir, prompt: 'after purge' });
    await expect(purged.promise).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('retarget purged this queued task: the directory changed'),
    });
    scripted.releaseNewConversation();
    await advanceUntil(retarget.done, 60_000);
    await expect(retarget.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'after purge' });
    await expect(held.promise).resolves.toEqual({ ok: true, kind: 'ok' });
    expect(scripted.prompts.some((prompt) => prompt.includes('stale queued task'))).toBe(false);
    await expect(request(sup!, { op: 'status' }).promise).resolves.toMatchObject({
      ok: true,
      state: 'ready',
      targetDir: resolve(dirs.otherDir),
      queueDepth: 0,
    });
  });

  it('prepends the repo preamble to every submitted prompt', async () => {
    boot().script({ kind: 'answer', answer: 'ack' }, { kind: 'answer', answer: 'ack2' });
    const first = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'first line\nsecond line' });
    await advanceUntil(first.done, 60_000);
    await first.promise;
    expect(scripted.prompts[0]).toBe(`${PROMPT_PREAMBLE}\nfirst line\nsecond line`);
    const second = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'tiny' });
    await advanceUntil(second.done, 60_000);
    await second.promise;
    expect(scripted.prompts[1]).toBe(`${PROMPT_PREAMBLE}\ntiny`);
  });

  it('routes a prompt above the paste threshold through a temp file in the workspace', async () => {
    boot().script({ kind: 'hang' });
    const big = 'x'.repeat(100 * 1024);
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: big });
    await flush();
    const tempPath = join(workspace, '.freebuff-task-1.md');
    expect(existsSync(tempPath)).toBe(true);
    expect(readFileSync(tempPath, 'utf8')).toBe(big);
    expect(scripted.prompts[0]).toBe(
      `${PROMPT_PREAMBLE}\nRead the instructions in .freebuff-task-1.md in the current directory and follow them.`,
    );
    scripted.settleRunTask('done');
    await advanceUntil(task.done, 60_000);
    await expect(task.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'done' });
    expect(existsSync(tempPath)).toBe(false);
  });

  it('rejects new_session while busy, runs the /new dance when idle, and no-ops with no Instance', async () => {
    boot().script({ kind: 'hang' });
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'busy work' });
    await flush();
    await expect(request(sup!, { op: 'new_session' }).promise).resolves.toMatchObject({
      ok: false,
      error: 'new_session failed: a task is active or queued',
    });
    expect(scripted.calls.newConversation).toBe(0);
    scripted.settleRunTask('busy work done');
    await advanceUntil(task.done, 60_000);
    // Idle on the ready Screen: /new goes to the live Instance.
    scripted.screen = readyScreen;
    await expect(request(sup!, { op: 'new_session' }).promise).resolves.toEqual({ ok: true, kind: 'ok' });
    expect(scripted.calls.newConversation).toBe(1);
    // No Instance: nothing is sent and nothing spawns.
    scripted.alive = false;
    await expect(request(sup!, { op: 'new_session' }).promise).resolves.toEqual({ ok: true, kind: 'ok' });
    expect(scripted.calls.newConversation).toBe(1);
    expect(scripted.calls.runTask).toBe(1);
  });
});
