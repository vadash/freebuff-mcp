import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { requestPipe, sendRawLine, waitForPipe } from '../src/ipc.ts';
import { READY_PROMPT } from '../src/protocol/markers.ts';
import { sleep } from '../src/util.ts';
import { Supervisor, type SupervisorResponse } from '../src/supervisor.ts';
import { errorLogPath, expectExit, makeDirs, pollStatus, startSupervisor, stubPath, trimRows, uniquePipe, type HarnessDirs, type HarnessOptions, type SupervisorProcess } from './helpers/harness.ts';

let pipeName = '';
let proc: SupervisorProcess | null = null;
let dirs: HarnessDirs;

const boot = (mode: string, extra: Partial<HarnessOptions> = {}): void => {
  proc = startSupervisor({ pipeName, mode, ...dirs, ...extra });
};

// Issue #18: what the stub received, from FREEBUFF_STUB_INPUT_LOG.
type StubInput = { event: 'spawn'; pid: number } | { event: 'paste' | 'submit'; text: string };
const inputLogPath = (): string => join(dirs.configDir, 'stub-input.jsonl');
const stubInputs = (): StubInput[] =>
  existsSync(inputLogPath())
    ? readFileSync(inputLogPath(), 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as StubInput)
    : [];
const inputsOf = (event: StubInput['event']): StubInput[] => stubInputs().filter((entry) => entry.event === event);
const textsOf = (event: 'paste' | 'submit'): string[] => inputsOf(event).map((entry) => (entry as { text: string }).text);

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

  it('doctor skips the live check with no Instance and reports ok at the picker and at ready', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect(await requestPipe(pipeName, { op: 'doctor' })).toEqual({ ok: true, kind: 'doctor', skipped: true, failures: [] });
    await requestPipe(pipeName, { op: 'bind', dir: dirs.taskDir });
    await pollStatus(pipeName, { state: 'picker' });
    expect(await requestPipe(pipeName, { op: 'doctor' })).toEqual({ ok: true, kind: 'doctor', skipped: false, failures: [] });
    await requestPipe(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'task' }, 30_000);
    await pollStatus(pipeName, { state: 'ready' });
    expect(await requestPipe(pipeName, { op: 'doctor' })).toEqual({ ok: true, kind: 'doctor', skipped: false, failures: [] });
  }, 30_000);

  it('doctor names the drifted Marker when the live Screen renders altered wording', async () => {
    boot('drift', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1' } });
    await waitForPipe(pipeName, 10_000);
    await requestPipe(pipeName, { op: 'bind', dir: dirs.taskDir });
    await pollStatus(pipeName, { state: 'ready' });
    const report = await requestPipe<{ failures: string[] }>(pipeName, { op: 'doctor' });
    expect(report).toMatchObject({ ok: true, kind: 'doctor', skipped: false });
    expect(report.failures).toEqual([expect.stringMatching(/^COUNTDOWN_REGEX: /)]);
  }, 30_000);

  // Issue #21: the screen op returns the exact flattened Screen the Driver and Watchdog read.
  it('screen op returns the flattened Screen while stopped, at the picker, busy and ready', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect(await requestPipe(pipeName, { op: 'screen' })).toEqual({ ok: true, kind: 'screen', screen: '' });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'picker' });
    const atPicker = await requestPipe<{ screen: string }>(pipeName, { op: 'screen' });
    expect(atPicker).toMatchObject({ ok: true, kind: 'screen' });
    // Pipe seam: the stub replays the captured picker fixture verbatim under its
    // banner + directory header, and the op hands back exactly that flattened text.
    const fixture = readFileSync(new URL('./fixtures/screen/picker-expanded.ansi', import.meta.url), 'utf8')
      .replace('\x1b[2J\x1b[H\n', '');
    expect(trimRows(atPicker.screen).endsWith(trimRows(fixture))).toBe(true);
    const task = requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'screen states' }, 30_000);
    await pollStatus(pipeName, { state: 'busy' });
    // Busy is set before the settle loop picks the model; poll until the ready box paints.
    const busyDeadline = Date.now() + 10_000;
    let busyScreen = '';
    while (Date.now() < busyDeadline) {
      busyScreen = (await requestPipe<{ screen: string }>(pipeName, { op: 'screen' })).screen;
      if (busyScreen.includes(READY_PROMPT)) break;
      await sleep(150);
    }
    expect(busyScreen).toContain(READY_PROMPT);
    expect((await task).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready' });
    expect((await requestPipe<{ screen: string }>(pipeName, { op: 'screen' })).screen).toContain(READY_PROMPT);
  }, 30_000);

  it('dumps the unknown settle screen once, under the metadata version folder', async () => {
    writeFileSync(join(dirs.configDir, 'freebuff-metadata.json'), JSON.stringify({ version: '0.0.190' }));
    boot('unknown', { readyMs: 2_500 });
    await waitForPipe(pipeName, 10_000);
    const binding = requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'bind', dir: dirs.taskDir }, 30_000);
    await pollStatus(pipeName, { state: 'spawning' });
    // The screen op works while the settle loop is living through the unknown screen;
    // before the stub's first paint it legitimately returns ''.
    const spawnDeadline = Date.now() + 10_000;
    let spawnScreen = '';
    while (Date.now() < spawnDeadline) {
      spawnScreen = (await requestPipe<{ screen: string }>(pipeName, { op: 'screen' })).screen;
      if (spawnScreen.includes('Quantum flux calibration panel')) break;
      await sleep(150);
    }
    expect(spawnScreen).toContain('Quantum flux calibration panel');
    expect((await binding).ok).toBe(false);
    await pollStatus(pipeName, { state: 'stopped' });
    const versionDir = join(dirs.configDir, 'screen-dumps', '0.0.190');
    const dumps = readdirSync(versionDir);
    expect(dumps).toHaveLength(1);
    expect(readFileSync(join(versionDir, dumps[0]!), 'utf8')).toContain('Quantum flux calibration panel');
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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

  it('locks bind to a different directory while more than 30 minutes of the Hour session remain', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1', FREEBUFF_STUB_COUNTDOWN_MIN: '45' } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 45 });
    const locked = await requestPipe<{ ok: boolean; kind?: string; boundDir?: string; unlocksInMinutes?: number }>(
      pipeName,
      { op: 'bind', dir: dirs.otherDir },
    );
    expect(locked.ok).toBe(false);
    expect(locked.kind).toBe('bound_dir_locked');
    expect(locked.boundDir).toBe(resolve(dirs.taskDir));
    expect(locked.unlocksInMinutes).toBe(15);
    await pollStatus(pipeName, { state: 'ready', boundDir: resolve(dirs.taskDir), queueDepth: 0 });
  }, 30_000);

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
    const locked = await requestPipe<{ ok: boolean; kind?: string; boundDir?: string; unlocksInMinutes?: number }>(
      pipeName,
      { op: 'bind', dir: dirs.otherDir },
    );
    expect(locked.ok).toBe(false);
    expect(locked.kind).toBe('bound_dir_locked');
    expect(locked.boundDir).toBe(resolve(dirs.taskDir));
    expect(locked.unlocksInMinutes).toBe(15);
    await pollStatus(pipeName, { state: 'stopped', boundDir: resolve(dirs.taskDir), queueDepth: 0 });
  }, 30_000);

  it('allows switching directories once 30 minutes or less of the Hour session remain', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1', FREEBUFF_STUB_COUNTDOWN_MIN: '30' } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 30 });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.otherDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', boundDir: resolve(dirs.otherDir) });
  }, 30_000);

  it('allows switching directories while no Hour session is running', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'picker', hourSessionMinutesLeft: null });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.otherDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'picker', boundDir: resolve(dirs.otherDir) });
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
      errorLogPath: errorLogPath(dirs),
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
  }, 30_000);

  it('reports busy with a queue position once the queue is full and drains in FIFO order', async () => {
    proc = startSupervisor({ pipeName, mode: 'slow', delayMs: 1200, ...dirs });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const answers: string[] = [];
    const tasks = ['p1', 'p2', 'p3', 'p4', 'p5'].map((prompt) =>
      requestPipe<{ ok: boolean; answer?: string }>(
        pipeName,
        { op: 'run_prompt', dir: dirs.taskDir, prompt },
        30_000,
      ).then((r) => answers.push(r.answer ?? '')),
    );
    await pollStatus(pipeName, { queueDepth: 4 });
    const overflow = await requestPipe<{ ok: boolean; position?: number }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'overflow' },
    );
    expect(overflow.ok).toBe(false);
    expect(overflow.position).toBe(5);
    await Promise.all(tasks);
    expect(answers).toEqual(['stub(DeepSeek V4.1 Flash): p1', 'stub(DeepSeek V4.1 Flash): p2', 'stub(DeepSeek V4.1 Flash): p3', 'stub(DeepSeek V4.1 Flash): p4', 'stub(DeepSeek V4.1 Flash): p5']);
  }, 30_000);

  it('routes prompts above the paste threshold through a temp file and keeps small prompts on the paste path', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const big = 'x'.repeat(100 * 1024);
    const task = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: big },
      30_000,
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
  }, 30_000);

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
      30_000,
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
  }, 30_000);

  it('new_session errors while busy and sends /new to the idle Instance without respawning it', async () => {
    boot('slow', { delayMs: 2500, stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const running = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'running' },
      30_000,
    );
    await pollStatus(pipeName, { state: 'busy' });
    const busy = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'new_session' });
    expect(busy.ok).toBe(false);
    expect(busy.error).toMatch(/active or queued/i);
    expect((await running).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready' });
    expect(textsOf('submit')).toEqual(['/new', 'running']);
    const idle = await requestPipe<{ ok: boolean }>(pipeName, { op: 'new_session' });
    expect(idle.ok).toBe(true);
    expect(textsOf('submit')).toEqual(['/new', 'running', '/new']);
    await sleep(600);
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
    const next = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after reset' },
      30_000,
    );
    expect(next).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): after reset' });
    expect(inputsOf('spawn')).toHaveLength(1);
  }, 30_000);

  it('new_session at the picker sends nothing and leaves the Instance alone', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'picker' });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'new_session' })).ok).toBe(true);
    await sleep(600);
    await pollStatus(pipeName, { state: 'picker' });
    expect(textsOf('submit')).toEqual([]);
    expect(inputsOf('spawn')).toHaveLength(1);
  }, 30_000);

  // Issue #18: prompts go in as one bracketed paste and one submit, so a newline in the
  // prompt never submits it early.
  it('pastes a multi-line prompt between bracketed-paste markers and submits it exactly once', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const prompt = 'first line\nsecond line\n\n  indented fourth line\r\nlast line';
    const done = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt },
      30_000,
    );
    expect(done).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${prompt}` });
    expect(textsOf('paste')).toEqual([prompt]);
    expect(textsOf('submit')).toEqual(['/new', prompt]);
    expect(latestFirstMsg(dirs.taskDir)).toBe(prompt);
  }, 30_000);

  it('fails a Task whose Turn ends without an Answer with no_answer, keeping the Instance', async () => {
    boot('no-answer', { stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const failed = await requestPipe<{ ok: boolean; answer?: string; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'silent' },
      30_000,
    );
    expect(failed.ok).toBe(false);
    expect(failed.answer).toBeUndefined();
    expect(failed.error).toMatch(/no_answer/);
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
    const next = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'answered' },
      30_000,
    );
    expect(next).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): answered' });
    expect(inputsOf('spawn')).toHaveLength(1);
  }, 30_000);

  // Issue #16: the Watchdog fails a stuck Task without resubmitting it, respawns the
  // Instance, and the next queued Task runs normally.
  const promptCount = (prompt: string): number => {
    const root = chatsRoot(dirs.taskDir);
    const logs = readdirSync(root).map((dir) => readFileSync(join(root, dir, 'log.jsonl'), 'utf8'));
    return logs.join('\n').split(JSON.stringify({ msg: prompt })).length - 1;
  };

  const failFirstThenRunNext = async (
    prompt: string,
  ): Promise<{ failed: { ok: boolean; error?: string }; elapsedMs: number }> => {
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const started = Date.now();
    const first = requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt }, 30_000);
    const next = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'next task' },
      30_000,
    );
    const failed = await first;
    const elapsedMs = Date.now() - started;
    await expect(next).resolves.toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): next task' });
    expect(promptCount(prompt)).toBe(1);
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
    return { failed, elapsedMs };
  };

  it('fails a task frozen when only the Countdown changes, with Screen lines, and never resubmits it', async () => {
    boot('freeze', { freezeMs: 1500, taskTimeoutMs: 30_000 });
    const { failed, elapsedMs } = await failFirstThenRunNext('stuck');
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/^watchdog failure: frozen/);
    expect(failed.error).toContain('Enter a coding task');
    expect(elapsedMs).toBeLessThan(15_000);
  }, 30_000);

  it('fails a task crashed when freebuff dies mid-turn, with Screen lines, and never resubmits it', async () => {
    boot('kill-mid-turn');
    const { failed } = await failFirstThenRunNext('doomed');
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/^watchdog failure: crashed/);
    expect(failed.error).toContain('Enter a coding task');
  }, 30_000);

  it('fails a task that keeps producing output at its deadline', async () => {
    boot('chatty', { freezeMs: 1000, taskTimeoutMs: 4000 });
    const { failed, elapsedMs } = await failFirstThenRunNext('endless');
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/^watchdog failure: deadline/);
    expect(failed.error).toContain('working');
    expect(elapsedMs).toBeGreaterThanOrEqual(3_900);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 30_000);

  // Issue #17: error-looking Screen lines seen during a Turn are logged, never acted on.
  const red = (text: string): string => `\x1b[31m${text}\x1b[0m`;
  const ERROR_LINE = 'Command not found: "/definitely-not-a-freebuff-command"';
  const errorLogEntries = (): Array<{ time: string; boundDir: string; lines: string[] }> => {
    const path = errorLogPath(dirs);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
  };
  const runTurns = async (turnLines: string[][], prompts: string[]): Promise<void> => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_TURN_LINES: JSON.stringify(turnLines) } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    for (const prompt of prompts) {
      await expect(requestPipe(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt }, 30_000)).resolves.toMatchObject({
        ok: true,
        kind: 'answer',
        answer: `stub(DeepSeek V4.1 Flash): ${prompt}`,
      });
    }
  };

  it('logs a known error string seen during a Turn once, and still completes the Task', async () => {
    // The second Turn prints nothing new; the first Turn's error line is still on the Screen.
    await runTurns([[red(ERROR_LINE), 'working', red(ERROR_LINE)], []], ['broken', 'clean']);
    const entries = errorLogEntries();
    expect(entries).toEqual([{ time: expect.any(String), boundDir: resolve(dirs.taskDir), lines: [ERROR_LINE] }]);
    expect(Number.isNaN(Date.parse(entries[0]!.time))).toBe(false);
  }, 30_000);

  it('logs an error string again when a later Turn prints it while the old copy is still on the Screen', async () => {
    await runTurns([[red(ERROR_LINE)], [red(ERROR_LINE)]], ['first', 'again']);
    expect(errorLogEntries().map((entry) => entry.lines)).toEqual([[ERROR_LINE], [ERROR_LINE]]);
  }, 30_000);

  it('writes no error log entry for a Turn that prints only red diff lines', async () => {
    await runTurns([[red('- throw new Error("boom");'), red('-   return failed;'), '+ return ok;']], ['diff']);
    expect(errorLogEntries()).toEqual([]);
  }, 30_000);

  it('kills the live foreign lock holder at bind and completes the task', async () => {
    const lockPath = join(dirs.configDir, 'freebuff.lock');
    const holder = spawn(process.execPath, ['-e', 'process.stdin.resume()']);
    const bystander = spawn(process.execPath, ['-e', 'process.stdin.resume()']);
    const killed = Promise.withResolvers<void>();
    holder.once('exit', () => killed.resolve());
    try {
      writeFileSync(lockPath, String(holder.pid));
      boot('happy');
      await waitForPipe(pipeName, 10_000);
      expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir }, 30_000)).ok).toBe(true);
      await killed.promise;
      expect(bystander.exitCode).toBeNull();
      const done = await requestPipe<{ ok: boolean; answer?: string }>(
        pipeName,
        { op: 'run_prompt', dir: dirs.taskDir, prompt: 'over a live holder' },
        30_000,
      );
      expect(done).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): over a live holder' });
    } finally {
      holder.kill();
      bystander.kill();
    }
  }, 30_000);

  it('claims a stale pid lock and spawns', async () => {
    const lockPath = join(dirs.configDir, 'freebuff.lock');
    const dead = spawn(process.execPath, ['-e', '']);
    const gone = Promise.withResolvers<void>();
    dead.once('exit', () => gone.resolve());
    await gone.promise;
    writeFileSync(lockPath, String(dead.pid));
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: dirs.taskDir })).ok).toBe(true);
    const done = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'stale ok' },
      30_000,
    );
    expect(done).toMatchObject({ ok: true, answer: 'stub(DeepSeek V4.1 Flash): stale ok' });
  }, 30_000);

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
  }, 30_000);

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
    }, 30_000);
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
