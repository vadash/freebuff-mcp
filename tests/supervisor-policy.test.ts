/// <reference lib="es2024" />
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QUEUE_DEPTH } from '../src/config.ts';
import { Supervisor, type SupervisorRequest, type SupervisorResponse } from '../src/supervisor.ts';
import { workspaceDirFor } from '../src/workspace.ts';
import { uniquePipe } from './helpers/harness.ts';
import { ScriptedDriver } from './helpers/scriptedDriver.ts';
import { ScriptedTurnRunner, type RunnerScript } from './helpers/scriptedTurnRunner.ts';

// The captured ready Screen: its classification drives the state-dependent policies
// (status, the /new dance) these tests assert on.
const readyScreen = readFileSync(new URL('./fixtures/screen/0.1.0/ready.ansi', import.meta.url), 'utf8');

let sup: Supervisor | null = null;
let scripted: ScriptedDriver;
let turnRunner: ScriptedTurnRunner;
let pipeName = '';
let workspace = '';
let dirs: { configDir: string; taskDir: string; otherDir: string };

const boot = (scripts: RunnerScript[] = []): ScriptedDriver => {
  dirs = {
    configDir: mkdtempSync(join(tmpdir(), 'pol-config-')),
    taskDir: mkdtempSync(join(tmpdir(), 'pol-task-')),
    otherDir: mkdtempSync(join(tmpdir(), 'pol-other-')),
  };
  scripted = new ScriptedDriver();
  turnRunner = new ScriptedTurnRunner().script(...scripts);
  pipeName = uniquePipe('policy');
  workspace = workspaceDirFor(pipeName);
  sup = new Supervisor({ pipeName, driver: scripted, turnRunner });
  return scripted;
};

// Starts an op without awaiting its reply; canned Turn outcomes drive the machinery.
const request = (supervisor: Supervisor, op: SupervisorRequest): { promise: Promise<SupervisorResponse>; done: () => boolean } => {
  const { promise, resolve } = Promise.withResolvers<SupervisorResponse>();
  let settled = false;
  void supervisor.handle(op, (response) => {
    settled = true;
    resolve(response);
  });
  return { promise, done: () => settled };
};

// Lets the run_one/promote microtasks of a just-issued request settle: one yield to
// the event loop, no wall-clock wait.
const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

// Narrows a failure reply to its error text; every policy test reads this field.
const errorOf = (reply: SupervisorResponse): string => {
  if (!reply.ok && reply.kind === 'error') return reply.error;
  throw new Error(`expected an error reply: ${JSON.stringify(reply)}`);
};

