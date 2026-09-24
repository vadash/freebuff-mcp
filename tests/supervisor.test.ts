import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { requestPipe, sendRawLine, waitForPipe } from '../src/ipc.ts';
import { sleep } from '../src/util.ts';
import { Supervisor, type SupervisorResponse } from '../src/supervisor.ts';
import { expectExit, makeDirs, pollStatus, startSupervisor, stubPath, uniquePipe, type HarnessDirs, type HarnessOptions, type SupervisorProcess } from './helpers/harness.ts';

let pipeName = '';
let proc: SupervisorProcess | null = null;
let dirs: HarnessDirs;

const boot = (mode: string, extra: Partial<HarnessOptions> = {}): void => {
  proc = startSupervisor({ pipeName, mode, ...dirs, ...extra });
};

const chatsRoot = (taskDir: string): string => join(dirs.configDir, 'projects', basename(taskDir), 'chats');

const latestFirstMsg = (taskDir: string): string => {
  const root = chatsRoot(taskDir);
  let newest = { mtimeMs: 0, msg: '' };
  for (const dir of readdirSync(root)) {
    const logPath = join(root, dir, 'log.jsonl');
    const stat = statSync(logPath);
    if (stat.mtimeMs < newest.mtimeMs) continue;
    const parsed: unknown = JSON.parse(readFileSync(logPath, 'utf8').split('\n')[0] ?? '{}');
    const msg =
      parsed !== null && typeof parsed === 'object' && 'msg' in parsed && typeof parsed.msg === 'string'
        ? parsed.msg
        : '';
    newest = { mtimeMs: stat.mtimeMs, msg };
  }
  return newest.msg;
};

