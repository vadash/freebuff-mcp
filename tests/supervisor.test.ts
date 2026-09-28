import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { requestPipe, sendRawLine, waitForPipe } from '../src/ipc.ts';
import { READY_PROMPT } from '../src/protocol/markers.ts';
import { newestChatDir, readChats } from '../src/protocol/chatStore.ts';
import { sleep } from '../src/util.ts';
import { Supervisor, type SupervisorResponse } from '../src/supervisor.ts';
import { PROMPT_PREAMBLE, workspaceDirFor } from '../src/workspace.ts';
import { errorLogPath, expectExit, makeDirs, pollStatus, readStubInputs, startSupervisor, stubPath, uniquePipe, type HarnessDirs, type HarnessOptions, type StubInput, type SupervisorProcess } from './helpers/harness.ts';

let pipeName = '';
let proc: SupervisorProcess | null = null;
let dirs: HarnessDirs;

const boot = (mode: string, extra: Partial<HarnessOptions> = {}): void => {
  proc = startSupervisor({ pipeName, mode, ...dirs, ...extra });
};

// Issue #18: what the stub received, from FREEBUFF_STUB_INPUT_LOG.
const inputLogPath = (): string => join(dirs.configDir, 'stub-input.jsonl');
const inputsOf = (event: StubInput['event']): StubInput[] => readStubInputs(inputLogPath()).filter((entry) => entry.event === event);
const textsOf = (event: 'paste' | 'submit'): string[] =>
  readStubInputs(inputLogPath())
    .filter((entry): entry is Extract<StubInput, { text: string }> => entry.event === event)
    .map((entry) => entry.text);