describe('supervisor policies (in-process, canned Turn verdicts)', () => {
  afterEach(() => {
    // No shutdown op here: it process.exit()s the vitest worker.
    sup = null;
    if (workspace !== '') rmSync(workspace, { recursive: true, force: true });
    if (dirs) {
      for (const dir of [dirs.configDir, dirs.taskDir, dirs.otherDir]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers a run_prompt through the injected Turn, handing it the raw prompt', async () => {
    boot([{ ok: true, answer: 'stub answer' }]);
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'hello driver' });
    await expect(task.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'stub answer' });
    // Transport (preamble, big-payload) is the TurnRunner's job, asserted there;
    // the Supervisor hands over the prompt untouched and drives no Driver seam itself.
    expect(turnRunner.prompts).toEqual(['hello driver']);
    expect(scripted.calls.runTask).toBe(0);
  });

  it('replies before respawning behind a watchdog failure, and never resubmits the prompt', async () => {
    boot([{ ok: false, reason: 'frozen', message: 'watchdog failure: frozen: 3 quiet minutes', screenExcerpt: 'x' }]);
    scripted.holdStop();
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'frozen task' });
    // The Supervisor relays the verdict message verbatim onto the wire reply.
    await expect(task.promise).resolves.toEqual({
      ok: false,
      kind: 'error',
      error: 'watchdog failure: frozen: 3 quiet minutes',
    });
    // The reply is already out while the respawn's stop() is still held behind it.
    expect(scripted.calls).toMatchObject({ stop: 1, awaitIdle: 0 });
    expect(turnRunner.prompts).toHaveLength(1);
    scripted.releaseStop();
    await tick();
    expect(scripted.calls).toMatchObject({ stop: 1, awaitIdle: 1 });
    // The next Task runs normally on the respawned Instance.
    turnRunner.script({ ok: true, answer: 'recovered' });
    const next = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after the failure' });
    await expect(next.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'recovered' });
    expect(turnRunner.prompts).toHaveLength(2);
  });

  it('leaves the supervisor stopped when the respawn after a watchdog failure fails, and the next Task spawns', async () => {
    boot([{ ok: false, reason: 'frozen', message: 'watchdog failure: frozen', screenExcerpt: '' }]);
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'first task' });
    await expect(task.promise).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('watchdog failure: frozen'),
    });
    scripted.failNextAwaitIdle('process_exited');
    await tick(); // the respawn behind the failed task: stop(), then awaitIdle() rejects, then kill()
    expect(scripted.alive).toBe(false);
    await expect(request(sup!, { op: 'status' }).promise).resolves.toMatchObject({ ok: true, state: 'stopped' });
    // A failed respawn never fails the next Task: it spawns on demand.
    turnRunner.script({ ok: true, answer: 'after failed respawn' });
    const next = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after failed respawn' });
    await expect(next.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'after failed respawn' });
    expect(turnRunner.prompts).toHaveLength(2);
  });

  it('fails with no_answer, keeps the Instance, and the next Task reuses it', async () => {
    boot([
      { ok: false, reason: 'no_answer', message: 'freebuff driver failure: no_answer: the Turn ended without a fullResponse', screenExcerpt: '' },
    ]);
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'silent task' });
    await expect(task.promise).resolves.toMatchObject({ ok: false, error: expect.stringContaining('no_answer') });
    expect(errorOf(await task.promise)).toContain('fullResponse');
    // No respawn, no kill: the Turn ended cleanly and the Instance stays up.
    expect(scripted.calls).toMatchObject({ stop: 0, kill: 0, awaitIdle: 0, cancelActive: 0 });
    scripted.screen = readyScreen;
    await expect(request(sup!, { op: 'status' }).promise).resolves.toMatchObject({ ok: true, state: 'ready' });
    turnRunner.script({ ok: true, answer: 'second try' });
    const next = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'again' });
    await expect(next.promise).resolves.toMatchObject({ ok: true, kind: 'answer', answer: 'second try' });
    expect(turnRunner.prompts).toHaveLength(2);
  });

  it('kills the Instance on a Driver error and reports the Driver message', async () => {
    boot([{ ok: false, reason: 'driver_error', message: 'freebuff driver failure: dir_mismatch', screenExcerpt: '' }]);
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'misdirected task' });
    await expect(task.promise).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('dir_mismatch'),
    });
    expect(scripted.calls.kill).toBe(1);
    expect(scripted.alive).toBe(false);
    // The next Task spawns on demand.
    turnRunner.script({ ok: true, answer: 'spawned again' });
    const next = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'again' });
    await expect(next.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'spawned again' });
  });

  it('cancels the active task through the runner and the queued survivor completes', async () => {
    boot(['hang', { ok: true, answer: 'survivor answer' }]);
    const victim = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'victim' });
    const survivor = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'survivor' });
    await expect(request(sup!, { op: 'status' }).promise).resolves.toMatchObject({ state: 'busy', queueDepth: 1 });
    await expect(request(sup!, { op: 'cancel_task' }).promise).resolves.toEqual({ ok: true, kind: 'ok' });
    expect(turnRunner.stops).toBe(1);
    await expect(victim.promise).resolves.toEqual({ ok: false, kind: 'error', error: 'task cancelled' });
    await expect(survivor.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'survivor answer' });
    expect(turnRunner.prompts).toHaveLength(2);
  });

  it('drains the queue FIFO, rejects overflow with a position, and purges queued tasks on a retarget', async () => {
    boot([
      'hang', // p1's Turn hangs; `settle` below is its verdict
      { ok: true, answer: 'two' },
      { ok: true, answer: 'three' },
      { ok: true, answer: 'four' },
      { ok: true, answer: 'five' },
      { ok: true, answer: 'after purge' }, // the retargeting task after the purge
    ]);
    const first = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'p1' });
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
    turnRunner.settle({ ok: true, answer: 'one' });
    const replies = await Promise.all([first.promise, ...rest.map((task) => task.promise)]);
    expect(replies.map((reply) => (reply.ok && reply.kind === 'answer' ? reply.answer : ''))).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
    expect(turnRunner.prompts.map((prompt) => prompt.split('\n')[0])).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);

    // Purge: with the /new dance in flight a task queues behind it, and a retarget
    // in that window purges it; the retargeting task then runs against the new directory.
    scripted.screen = readyScreen;
    scripted.holdNewConversation();
    const held = request(sup!, { op: 'new_session' });
    await tick();
    const purged = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'stale queued task' });
    await tick();
    const retarget = request(sup!, { op: 'run_prompt', dir: dirs.otherDir, prompt: 'after purge' });
    await expect(purged.promise).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('retarget purged this queued task: the directory changed'),
    });
    scripted.releaseNewConversation();
    await expect(retarget.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'after purge' });
    await expect(held.promise).resolves.toEqual({ ok: true, kind: 'ok' });
    expect(turnRunner.prompts.some((prompt) => prompt.includes('stale queued task'))).toBe(false);
    await expect(request(sup!, { op: 'status' }).promise).resolves.toMatchObject({
      ok: true,
      state: 'ready',
      targetDir: resolve(dirs.otherDir),
      queueDepth: 0,
    });
  });

  it('replies and kills when the Turn itself throws, and the queue continues', async () => {
    boot();
    let thrown = false;
    sup = new Supervisor({
      pipeName,
      driver: scripted,
      turnRunner: {
        run: (prompt) => {
          if (thrown) return turnRunner.run(prompt);
          thrown = true;
          return Promise.reject(new Error('disk full'));
        },
        stop: () => turnRunner.stop(),
      },
    });
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'thrown task' });
    await expect(task.promise).resolves.toMatchObject({ ok: false, kind: 'error', error: 'disk full' });
    expect(scripted.calls.kill).toBe(1);
    // The caller is freed and the queue continues; the daemon never hangs or dies.
    turnRunner.script({ ok: true, answer: 'next' });
    const next = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after the throw' });
    await expect(next.promise).resolves.toEqual({ ok: true, kind: 'answer', answer: 'next' });
  });

  it('rejects new_session while busy, runs the /new dance when idle, and no-ops with no Instance', async () => {
    boot(['hang']);
    const task = request(sup!, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'busy work' });
    await expect(request(sup!, { op: 'new_session' }).promise).resolves.toMatchObject({
      ok: false,
      error: 'new_session failed: a task is active or queued',
    });
    expect(scripted.calls.newConversation).toBe(0);
    turnRunner.settle({ ok: true, answer: 'busy work done' });
    await task.promise;
    // Idle on the ready Screen: /new goes to the live Instance.
    scripted.screen = readyScreen;
    await expect(request(sup!, { op: 'new_session' }).promise).resolves.toEqual({ ok: true, kind: 'ok' });
    expect(scripted.calls.newConversation).toBe(1);
    // No Instance: nothing is sent and nothing spawns.
    scripted.alive = false;
    await expect(request(sup!, { op: 'new_session' }).promise).resolves.toEqual({ ok: true, kind: 'ok' });
    expect(scripted.calls.newConversation).toBe(1);
    expect(scripted.calls.runTask).toBe(0);
  });
});
