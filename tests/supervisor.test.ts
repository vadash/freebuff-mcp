import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestPipe, sendRawLine, waitForPipe } from '../src/ipc.ts';
import { expectExit, makeDirs, pollStatus, startSupervisor, uniquePipe, type HarnessDirs, type SupervisorProcess } from './helpers/harness.ts';

let pipeName = '';
let proc: SupervisorProcess | null = null;
let dirs: HarnessDirs;

const boot = (mode: string): void => {
  proc = startSupervisor({ pipeName, mode, settings: { model: 'opus-test' }, ...dirs });
};

describe('supervisor daemon (named-pipe protocol)', () => {
  beforeEach(() => {
    pipeName = uniquePipe('sup');
    dirs = makeDirs({ model: 'opus-test' });
  });

  afterEach(async () => {
    if (proc) {
      await requestPipe(pipeName, { op: 'shutdown' }).catch(() => {});
      await expectExit(proc);
    }
  });

  it('answers status before any bind and rejects bind to a missing directory', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const status = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(status).toMatchObject({ ok: true, state: 'idle', boundDir: null, queueDepth: 0, activeModel: null });
    const bad = await requestPipe<Record<string, unknown>>(pipeName, { op: 'bind', dir: `${dirs.taskDir}/nope` });
    expect(bad.ok).toBe(false);
  }, 30_000);

  it('binds, runs a task, parks at the picker, and reports the active model only after spawn', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const bound = await requestPipe<Record<string, unknown>>(pipeName, { op: 'bind', dir: dirs.taskDir });
    expect(bound.ok).toBe(true);
    const parked = await requestPipe<Record<string, unknown>>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'hello park' },
      30_000,
    );
    expect(parked).toMatchObject({ ok: true, answer: 'stub(opus-test): hello park' });
    const status = await pollStatus(pipeName, { state: 'parked', activeModel: 'opus-test', queueDepth: 0 });
    expect(status.boundDir).toBeTruthy();
  }, 60_000);

  it('replies with an error for unknown ops and malformed json lines', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const unknown = await requestPipe<Record<string, unknown>>(pipeName, { op: 'nope' });
    expect(unknown.ok).toBe(false);
    const malformed = JSON.parse(await sendRawLine(pipeName, 'this is not json')) as Record<string, unknown>;
    expect(malformed.ok).toBe(false);
  }, 30_000);

  it('rejects bind while a task is active', async () => {
    proc = startSupervisor({ pipeName, mode: 'slow', delayMs: 2000, settings: { model: 'opus-test' }, ...dirs });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const task = requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'long task' }, 30_000);
    await pollStatus(pipeName, { state: 'busy' });
    const rejected = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'bind', dir: dirs.otherDir });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/bind rejected/i);
    expect((await task).ok).toBe(true);
  }, 30_000);

  it('reports busy with a queue position once the queue is full and drains in FIFO order', async () => {
    proc = startSupervisor({ pipeName, mode: 'slow', delayMs: 1200, settings: { model: 'opus-test' }, ...dirs });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const answers: string[] = [];
    const tasks = ['p1', 'p2', 'p3', 'p4', 'p5'].map((prompt) =>
      requestPipe<{ ok: boolean; answer?: string }>(
        pipeName,
        { op: 'run_prompt', dir: dirs.taskDir, prompt },
        60_000,
      ).then((r) => answers.push(r.answer ?? '')),
    );
    await pollStatus(pipeName, { queueDepth: 4 });
    const overflow = await requestPipe<{ ok: boolean; busy?: boolean; position?: number }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'overflow' },
    );
    expect(overflow.ok).toBe(false);
    expect(overflow.busy).toBe(true);
    expect(overflow.position).toBe(5);
    await Promise.all(tasks);
    expect(answers).toEqual(['stub(opus-test): p1', 'stub(opus-test): p2', 'stub(opus-test): p3', 'stub(opus-test): p4', 'stub(opus-test): p5']);
  }, 90_000);

  it('fails a task on timeout and frees the session', async () => {
    proc = startSupervisor({
      pipeName,
      mode: 'slow',
      delayMs: 8000,
      taskTimeoutMs: 1500,
      settings: { model: 'opus-test' },
      ...dirs,
    });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const failed = await requestPipe<{ ok: boolean; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'never finishes' },
      30_000,
    );
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/timed out/i);
    await pollStatus(pipeName, { state: 'idle', queueDepth: 0 });
  }, 30_000);
});