const latestFirstMsg = (): string => {
  const newest = newestChatDir(readChats(dirs.configDir, workspaceDirFor(pipeName)));
  if (!newest) return '';
  const parsed: unknown = JSON.parse(newest.logText.split('\n')[0] ?? '{}');
  const msg =
    parsed !== null && typeof parsed === 'object' && 'msg' in parsed && typeof parsed.msg === 'string'
      ? parsed.msg
      : '';
  return msg;
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

  it('answers status while stopped and rejects run_prompt to a missing directory', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const status = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(status).toMatchObject({ ok: true, state: 'stopped', workspaceDir: workspaceDirFor(pipeName), targetDir: null, queueDepth: 0, activeModel: null });
    const bad = await requestPipe<Record<string, unknown>>(pipeName, { op: 'run_prompt', dir: `${dirs.taskDir}/nope`, prompt: 'x' });
    expect(bad.ok).toBe(false);
  }, 30_000);

  it('doctor skips the live check with no Instance and reports pass at ready', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect(await requestPipe(pipeName, { op: 'doctor' })).toEqual({ ok: true, kind: 'doctor', skipped: true, screen: null, level: null, missing: [] });
    await requestPipe(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'task' }, 30_000);
    await pollStatus(pipeName, { state: 'ready' });
    expect(await requestPipe(pipeName, { op: 'doctor' })).toEqual({ ok: true, kind: 'doctor', skipped: false, screen: 'ready', level: 'pass', missing: [] });
  }, 30_000);

  it('doctor reports degraded naming the drifted Marker when the live Screen renders altered wording', async () => {
    boot('drift', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1' } });
    await waitForPipe(pipeName, 10_000);
    await requestPipe(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'task' }, 30_000);
    await pollStatus(pipeName, { state: 'ready' });
    expect(await requestPipe<{ level: string; missing: string[] }>(pipeName, { op: 'doctor' })).toEqual({ ok: true, kind: 'doctor', skipped: false, screen: 'ready', level: 'degraded', missing: ['COUNTDOWN_REGEX'] });
  }, 30_000);

  // Issue #21: the screen op returns the exact flattened Screen the Driver and Watchdog read.
  it('screen op returns the flattened Screen while stopped, at the transient Welcome screen, busy and ready', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect(await requestPipe(pipeName, { op: 'screen' })).toEqual({ ok: true, kind: 'screen', screen: '' });
    const task = requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'screen states' }, 30_000);
    // The stub replays the captured Welcome fixture verbatim while the settle loop is
    // idle; the first message then starts the session.
    const welcomeDeadline = Date.now() + 10_000;
    let atWelcome = '';
    while (Date.now() < welcomeDeadline) {
      atWelcome = (await requestPipe<{ screen: string }>(pipeName, { op: 'screen' })).screen;
      if (atWelcome.includes('Your first message starts the session')) break;
      await sleep(100);
    }
    expect(atWelcome).toContain('Your first message starts the session');
    await pollStatus(pipeName, { state: 'busy' });
    // Busy is set while the first message starts the session; poll until the ready box paints.
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
    const binding = requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'x' }, 30_000);
    await pollStatus(pipeName, { state: 'busy' });
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

  // Issue #23: the fallback Enter on the unrecognized screen flips the stub to ready,
  // so run_prompt completes end-to-end; the dump is still written exactly once.
  it('completes run_prompt on the unknown screen via one fallback Enter', async () => {
    writeFileSync(join(dirs.configDir, 'freebuff-metadata.json'), JSON.stringify({ version: '0.0.231' }));
    boot('unknown', { readyMs: 20_000, stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
    const run = await requestPipe<Record<string, unknown>>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'fallback task' },
      30_000,
    );
    expect(run).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nfallback task` });
    await pollStatus(pipeName, { state: 'ready' });
    // One Enter total: the fallback stopped once a recognized screen appeared.
    expect(inputsOf('enter')).toHaveLength(1);
    const versionDir = join(dirs.configDir, 'screen-dumps', '0.0.231');
    expect(readdirSync(versionDir)).toHaveLength(1);
  }, 60_000);

  // Issue #31: the settle check is recorded for the running CLI version. The stub's
  // degraded screen mode (`drift` — the ready status line's Countdown wording reads
  // `remaining`, so COUNTDOWN_REGEX misses) boots straight into a degraded ready
  // screen; it is dumped like an unknown one, and status raises screenDrift.
  it('raises screenDrift on a degraded screen and dumps it once per Freeze key', async () => {
    writeFileSync(join(dirs.configDir, 'freebuff-metadata.json'), JSON.stringify({ version: '0.0.190' }));
    boot('drift', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1' } });
    await waitForPipe(pipeName, 10_000);
    const run = await requestPipe<Record<string, unknown>>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'drift task' }, 30_000);
    expect(run).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\ndrift task` });
    await pollStatus(pipeName, { state: 'ready' });
    expect(await requestPipe(pipeName, { op: 'doctor' })).toMatchObject({ ok: true, kind: 'doctor', skipped: false, screen: 'ready', level: 'degraded', missing: ['COUNTDOWN_REGEX'] });
    expect(await pollStatus(pipeName, { screenDrift: true })).toMatchObject({ state: 'ready' });
    const versionDir = join(dirs.configDir, 'screen-dumps', '0.0.190');
    const dumps = readdirSync(versionDir);
    expect(dumps).toHaveLength(1);
    expect(readFileSync(join(versionDir, dumps[0]!), 'utf8')).toContain('remaining');
  }, 60_000);

  // Issue #31: an unknown screen raises screenDrift for its version; after the CLI
  // updates (a different version runs) the 0.0.190 record stays on disk but the
  // signal clears, because nothing is on record for the new version.
  it('raises screenDrift for an unknown screen and clears it when a different version runs', async () => {
    writeFileSync(join(dirs.configDir, 'freebuff-metadata.json'), JSON.stringify({ version: '0.0.190' }));
    boot('unknown', { readyMs: 2_500 });
    await waitForPipe(pipeName, 10_000);
    const binding = requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'x' }, 30_000);
    // Raised as soon as the settle loop dumps the unknown frame.
    await pollStatus(pipeName, { screenDrift: true });
    expect((await binding).ok).toBe(false);
    await pollStatus(pipeName, { state: 'stopped' });
    writeFileSync(join(dirs.configDir, 'freebuff-metadata.json'), JSON.stringify({ version: '0.0.231' }));
    expect(await pollStatus(pipeName, { screenDrift: false })).toMatchObject({ state: 'stopped' });
  }, 30_000);

  // Issue #31 (story 18): the corpus covering the running version is the fix, so a
  // dump on record for it never raises the signal. 0.0.199 has a corpus folder.
  it('keeps screenDrift clear when the corpus holds a folder for the version with the dump', async () => {
    writeFileSync(join(dirs.configDir, 'freebuff-metadata.json'), JSON.stringify({ version: '0.0.199' }));
    boot('unknown', { readyMs: 2_500 });
    await waitForPipe(pipeName, 10_000);
    const binding = requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'x' }, 30_000);
    await pollStatus(pipeName, { state: 'stopped' });
    expect((await binding).ok).toBe(false);
    // The unknown frame IS on record for 0.0.199, but the corpus covers that version.
    expect(readdirSync(join(dirs.configDir, 'screen-dumps', '0.0.199'))).toHaveLength(1);
    expect(await pollStatus(pipeName, { screenDrift: false })).toMatchObject({ state: 'stopped' });
  }, 30_000);

  it('spawns on the first task and idles at ready after each task without respawning', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const first = await requestPipe<Record<string, unknown>>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'first task' },
      30_000,
    );
    expect(first).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nfirst task` });
    await pollStatus(pipeName, { state: 'ready', targetDir: resolve(dirs.taskDir), activeModel: 'DeepSeek V4.1 Flash', queueDepth: 0 });
    const lockBefore = readFileSync(join(dirs.configDir, 'freebuff.lock'), 'utf8');
    const second = await requestPipe<Record<string, unknown>>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'second task' },
      30_000,
    );
    expect(second).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nsecond task` });
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
    expect(readFileSync(join(dirs.configDir, 'freebuff.lock'), 'utf8')).toBe(lockBefore);
  }, 30_000);

  it('never sends /end-session across tasks, cancel, and respawn', async () => {
    boot('slow', { delayMs: 1200 });
    await waitForPipe(pipeName, 10_000);
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
    boot('happy', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1' } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'before the kill' }, 30_000)).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 432 });
    const stubPid = Number.parseInt(readFileSync(join(dirs.configDir, 'freebuff.lock'), 'utf8').trim(), 10);
    spawn('taskkill', ['/PID', String(stubPid), '/T', '/F']);
    await pollStatus(pipeName, { state: 'stopped', hourSessionMinutesLeft: 432 });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after the kill' }, 30_000)).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 432, queueDepth: 0 });
  }, 30_000);

  it('leaves the continue screen alone while idle and presses enter for the next task', async () => {
    boot('expire');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'first' }, 30_000)).ok).toBe(true);
    await pollStatus(pipeName, { state: 'idle', queueDepth: 0 });
    await sleep(1200);
    expect((await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' })).state).toBe('idle');
    const second = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'second' },
      30_000,
    );
    expect(second).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nsecond` });
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
  }, 30_000);

  // Issue #30 (story 10 of #25): a missing Countdown on ready is unknown time left,
  // reported as null (never zero), and the status fields carry it unchanged.
  it('runs through a ready screen whose Countdown is missing: unknown minutes are reported as null', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1', FREEBUFF_STUB_NO_COUNTDOWN: '1' } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'no countdown' }, 30_000)).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: null, targetDir: resolve(dirs.taskDir) });
  }, 30_000);

  it('replies with an error for unknown ops and malformed json lines', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const unknown = await requestPipe<Record<string, unknown>>(pipeName, { op: 'nope' });
    expect(unknown.ok).toBe(false);
    const malformed = JSON.parse(await sendRawLine(pipeName, 'this is not json')) as Record<string, unknown>;
    expect(malformed.ok).toBe(false);
  }, 30_000);

  it('refuses a different directory only while a task is active and retargets once the queue drains', async () => {
    proc = startSupervisor({
      pipeName,
      mode: 'slow',
      delayMs: 2000,
      ...dirs,
      stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1', FREEBUFF_STUB_COUNTDOWN_MIN: '30' },
    });
    await waitForPipe(pipeName, 10_000);
    const task = requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'long task' }, 30_000);
    await pollStatus(pipeName, { state: 'busy' });
    const queued = requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'queued' }, 30_000);
    await pollStatus(pipeName, { queueDepth: 1 });
    const rejected = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir: dirs.otherDir });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/while a task is active/i);
    expect((await queued).ok).toBe(true);
    expect((await task).ok).toBe(true);
    const retarget = await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.otherDir, prompt: 'after retarget' }, 30_000);
    expect(retarget.ok).toBe(true);
    await pollStatus(pipeName, { targetDir: resolve(dirs.otherDir), state: 'ready', queueDepth: 0 });
    expect(readlinkSync(join(workspaceDirFor(pipeName), 'repo'))).toBe(resolve(dirs.otherDir));
  }, 30_000);

  it('retarget purges queued tasks and the next task runs against the new directory', async () => {
    const supPipe = uniquePipe('purge');
    const sup = new Supervisor({
      pipeName: supPipe,
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
      let task: SupervisorResponse | undefined;
      await sup.handle({ op: 'run_prompt', dir: dirs.otherDir, prompt: 'after purge' }, (response) => { task = response; });
      expect(task).toEqual({ ok: true, kind: 'answer', answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nafter purge` });
      expect(purged).toHaveLength(2);
      for (const response of purged) {
        if (!('error' in response)) throw new Error(`purged reply without error: ${JSON.stringify(response)}`);
        expect(response.error).toMatch(/retarget purged/i);
      }
      let status: SupervisorResponse | undefined;
      await sup.handle({ op: 'status' }, (response) => { status = response; });
      if (!status || !('state' in status)) throw new Error(`bad status reply: ${JSON.stringify(status)}`);
      expect(status).toMatchObject({ workspaceDir: workspaceDirFor(supPipe), targetDir: resolve(dirs.otherDir), queueDepth: 0 });
    } finally {
      // no shutdown op here: it process.exit()s the vitest worker
      // driver is compile-time private; named cast to stop the spawned stub.
      const driver = (sup as unknown as { driver: { kill(): void } }).driver;
      driver.kill();
    }
  }, 30_000);

  it('reports busy with a queue position once the queue is full and drains in FIFO order', async () => {
    proc = startSupervisor({ pipeName, mode: 'slow', delayMs: 1200, ...dirs, stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
    const answers: Record<string, string> = {};
    const tasks = ['p1', 'p2', 'p3', 'p4', 'p5'].map((prompt) =>
      requestPipe<{ ok: boolean; answer?: string }>(
        pipeName,
        { op: 'run_prompt', dir: dirs.taskDir, prompt },
        30_000,
      ).then((r) => {
        answers[prompt] = r.answer ?? '';
      }),
    );
    await pollStatus(pipeName, { queueDepth: 4 });
    const overflow = await requestPipe<{ ok: boolean; position?: number }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'overflow' },
    );
    expect(overflow.ok).toBe(false);
    expect(overflow.position).toBe(5);
    await Promise.all(tasks);
    const submitted = (prompt: string): string => `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\n${prompt}`;
    // Each connection gets the answer to its own request, and the five tasks ran
    // serially, one paste per prompt. The reply arrival order across independent
    // sockets is the transport's, not the Queue's, so FIFO is pinned order-free.
    for (const prompt of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      expect(answers[prompt], prompt).toBe(submitted(prompt));
    }
    const pasted = (prompt: string): string => `${PROMPT_PREAMBLE}\n${prompt}`;
    expect(textsOf('paste').sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'].map(pasted).sort());
  }, 30_000);

  it('routes prompts above the paste threshold through a temp file and keeps small prompts on the paste path', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const big = 'x'.repeat(100 * 1024);
    const task = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: big },
      30_000,
    );
    const tempPath = join(workspaceDirFor(pipeName), '.freebuff-task-1.md');
    const deadline = Date.now() + 10_000;
    while (!existsSync(tempPath)) {
      if (Date.now() > deadline) throw new Error(`temp file never appeared at ${tempPath}`);
      await sleep(100);
    }
    expect(readFileSync(tempPath, 'utf8')).toBe(big);
    const done = await task;
    expect(done.ok).toBe(true);
    expect(done.answer).toContain('.freebuff-task-1.md');
    expect(done.answer).toContain(PROMPT_PREAMBLE);
    expect(done.answer).not.toContain('xxxxx');
    expect(existsSync(tempPath)).toBe(false);
    expect(latestFirstMsg()).toMatch(/Read the instructions in \.freebuff-task-1\.md/);
    expect(latestFirstMsg().startsWith(PROMPT_PREAMBLE)).toBe(true);
    const small = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'tiny payload' },
      30_000,
    );
    expect(small).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\ntiny payload` });
    expect(latestFirstMsg()).toBe(`${PROMPT_PREAMBLE}\ntiny payload`);
    expect(existsSync(join(workspaceDirFor(pipeName), '.freebuff-task-2.md'))).toBe(false);
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
    expect(survivorResult).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nsurvivor` });
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
  }, 30_000);

  it('new_session errors while busy and sends /new to the idle Instance without respawning it', async () => {
    boot('slow', { delayMs: 2500, stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
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
    expect(textsOf('submit')).toEqual(['/new', `${PROMPT_PREAMBLE}\nrunning`]);
    const idle = await requestPipe<{ ok: boolean }>(pipeName, { op: 'new_session' });
    expect(idle.ok).toBe(true);
    expect(textsOf('submit')).toEqual(['/new', `${PROMPT_PREAMBLE}\nrunning`, '/new']);
    await sleep(600);
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
    const next = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after reset' },
      30_000,
    );
    expect(next).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nafter reset` });
    expect(inputsOf('spawn')).toHaveLength(1);
  }, 30_000);

  it('new_session with no Instance sends nothing and spawns nothing', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'new_session' })).ok).toBe(true);
    await sleep(600);
    expect(textsOf('submit')).toEqual([]);
    expect(inputsOf('spawn')).toHaveLength(0);
  }, 30_000);

  // Issue #18: prompts go in as one bracketed paste and one submit, so a newline in the
  // prompt never submits it early.
  it('pastes a multi-line prompt between bracketed-paste markers and submits it exactly once', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
    const prompt = 'first line\nsecond line\n\n  indented fourth line\r\nlast line';
    const submitted = `${PROMPT_PREAMBLE}\n${prompt}`;
    const done = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt },
      30_000,
    );
    expect(done).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${submitted}` });
    expect(textsOf('paste')).toEqual([submitted]);
    expect(textsOf('submit')).toEqual(['/new', submitted]);
    expect(latestFirstMsg()).toBe(submitted);
  }, 30_000);

  it('fails a Task whose Turn ends without an Answer with no_answer, keeping the Instance', async () => {
    boot('no-answer', { stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
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
    expect(next).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nanswered` });
    expect(inputsOf('spawn')).toHaveLength(1);
  }, 30_000);

  // Issue #16: the Watchdog fails a stuck Task without resubmitting it, respawns the
  // Instance, and the next queued Task runs normally.
  const promptCount = (prompt: string): number =>
    readChats(dirs.configDir, workspaceDirFor(pipeName))
      .map((snap) => snap.logText)
      .join('\n')
      .split(JSON.stringify({ msg: `${PROMPT_PREAMBLE}\n${prompt}` })).length - 1;

  const failFirstThenRunNext = async (
    prompt: string,
  ): Promise<{ failed: { ok: boolean; error?: string }; elapsedMs: number }> => {
    await waitForPipe(pipeName, 10_000);
    const started = Date.now();
    const first = requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt }, 30_000);
    const next = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'next task' },
      30_000,
    );
    const failed = await first;
    const elapsedMs = Date.now() - started;
    await expect(next).resolves.toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nnext task` });
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
  const errorLogEntries = (): Array<{ time: string; workspace: string; lines: string[] }> => {
    const path = errorLogPath(dirs);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
  };
  const runTurns = async (turnLines: string[][], prompts: string[]): Promise<void> => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_TURN_LINES: JSON.stringify(turnLines) } });
    await waitForPipe(pipeName, 10_000);
    for (const prompt of prompts) {
      await expect(requestPipe(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt }, 30_000)).resolves.toMatchObject({
        ok: true,
        kind: 'answer',
        answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\n${prompt}`,
      });
    }
  };

  it('logs a known error string seen during a Turn once, and still completes the Task', async () => {
    // The second Turn prints nothing new; the first Turn's error line is still on the Screen.
    await runTurns([[red(ERROR_LINE), 'working', red(ERROR_LINE)], []], ['broken', 'clean']);
    const entries = errorLogEntries();
    expect(entries).toEqual([{ time: expect.any(String), workspace: workspaceDirFor(pipeName), lines: [ERROR_LINE] }]);
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

  it('kills the live foreign lock holder at the first task and completes the task', async () => {
    const lockPath = join(dirs.configDir, 'freebuff.lock');
    const holder = spawn(process.execPath, ['-e', 'process.stdin.resume()']);
    const bystander = spawn(process.execPath, ['-e', 'process.stdin.resume()']);
    const killed = Promise.withResolvers<void>();
    holder.once('exit', () => killed.resolve());
    try {
      writeFileSync(lockPath, String(holder.pid));
      boot('happy');
      await waitForPipe(pipeName, 10_000);
      const done = requestPipe<{ ok: boolean; answer?: string }>(
        pipeName,
        { op: 'run_prompt', dir: dirs.taskDir, prompt: 'over a live holder' },
        30_000,
      );
      await killed.promise;
      expect(bystander.exitCode).toBeNull();
      expect(await done).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nover a live holder` });
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
    const done = await requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'stale ok' },
      30_000,
    );
    expect(done).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nstale ok` });
  }, 30_000);

  it('reports countdown and freebucks fields on status', async () => {
    proc = startSupervisor({ pipeName, mode: 'slow', delayMs: 2500, ...dirs });
    await waitForPipe(pipeName, 10_000);
    const before = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(before).toMatchObject({ hourSessionMinutesLeft: null, freebucksDaily: null, needsLogin: false, targetDir: null });
    const task = requestPipe<{ ok: boolean; answer?: string }>(
      pipeName,
      { op: 'run_prompt', dir: dirs.taskDir, prompt: 'status fields' },
      30_000,
    );
    await pollStatus(pipeName, { state: 'busy' });
    // While the session screen is up the Countdown ticks; it paints as the first
    // message starts the session.
    const busyDeadline = Date.now() + 10_000;
    let busy: Record<string, unknown> = {};
    while (Date.now() < busyDeadline) {
      busy = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
      if (busy.hourSessionMinutesLeft === 432) break;
      await sleep(150);
    }
    expect(busy).toMatchObject({ hourSessionMinutesLeft: 432, freebucksDaily: 25, activeModel: 'DeepSeek V4.1 Flash' });
    await task;
    await pollStatus(pipeName, { state: 'ready' });
    const status = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(status).toMatchObject({ hourSessionMinutesLeft: 432, freebucksDaily: 25, needsLogin: false });
  }, 30_000);

  it('reports needs_login from run_prompt and returns to stopped', async () => {
    boot('needs-login');
    await waitForPipe(pipeName, 10_000);
    const failed = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'x' }, 30_000);
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/needs_login/);
    await pollStatus(pipeName, { needsLogin: true, state: 'stopped', queueDepth: 0 });
    const status = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(status).toMatchObject({ hourSessionMinutesLeft: null, freebucksDaily: null });
  }, 30_000);

  // Workspace-junction design: the Instance always runs in one per-pipe workspace and
  // `<workspace>/repo` is a junction to the caller's directory.
  it('reports the derived workspace and a null target while stopped', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const status = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(status).toMatchObject({ ok: true, state: 'stopped', workspaceDir: workspaceDirFor(pipeName), targetDir: null, queueDepth: 0 });
    expect(existsSync(join(workspaceDirFor(pipeName), 'repo'))).toBe(false);
  }, 30_000);

  it('errors run_prompt for a missing target directory without spawning', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const bad = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir: join(dirs.taskDir, 'nope'), prompt: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/not an existing directory/);
    await pollStatus(pipeName, { state: 'stopped', targetDir: null, queueDepth: 0 });
    expect(existsSync(join(workspaceDirFor(pipeName), 'repo'))).toBe(false);
  }, 30_000);

  it('retargets the repo junction on a directory change and leaves the old target intact', async () => {
    writeFileSync(join(dirs.taskDir, 'task-marker.txt'), 'task');
    writeFileSync(join(dirs.otherDir, 'other-marker.txt'), 'other');
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const junction = join(workspaceDirFor(pipeName), 'repo');
    await expect(
      requestPipe(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'in task dir' }, 30_000),
    ).resolves.toMatchObject({ ok: true, kind: 'answer' });
    expect(readlinkSync(junction)).toBe(resolve(dirs.taskDir));
    await expect(
      requestPipe(pipeName, { op: 'run_prompt', dir: dirs.otherDir, prompt: 'in other dir' }, 30_000),
    ).resolves.toMatchObject({ ok: true, kind: 'answer' });
    expect(readlinkSync(junction)).toBe(resolve(dirs.otherDir));
    expect(readFileSync(join(dirs.taskDir, 'task-marker.txt'), 'utf8')).toBe('task');
    await pollStatus(pipeName, { state: 'ready', targetDir: resolve(dirs.otherDir) });
  }, 30_000);

  it('refuses a different directory while a task is active', async () => {
    proc = startSupervisor({ pipeName, mode: 'slow', delayMs: 2000, ...dirs });
    await waitForPipe(pipeName, 10_000);
    const task = requestPipe<Record<string, unknown>>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'long task' }, 30_000);
    await pollStatus(pipeName, { state: 'busy' });
    const refused = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir: dirs.otherDir, prompt: 'elsewhere' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/while a task is active/);
    expect((await task).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', targetDir: resolve(dirs.taskDir) });
  }, 30_000);

  it('re-ensures the repo junction when it is deleted between tasks', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const junction = join(workspaceDirFor(pipeName), 'repo');
    expect((await requestPipe<Record<string, unknown>>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'first' }, 30_000)).ok).toBe(true);
    expect(readlinkSync(junction)).toBe(resolve(dirs.taskDir));
    rmSync(junction, { force: true });
    expect(existsSync(junction)).toBe(false);
    expect((await requestPipe<Record<string, unknown>>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'second' }, 30_000)).ok).toBe(true);
    expect(readlinkSync(junction)).toBe(resolve(dirs.taskDir));
  }, 30_000);

  it('prepends the repo preamble to every submitted prompt', async () => {
    boot('happy', { stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
    const done = await requestPipe<Record<string, unknown>>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'preamble check' }, 30_000);
    expect(done).toMatchObject({ ok: true, kind: 'answer', answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\npreamble check` });
    expect(textsOf('paste')).toEqual([`${PROMPT_PREAMBLE}\npreamble check`]);
  }, 30_000);

  // Safety rails: a junction target that is a filesystem root or an ancestor of the
  // workspace would loop or mount a whole drive, so run_prompt must refuse it.
  it('refuses filesystem roots and workspace ancestors as run_prompt targets', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const junction = join(workspaceDirFor(pipeName), 'repo');
    for (const dir of ['C:\\', resolve(tmpdir())]) {
      const refused = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir, prompt: 'nope' }, 30_000);
      expect(refused.ok, dir).toBe(false);
      expect(String(refused.error), dir).toMatch(/not a safe junction target/);
    }
    expect(existsSync(junction)).toBe(false);
    await pollStatus(pipeName, { state: 'stopped', targetDir: null, queueDepth: 0 });
  }, 30_000);

  it('refuses a real directory named repo without deleting its contents', async () => {
    const ws = workspaceDirFor(pipeName);
    const repo = join(ws, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'precious.txt'), 'keep me');
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    const refused = await requestPipe<{ ok: boolean; error?: string }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'x' }, 30_000);
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/not a junction/);
    expect(lstatSync(repo).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(repo, 'precious.txt'), 'utf8')).toBe('keep me');
    await pollStatus(pipeName, { state: 'stopped', targetDir: null, queueDepth: 0 });
  }, 30_000);
});
