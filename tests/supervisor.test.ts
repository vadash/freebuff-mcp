import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { requestPipe, sendRawLine, sleep, waitForPipe } from '../src/ipc.ts';
import { Supervisor, type SupervisorResponse } from '../src/supervisor.ts';
import { expectExit, makeDirs, pollStatus, startSupervisor, stubPath, uniquePipe, type HarnessDirs, type HarnessOptions, type SupervisorProcess } from './helpers/harness.ts';

let pipeName = '';
let proc: SupervisorProcess | null = null;
let dirs: HarnessDirs;

const boot = (mode: string, extra: Partial<HarnessOptions> = {}): void => {
  proc = startSupervisor({ pipeName, mode, settings: { model: 'opus-test' }, ...dirs, ...extra });
};

const chatsRoot = (taskDir: string): string =>
  join(
    dirs.configDir,
    'manicode',
    'projects',
    `${basename(taskDir)}--${createHash('sha256').update(resolve(taskDir)).digest('hex').slice(0, 12)}`,
    'chats',
  );

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
    expect(parked).toMatchObject({ ok: true, answer: 'stub(deepseek/deepseek-v4.1-flash): hello park' });
    const status = await pollStatus(pipeName, { state: 'parked', activeModel: 'deepseek/deepseek-v4.1-flash', queueDepth: 0 });
    expect(status.boundDir).toBeTruthy();
  }, 60_000);

  it('spawns with the policy head slug merged into settings.json', async () => {
    const modelsFile = join(dirs.configDir, 'models.txt');
    writeFileSync(modelsFile, 'deepseek/deepseek-v4.1-flash\nmimo/mimo-v2.5\n');
    writeFileSync(join(dirs.configDir, 'settings.json'), JSON.stringify({ model: 'opus-test', theme: 'dark' }));
    boot('happy', { modelsFile });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const done = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'policy' },
      30_000,
    );
    expect(done.answer).toBe('stub(deepseek/deepseek-v4.1-flash): policy');
    expect(JSON.parse(readFileSync(join(dirs.configDir, 'settings.json'), 'utf8'))).toEqual({
      model: 'deepseek/deepseek-v4.1-flash',
      theme: 'dark',
    });
    await pollStatus(pipeName, { activeModel: 'deepseek/deepseek-v4.1-flash' });
  }, 60_000);

  it('picks the first valid policy line, skipping empty and invalid lines', async () => {
    const modelsFile = join(dirs.configDir, 'models.txt');
    writeFileSync(modelsFile, '\n   \nnot-a-slug\nmimo/mimo-v2.5\n');
    boot('happy', { modelsFile });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const done = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'skippy' },
      30_000,
    );
    expect(done.answer).toBe('stub(mimo/mimo-v2.5): skippy');
  }, 60_000);

  it('rebind accepts a new directory once idle and the next task runs against the new state', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const before = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'before' },
      30_000,
    );
    expect(before.ok).toBe(true);
    const rebound = await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.otherDir });
    expect(rebound.ok).toBe(true);
    const after = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.otherDir, prompt: 'after' },
      30_000,
    );
    expect(after.ok).toBe(true);
    await pollStatus(pipeName, { boundDir: resolve(dirs.otherDir), state: 'parked' });
    expect(readdirSync(chatsRoot(dirs.otherDir)).length).toBeGreaterThanOrEqual(1);
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
    proc = startSupervisor({ pipeName, mode: 'slow', delayMs: 2000, settings: { model: 'opus-test' }, ...dirs });
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
    await pollStatus(pipeName, { boundDir: resolve(dirs.otherDir), state: 'parked', queueDepth: 0 });
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
      expect(bound).toEqual({ ok: true });
      expect(purged).toHaveLength(2);
      for (const response of purged) {
        if (!('error' in response)) throw new Error(`purged reply without error: ${JSON.stringify(response)}`);
        expect(response.error).toMatch(/rebind purged/i);
      }
      let task: SupervisorResponse | undefined;
      await sup.handle({ op: 'run_prompt', dir: dirs.otherDir, prompt: 'after purge' }, (response) => { task = response; });
      expect(task).toEqual({ ok: true, answer: 'stub(deepseek/deepseek-v4.1-flash): after purge' });
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

  it('fails the task with a clear error when the model policy cannot be written and keeps pumping', async () => {
    const settingsPath = join(dirs.configDir, 'settings.json');
    const sup = new Supervisor({
      pipeName: uniquePipe('policy'),
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
      let bound: SupervisorResponse | undefined;
      await sup.handle({ op: 'bind', dir: dirs.taskDir }, (response) => { bound = response; });
      expect(bound).toEqual({ ok: true });
      chmodSync(settingsPath, 0o444);
      let failed: SupervisorResponse | undefined;
      await sup.handle({ op: 'run_prompt', dir: dirs.taskDir, prompt: 'doomed' }, (response) => { failed = response; });
      if (!failed || !('error' in failed)) throw new Error(`bad failure reply: ${JSON.stringify(failed)}`);
      expect(failed.ok).toBe(false);
      expect(failed.error).toMatch(/model policy failed/i);
      let status: SupervisorResponse | undefined;
      await sup.handle({ op: 'status' }, (response) => { status = response; });
      if (!status || !('state' in status)) throw new Error(`bad status reply: ${JSON.stringify(status)}`);
      expect(status).toMatchObject({ state: 'idle', queueDepth: 0 });
      chmodSync(settingsPath, 0o666);
      let next: SupervisorResponse | undefined;
      await sup.handle({ op: 'run_prompt', dir: dirs.taskDir, prompt: 'recovered' }, (response) => { next = response; });
      expect(next).toEqual({ ok: true, answer: 'stub(deepseek/deepseek-v4.1-flash): recovered' });
    } finally {
      chmodSync(settingsPath, 0o666);
      // driver is compile-time private; named cast to stop the spawned stub.
      const driver = (sup as unknown as { driver: { kill(): void } }).driver;
      driver.kill();
    }
  }, 45_000);

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
    expect(answers).toEqual(['stub(deepseek/deepseek-v4.1-flash): p1', 'stub(deepseek/deepseek-v4.1-flash): p2', 'stub(deepseek/deepseek-v4.1-flash): p3', 'stub(deepseek/deepseek-v4.1-flash): p4', 'stub(deepseek/deepseek-v4.1-flash): p5']);
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
    expect(small).toMatchObject({ ok: true, answer: 'stub(deepseek/deepseek-v4.1-flash): tiny payload' });
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
    expect(survivorResult).toMatchObject({ ok: true, answer: 'stub(deepseek/deepseek-v4.1-flash): survivor' });
    await pollStatus(pipeName, { state: 'parked', queueDepth: 0 });
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
    await pollStatus(pipeName, { state: 'idle' });
    const next = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after reset' },
      30_000,
    );
    expect(next).toMatchObject({ ok: true, answer: 'stub(deepseek/deepseek-v4.1-flash): after reset' });
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