describe('supervisor daemon (named-pipe protocol)', () => {
  beforeEach(() => {
    pipeName = uniquePipe('sup');
    dirs = makeDirs();
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
    expect(status).toMatchObject({ ok: true, state: 'stopped', boundDir: null, queueDepth: 0, activeModel: null });
    const bad = await requestPipe<Record<string, unknown>>(pipeName, { op: 'bind', dir: `${dirs.taskDir}/nope` });
    expect(bad.ok).toBe(false);
  }, 30_000);

  it('spawns at bind, lands at the picker, and idles at ready after each task without respawning', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const bound = await requestPipe<Record<string, unknown>>(pipeName, { op: 'bind', dir: dirs.taskDir });
    expect(bound).toMatchObject({ ok: true, kind: 'ok' });
    await pollStatus(pipeName, { state: 'picker', boundDir: resolve(dirs.taskDir), activeModel: null });
    const lockBefore = readFileSync(join(dirs.configDir, 'freebuff.lock'), 'utf8');
    const first = await requestPipe<Record<string, unknown>>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'first task' },
      30_000,
    );
    expect(first).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): first task' });
    await pollStatus(pipeName, { state: 'ready', activeModel: 'DeepSeek V4.1 Flash', queueDepth: 0 });
    const second = await requestPipe<Record<string, unknown>>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'second task' },
      30_000,
    );
    expect(second).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): second task' });
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
    expect(readFileSync(join(dirs.configDir, 'freebuff.lock'), 'utf8')).toBe(lockBefore);
  }, 60_000);

  it('never sends /end-session across bind, tasks, cancel, and respawn', async () => {
    boot('slow', { delayMs: 1200 });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'picker' });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'one' }, 30_000)).ok).toBe(true);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'two' }, 30_000)).ok).toBe(true);
    const victim = requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'victim' }, 30_000);
    await pollStatus(pipeName, { state: 'busy' });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'cancel_task' }, 30_000)).ok).toBe(true);
    expect(await victim).toMatchObject({ ok: false });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'new_session' })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'stopped' });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after respawn' }, 30_000)).ok).toBe(true);
    expect(existsSync(join(dirs.configDir, 'end-session.log'))).toBe(false);
  }, 90_000);

  it('respawns into the unexpired Hour session at ready after a kill', async () => {
    // ADR-0001 §5: the bind lock only guards a different directory; a
    // same-directory rebind is an unconditional success, so respawning a dead
    // Instance in the same dir resumes the wall-clock Hour session.
    boot('happy', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1' } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 432 });
    const stubPid = Number.parseInt(readFileSync(join(dirs.configDir, 'freebuff.lock'), 'utf8').trim(), 10);
    spawn('taskkill', ['/PID', String(stubPid), '/T', '/F']);
    await pollStatus(pipeName, { state: 'stopped', hourSessionMinutesLeft: 432 });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 432, queueDepth: 0 });
  }, 60_000);

  it('leaves the continue screen alone while idle and presses enter for the next task', async () => {
    boot('expire');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'picker' });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'first' }, 30_000)).ok).toBe(true);
    await pollStatus(pipeName, { state: 'picker', queueDepth: 0 });
    await sleep(1200);
    expect((await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' })).state).toBe('picker');
    const second = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'second' },
      30_000,
    );
    expect(second).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): second' });
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
  }, 60_000);

  it('rebind accepts a new directory once 30 minutes or less remain and the next task runs against the new state', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1', FREEBUFF_STUB_COUNTDOWN_MIN: '30' } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 30 });
    const before = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'before' },
      30_000,
    );
    expect(before.ok).toBe(true);
    const rebound = await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.otherDir });
    expect(rebound.ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', boundDir: resolve(dirs.otherDir) });
    const after = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.otherDir, prompt: 'after' },
      30_000,
    );
    expect(after.ok).toBe(true);
    await pollStatus(pipeName, { boundDir: resolve(dirs.otherDir), state: 'ready', queueDepth: 0 });
    expect(readdirSync(chatsRoot(dirs.otherDir)).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('locks bind to a different directory while more than 30 minutes of the Hour session remain', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1', FREEBUFF_STUB_COUNTDOWN_MIN: '45' } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 45 });
    const locked = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'bind', dir: dirs.otherDir });
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatch(/bound_dir_locked/);
    expect(locked.error).toContain(resolve(dirs.taskDir));
    expect(locked.error).toMatch(/unlocks in 15 minutes/);
    await pollStatus(pipeName, { state: 'ready', boundDir: resolve(dirs.taskDir), queueDepth: 0 });
  }, 60_000);

  it('locks bind to a different directory while the Hour session outlives a dead idle Instance', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1', FREEBUFF_STUB_COUNTDOWN_MIN: '45' } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 45 });
    // ADR-0001 §5: the Hour session is wall-clock and survives Instance death; the
    // last painted screen still shows the countdown after an idle crash.
    const stubPid = Number.parseInt(readFileSync(join(dirs.configDir, 'freebuff.lock'), 'utf8').trim(), 10);
    spawn('taskkill', ['/PID', String(stubPid), '/T', '/F']);
    await pollStatus(pipeName, { state: 'stopped', hourSessionMinutesLeft: 45 });
    const locked = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'bind', dir: dirs.otherDir });
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatch(/bound_dir_locked/);
    expect(locked.error).toMatch(/unlocks in 15 minutes/);
    await pollStatus(pipeName, { state: 'stopped', boundDir: resolve(dirs.taskDir), queueDepth: 0 });
  }, 60_000);

  it('allows switching directories once 30 minutes or less of the Hour session remain', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1', FREEBUFF_STUB_COUNTDOWN_MIN: '30' } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 30 });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.otherDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', boundDir: resolve(dirs.otherDir) });
  }, 60_000);

  it('allows switching directories while no Hour session is running', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'picker', hourSessionMinutesLeft: null });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.otherDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'picker', boundDir: resolve(dirs.otherDir) });
  }, 60_000);

  it('treats a same-directory rebind as a no-op without respawning', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'picker' });
    const lockBefore = readFileSync(join(dirs.configDir, 'freebuff.lock'), 'utf8');
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await sleep(1200);
    expect(readFileSync(join(dirs.configDir, 'freebuff.lock'), 'utf8')).toBe(lockBefore);
    await pollStatus(pipeName, { state: 'picker', boundDir: resolve(dirs.taskDir), queueDepth: 0 });
  }, 60_000);

  it('replies with an error for unknown ops and malformed json lines', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const unknown = await requestPipe<Record<string, unknown>>(pipeName, { op: 'nope' });
    expect(unknown.ok).toBe(false);
    const malformed = JSON.parse(await sendRawLine(pipeName, 'this is not json')) as Record<string, unknown>;
    expect(malformed.ok).toBe(false);
  }, 30_000);

  it('rejects bind only while a task is active and rebinds once the queue drains', async () => {
    proc = startSupervisor({
      pipeName,
      mode: 'slow',
      delayMs: 2000,
      ...dirs,
      stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1', FREEBUFF_STUB_COUNTDOWN_MIN: '30' },
    });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const task = requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'long task' }, 30_000);
    await pollStatus(pipeName, { state: 'busy' });
    const queued = requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'queued' }, 30_000);
    await pollStatus(pipeName, { queueDepth: 1 });
    const rejected = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'bind', dir: dirs.otherDir });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/bind rejected/i);
    expect(rejected.error).toMatch(/active/i);
    expect((await queued).ok).toBe(true);
    expect((await task).ok).toBe(true);
    const rebound = await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.otherDir });
    expect(rebound.ok).toBe(true);
    const after = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.otherDir, prompt: 'after rebind' },
      30_000,
    );
    expect(after.ok).toBe(true);
    await pollStatus(pipeName, { boundDir: resolve(dirs.otherDir), state: 'ready', queueDepth: 0 });
  }, 60_000);

  it('rebind purges queued tasks and the next task runs against the new directory', async () => {
    const sup = new Supervisor({
      pipeName: uniquePipe('purge'),
      driver: {
        executable: process.execPath,
        argsPrefix: [stubPath],
        configDir: dirs.configDir,
        env: { FREEBUFF_STUB_MODE: 'happy' },
        keepAlive: true,
      },
      taskTimeoutMs: 30_000,
    });
    try {
      // pump() promotes a queued task synchronously, so a queued-but-idle state is
      // unreachable through the request path; seed the queue to pin the purge contract.
      type Seeded = { prompt: string; reply: (response: SupervisorResponse) => void };
      // queue is compile-time private; named cast so the test can pin the purge contract.
      const queue = (sup as unknown as { queue: Seeded[] }).queue;
      const purged: SupervisorResponse[] = [];
      queue.push(
        { prompt: 'stale-1', reply: (response) => purged.push(response) },
        { prompt: 'stale-2', reply: (response) => purged.push(response) },
      );
      let bound: SupervisorResponse | undefined;
      await sup.handle({ op: 'bind', dir: dirs.otherDir }, (response) => { bound = response; });
      expect(bound).toEqual({ ok: true, kind: 'ok' });
      expect(purged).toHaveLength(2);
      for (const response of purged) {
        if (!('error' in response)) throw new Error(`purged reply without error: ${JSON.stringify(response)}`);
        expect(response.error).toMatch(/rebind purged/i);
      }
      let task: SupervisorResponse | undefined;
      await sup.handle({ op: 'run_prompt', dir: dirs.otherDir, prompt: 'after purge' }, (response) => { task = response; });
      expect(task).toEqual({ ok: true, kind: 'answer', answer: 'stub(DeepSeek V4.1 Flash): after purge' });
      let status: SupervisorResponse | undefined;
      await sup.handle({ op: 'status' }, (response) => { status = response; });
      if (!status || !('state' in status)) throw new Error(`bad status reply: ${JSON.stringify(status)}`);
      expect(status).toMatchObject({ boundDir: resolve(dirs.otherDir), queueDepth: 0 });
    } finally {
      // no shutdown op here: it process.exit()s the vitest worker
      // driver is compile-time private; named cast to stop the spawned stub.
      const driver = (sup as unknown as { driver: { kill(): void } }).driver;
      driver.kill();
    }
  }, 45_000);

  it('reports busy with a queue position once the queue is full and drains in FIFO order', async () => {
    proc = startSupervisor({ pipeName, mode: 'slow', delayMs: 1200, ...dirs });
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
    expect(answers).toEqual(['stub(DeepSeek V4.1 Flash): p1', 'stub(DeepSeek V4.1 Flash): p2', 'stub(DeepSeek V4.1 Flash): p3', 'stub(DeepSeek V4.1 Flash): p4', 'stub(DeepSeek V4.1 Flash): p5']);
  }, 90_000);

  it('routes prompts above the paste threshold through a temp file and keeps small prompts on the paste path', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const big = 'x'.repeat(100 * 1024);
    const task = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: big },
      60_000,
    );
    const tempPath = join(dirs.taskDir, '.freebuff-task-1.md');
    const deadline = Date.now() + 10_000;
    while (!existsSync(tempPath)) {
      if (Date.now() > deadline) throw new Error(`temp file never appeared at ${tempPath}`);
      await sleep(100);
    }
    expect(readFileSync(tempPath, 'utf8')).toBe(big);
    const done = await task;
    expect(done.ok).toBe(true);
    expect(done.answer).toContain('.freebuff-task-1.md');
    expect(done.answer).not.toContain('xxxxx');
    expect(existsSync(tempPath)).toBe(false);
    expect(latestFirstMsg(dirs.taskDir)).toMatch(/Read the instructions in \.freebuff-task-1\.md/);
    const small = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'tiny payload' },
      30_000,
    );
    expect(small).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): tiny payload' });
    expect(latestFirstMsg(dirs.taskDir)).toBe('tiny payload');
    expect(existsSync(join(dirs.taskDir, '.freebuff-task-2.md'))).toBe(false);
  }, 90_000);

  it('cancel_task errors when no task is active', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const none = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'cancel_task' });
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/no task is active/i);
  }, 30_000);

  it('cancel_task cancels the active task and the next queued task completes', async () => {
    boot('slow', { delayMs: 6000 });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const victim = requestPipe<{ ok: boolean; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'victim' },
      30_000,
    );
    await pollStatus(pipeName, { state: 'busy' });
    const survivor = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'survivor' },
      60_000,
    );
    await pollStatus(pipeName, { queueDepth: 1 });
    const cancelled = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'cancel_task' }, 30_000);
    expect(cancelled.ok).toBe(true);
    const victimResult = await victim;
    expect(victimResult.ok).toBe(false);
    expect(victimResult.error).toMatch(/cancel/i);
    const survivorResult = await survivor;
    expect(survivorResult).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): survivor' });
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
  }, 90_000);

  it('new_session errors while busy and resets an idle session', async () => {
    boot('slow', { delayMs: 2500 });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const running = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'running' },
      60_000,
    );
    await pollStatus(pipeName, { state: 'busy' });
    const busy = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'new_session' });
    expect(busy.ok).toBe(false);
    expect(busy.error).toMatch(/active or queued/i);
    expect((await running).ok).toBe(true);
    const idle = await requestPipe<{ ok: boolean }>(pipeName, { op: 'new_session' });
    expect(idle.ok).toBe(true);
    await pollStatus(pipeName, { state: 'stopped' });
    const next = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after reset' },
      30_000,
    );
    expect(next).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): after reset' });
  }, 90_000);

  it('fails a task on timeout and frees the session', async () => {
    proc = startSupervisor({
      pipeName,
      mode: 'slow',
      delayMs: 8000,
      taskTimeoutMs: 1500,
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
    await pollStatus(pipeName, { state: 'stopped', queueDepth: 0 });
  }, 30_000);

  it('respawns after a mid-turn crash, re-runs the task, and keeps the queue going', async () => {
    boot('kill-mid-turn');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const first = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'first task' },
      60_000,
    );
    const second = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'second task' },
      60_000,
    );
    await pollStatus(pipeName, { queueDepth: 1 });
    await expect(first).resolves.toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): first task' });
    await expect(second).resolves.toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): second task' });
  }, 90_000);

  it('fails a task with reason crashed once respawns are exhausted', async () => {
    boot('kill-always');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const doomed = await requestPipe<{ ok: boolean; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'doomed' },
      60_000,
    );
    expect(doomed.ok).toBe(false);
    expect(doomed.error).toMatch(/crashed/);
    await pollStatus(pipeName, { state: 'stopped', queueDepth: 0 });
  }, 60_000);

  it('restarts a frozen driver instead of timing out and the task still completes', async () => {
    proc = startSupervisor({
      pipeName,
      mode: 'freeze',
      freezeMs: 1200,
      taskTimeoutMs: 20_000,
      ...dirs,
    });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const started = Date.now();
    const done = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'thaw' },
      60_000,
    );
    expect(done).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): thaw' });
    expect(Date.now() - started).toBeLessThan(30_000);
    const root = chatsRoot(dirs.taskDir);
    const logs = readdirSync(root).map((dir) => readFileSync(join(root, dir, 'log.jsonl'), 'utf8'));
    expect(logs.join('\n').split('"msg":"thaw"').length - 1).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it('claims a stale pid lock and refuses to spawn while the lock holder lives', async () => {
    const lockPath = join(dirs.configDir, 'freebuff.lock');
    writeFileSync(lockPath, String(process.pid));
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const held = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'bind', dir: dirs.taskDir }, 30_000);
    expect(held.ok).toBe(false);
    expect(held.error).toMatch(/lock_held/);
    const dead = spawn(process.execPath, ['-e', '']);
    const gone = Promise.withResolvers<void>();
    dead.once('exit', () => gone.resolve());
    await gone.promise;
    writeFileSync(lockPath, String(dead.pid));
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const done = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'stale ok' },
      60_000,
    );
    expect(done).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): stale ok' });
  }, 60_000);

  it('reports countdown, freebucks, and update fields on status', async () => {
    writeFileSync(join(dirs.configDir, 'freebuff-metadata.json'), JSON.stringify({ version: '0.0.190' }));
    proc = startSupervisor({ pipeName, mode: 'slow', delayMs: 2500, ...dirs });
    await waitForPipe(pipeName, 10_000);
    const before = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(before).toMatchObject({ hourSessionMinutesLeft: null, freebucksDaily: null, needsLogin: false, updatePending: null });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    // Idling at the Model picker after bind: no Countdown on screen, balance visible.
    await pollStatus(pipeName, { state: 'picker' });
    const picker = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(picker).toMatchObject({ hourSessionMinutesLeft: null, freebucksDaily: 25, updatePending: { running: '0.0.186', onDisk: '0.0.190' } });
    const task = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'status fields' },
      30_000,
    );
    await pollStatus(pipeName, { state: 'busy' });
    // While the ready box is up the Countdown ticks; it paints shortly after the picker clears.
    const busyDeadline = Date.now() + 10_000;
    let busy: Record<string, unknown> = {};
    while (Date.now() < busyDeadline) {
      busy = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
      if (busy.hourSessionMinutesLeft === 432) break;
      await sleep(150);
    }
    expect(busy).toMatchObject({ hourSessionMinutesLeft: 432, freebucksDaily: null });
    await task;
    await pollStatus(pipeName, { state: 'ready' });
    const status = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(status).toMatchObject({ hourSessionMinutesLeft: 432, freebucksDaily: null, needsLogin: false });
    writeFileSync(join(dirs.configDir, 'freebuff-metadata.json'), JSON.stringify({ version: '0.0.100' }));
    const stale = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(stale).toMatchObject({ updatePending: null });
  }, 60_000);

  it('reports needs_login from bind and returns to stopped', async () => {
    boot('needs-login');
    await waitForPipe(pipeName, 10_000);
    const bound = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'bind', dir: dirs.taskDir }, 30_000);
    expect(bound.ok).toBe(false);
    expect(bound.error).toMatch(/needs_login/);
    await pollStatus(pipeName, { needsLogin: true, state: 'stopped', queueDepth: 0 });
    const status = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(status).toMatchObject({ hourSessionMinutesLeft: null, freebucksDaily: null });
  }, 30_000);
});

