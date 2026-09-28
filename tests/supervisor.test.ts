import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { requestPipe, waitForPipe } from '../src/ipc.ts';
import { METADATA_FILENAME } from '../src/protocol/markers.ts';
import { sleep } from '../src/util.ts';
import { PROMPT_PREAMBLE, workspaceDirFor } from '../src/workspace.ts';
import { expectExit, makeDirs, pollStatus, readStubInputs, startSupervisor, uniquePipe, type HarnessDirs, type HarnessOptions, type StubInput, type SupervisorProcess } from './helpers/harness.ts';

// Daemon smoke (C4): the five wire-level checks that must run a real child supervisor
// against the stub over the named pipe. Every Supervisor policy lives behind the
// DriverLike seam now and is covered in-process in supervisor-policy.test.ts.

let pipeName = '';
let proc: SupervisorProcess | null = null;
let dirs: HarnessDirs;

const boot = (mode: string, extra: Partial<HarnessOptions> = {}): void => {
  proc = startSupervisor({ pipeName, mode, ...dirs, ...extra });
};

const inputLogPath = (): string => join(dirs.configDir, 'stub-input.jsonl');
const textsOf = (event: 'paste' | 'submit'): string[] =>
  readStubInputs(inputLogPath())
    .filter((entry): entry is Extract<StubInput, { text: string }> => entry.event === event)
    .map((entry) => entry.text);

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

  it('reports status fields over the wire before and after a task', async () => {
    boot('happy');
    // ADR-0002: the drift signal keys on the installed version, and a dump under a
    // corpus-covered version (0.1.0 is on file) never sets it. Seeded so this
    // assertion tests the wire field, not which marginal frames a run samples.
    writeFileSync(join(dirs.configDir, METADATA_FILENAME), JSON.stringify({ version: '0.1.0' }));
    await waitForPipe(pipeName, 10_000);
    expect(await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' })).toMatchObject({
      ok: true,
      state: 'stopped',
      workspaceDir: workspaceDirFor(pipeName),
      targetDir: null,
      queueDepth: 0,
      activeModel: null,
      instancePid: null,
      needsLogin: false,
      screenDrift: false,
    });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'status fields' }, 30_000)).ok).toBe(true);
    expect(
      await pollStatus(pipeName, { state: 'ready', targetDir: resolve(dirs.taskDir), activeModel: 'DeepSeek V4.1 Flash', queueDepth: 0 }),
    ).toMatchObject({
      hourSessionMinutesLeft: 432,
      freebucksDaily: 25,
      needsLogin: false,
      screenDrift: false,
    });
    expect((await pollStatus(pipeName, {})).instancePid).toEqual(expect.any(Number));
  }, 30_000);

  it('purges a queued task over the wire when a retarget lands while /new is in flight', async () => {
    boot('happy');
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'first' }, 30_000)).ok).toBe(true);
    await pollStatus(pipeName, { state: 'ready', targetDir: resolve(dirs.taskDir) });
    // The /new dance types the command and settles; a task arriving in that window
    // queues behind it, and a retarget there purges it — the one wire-visible purge.
    const newSession = requestPipe(pipeName, { op: 'new_session' }, 30_000);
    await sleep(100);
    const purged = requestPipe(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'stale queued task' }, 30_000);
    const retarget = await requestPipe<Record<string, unknown>>(
      pipeName,
      { op: 'run_prompt', dir: dirs.otherDir, prompt: 'after purge' },
      30_000,
    );
    expect(retarget).toMatchObject({ ok: true, answer: `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nafter purge` });
    expect(await purged).toMatchObject({ ok: false, error: expect.stringMatching(/retarget purged/i) });
    expect(await newSession).toMatchObject({ ok: true });
    await pollStatus(pipeName, { state: 'ready', targetDir: resolve(dirs.otherDir), queueDepth: 0 });
    expect(readlinkSync(join(workspaceDirFor(pipeName), 'repo'))).toBe(resolve(dirs.otherDir));
  }, 30_000);

  it('reports busy with a queue position once the queue is full and drains in FIFO order', async () => {
    boot('slow', { delayMs: 1200, stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
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

  it('cancels the active task and answers new_session per state over the wire', async () => {
    boot('slow', { delayMs: 2500, stubEnv: { FREEBUFF_STUB_INPUT_LOG: inputLogPath() } });
    await waitForPipe(pipeName, 10_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'one' }, 30_000)).ok).toBe(true);
    const victim = requestPipe(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'victim' }, 30_000);
    await pollStatus(pipeName, { state: 'busy' });
    expect(await requestPipe(pipeName, { op: 'new_session' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/a task is active or queued/),
    });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'cancel_task' }, 30_000)).ok).toBe(true);
    expect(await victim).toMatchObject({ ok: false, error: 'task cancelled' });
    // The cancel killed the Instance: new_session sends nothing and spawns nothing.
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'new_session' })).ok).toBe(true);
    await pollStatus(pipeName, { state: 'stopped' });
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'run_prompt', dir: dirs.taskDir, prompt: 'after respawn' }, 30_000)).ok).toBe(true);
    // Issue #18: nothing ever sends /end-session; /new is the only conversation reset.
    expect(existsSync(join(dirs.configDir, 'end-session.log'))).toBe(false);
    // The cancel's wire contract is the reply and the states around it; how many
    // /new keystrokes the Driver typed is settle-loop cadence — driver tests own it.
    expect(textsOf('submit').some((text) => text.includes('/end-session'))).toBe(false);
  }, 30_000);
});