describe('model pick rule at the picker (ADR-0001 #6)', () => {
  beforeEach(() => {
    pipeName = uniquePipe('pick');
    dirs = makeDirs();
  });

  afterEach(async () => {
    if (proc) {
      await requestPipe(pipeName, { op: 'shutdown' }).catch(() => {});
      await expectExit(proc);
    }
  });

  const pickCase = (
    name: string,
    picker: Array<{ name: string; price: number }>,
    balance: string,
    expected: string,
  ): void => {
    it(name, async () => {
      boot('happy', { stubEnv: { FREEBUFF_STUB_PICKER: JSON.stringify(picker), FREEBUFF_STUB_FREEBUCKS: balance } });
      await waitForPipe(pipeName, 10_000);
      expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
      const done = await requestPipe<{ ok: boolean; answer?: string }>(
        pipeName,
        { op: 'run_prompt', dir: dirs.taskDir, prompt: 'pick' },
        30_000,
      );
      expect(done).toMatchObject({ ok: true, answer: `stub(${expected}): pick` });
      await pollStatus(pipeName, { state: 'ready', activeModel: expected, queueDepth: 0 });
    }, 60_000);
  };

  pickCase(
    'picks the first deepseek entry when the balance covers its price',
    [{ name: 'DeepSeek-V3', price: 5 }, { name: 'GLM-4.7', price: 0 }],
    '20/25',
    'DeepSeek-V3',
  );
  pickCase(
    'skips an unaffordable deepseek for glm',
    [{ name: 'DeepSeek-V3', price: 5 }, { name: 'GLM-4.7', price: 0 }],
    '3/25',
    'GLM-4.7',
  );
  pickCase(
    'falls back to mimo without deepseek or glm entries',
    [{ name: 'Kimi-K2', price: 0 }, { name: 'MiMo', price: 0 }, { name: 'Qwen3', price: 0 }],
    '20/25',
    'MiMo',
  );
  pickCase(
    'takes the top entry when none of the three is listed',
    [{ name: 'Kimi-K2', price: 0 }, { name: 'Qwen3', price: 0 }],
    '20/25',
    'Kimi-K2',
  );
  pickCase(
    'matches mixed-case names',
    [{ name: 'MiMo', price: 0 }, { name: 'DEEPSEEK-V3', price: 9 }, { name: 'GLM', price: 0 }],
    '3/25',
    'GLM',
  );
});
