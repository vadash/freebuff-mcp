import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestPipe, waitForPipe } from '../src/ipc.ts';
import { READY_PROMPT } from '../src/protocol/markers.ts';
import { readChats } from '../src/protocol/chatStore.ts';
import { workspaceDirFor, PROMPT_PREAMBLE } from '../src/workspace.ts';
import { consoleProcessList, expectExit, makeDirs, plainEnv, pollStatus, serverEntry, startSupervisor, uniquePipe, type HarnessDirs, type HarnessOptions, type SupervisorProcess } from './helpers/harness.ts';
import { sleep } from '../src/util.ts';
import type { ChildProcess } from 'node:child_process';

let pipeName = '';
let transport: StdioClientTransport | null = null;
let client: Client | null = null;
let dirs: HarnessDirs;
let serverProcess: ChildProcess | null = null;
let supervisorProc: SupervisorProcess | null = null;

type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const boot = (mode: string, extra: Partial<HarnessOptions> = {}): Client => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', serverEntry],
    env: plainEnv({ pipeName, mode, ...dirs, ...extra }),
  });
  client = new Client({ name: 'test-client', version: '0.0.0' });
  return client;
};

const toolText = (result: CallResult): string => {
  expect(result.isError).toBeFalsy();
  return result.content[0]!.text ?? '';
};

describe('freebuff MCP server (stdio, tools run_prompt/status)', () => {
  beforeEach(() => {
    pipeName = uniquePipe('mcp');
    dirs = makeDirs();
  });

  afterEach(async () => {
    await requestPipe(pipeName, { op: 'shutdown' }).catch(() => {});
    if (supervisorProc) await expectExit(supervisorProc);
    supervisorProc = null;
    await client?.close().catch(() => {});
    client = null;
    transport = null;
    if (serverProcess) await expectExit(serverProcess);
    serverProcess = null;
  });

  it('runs two queued prompts in order and idles at ready with /new per task', async () => {
    const c = boot('happy');
    await c.connect(transport!);
    const completions: string[] = [];
    const first = c
      .callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'task one' } })
      .then((r) => completions.push(toolText(r as CallResult)));
    await pollStatus(pipeName, { state: 'busy' });
    const second = c
      .callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'task two' } })
      .then((r) => completions.push(toolText(r as CallResult)));
    await Promise.all([first, second]);
    const submitted = (prompt: string): string => `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\n${prompt}`;
    expect(completions).toEqual([submitted('task one'), submitted('task two')]);
    const status = await pollStatus(pipeName, { state: 'ready', activeModel: 'DeepSeek V4.1 Flash', queueDepth: 0 });
    expect(status.workspaceDir).toContain('freebuff-ws-');
    expect(status.targetDir).toContain('freebuff-sup-task-');
    const toolStatus = JSON.parse(toolText((await c.callTool({ name: 'status', arguments: {} })) as CallResult)) as Record<string, unknown>;
    expect(toolStatus.hourSessionMinutesLeft).toBe(432);
    // The 0.1.0 session screen keeps the account box, so the daily allowance is on
    // screen at ready (ADR-0004; the old picker-only balance read null here).
    expect(toolStatus.freebucksDaily).toBe(25);
    const chatDirs = readChats(dirs.configDir, workspaceDirFor(pipeName)).map((snap) => snap.dirName);
    expect(chatDirs.length).toBeGreaterThanOrEqual(2);
    for (const dir of chatDirs) expect(dir.startsWith('chat-new-')).toBe(true);
  }, 30_000);

  it('errors run_prompt for a missing directory, without spawning', async () => {
    const c = boot('happy');
    await c.connect(transport!);
    const result = (await c.callTool({ name: 'run_prompt', arguments: { dir: `${dirs.taskDir}/nope`, prompt: 'x' } })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not an existing directory/);
    const status = await pollStatus(pipeName, { state: 'stopped', targetDir: null, queueDepth: 0 });
    expect(String(status.workspaceDir)).toContain('freebuff-ws-');
  }, 30_000);

  it('refuses a different directory while busy, naming the active target', async () => {
    const c = boot('slow', { delayMs: 4000 });
    await c.connect(transport!);
    const inFlight = c.callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'busy work' } }).then(
      (r) => !(r as CallResult).isError,
      () => false,
    );
    await pollStatus(pipeName, { state: 'busy' });
    const refused = (await c.callTool({ name: 'run_prompt', arguments: { dir: dirs.otherDir, prompt: 'x' } })) as CallResult;
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('while a task is active');
    expect(refused.content[0]!.text).toContain(resolve(dirs.taskDir));
    expect(await inFlight).toBe(true);
  }, 30_000);

  it('cancels the active task and resets the session through the new tools', async () => {
    const c = boot('slow', { delayMs: 4000 });
    await c.connect(transport!);
    const inFlight = c
      .callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'victim' } })
      .then(
        (r) => (r as CallResult).isError === true,
        () => 'dropped',
      );
    await pollStatus(pipeName, { state: 'busy' });
    const busyReset = (await c.callTool({ name: 'new_session', arguments: {} })) as CallResult;
    expect(busyReset.isError).toBe(true);
    expect(busyReset.content[0]!.text).toMatch(/active or queued/i);
    expect(toolText((await c.callTool({ name: 'cancel_task', arguments: {} })) as CallResult)).toBe('ok');
    expect(await inFlight).toBe(true);
    await pollStatus(pipeName, { state: 'stopped', queueDepth: 0 });
    const idleReset = (await c.callTool({ name: 'new_session', arguments: {} })) as CallResult;
    toolText(idleReset);
    const next = (await c.callTool({
      name: 'run_prompt',
      arguments: { dir: dirs.taskDir, prompt: 'after reset' },
    })) as CallResult;
    expect(toolText(next)).toBe(`stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\nafter reset`);
  }, 30_000);

  it('survives the MCP client disconnecting and completes the in-flight task', async () => {
    supervisorProc = startSupervisor({
      pipeName,
      mode: 'slow',
      delayMs: 3000,
      ...dirs,
    });
    await waitForPipe(pipeName, 10_000);
    const first = boot('slow');
    const firstEnv = plainEnv({ pipeName, mode: 'slow', delayMs: 3000, ...dirs });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--experimental-strip-types', serverEntry],
      env: firstEnv,
    });
    await first.connect(transport!);
    const inFlight = first
      .callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'survivor' } })
      .then(
        (r) => 'answered',
        () => 'dropped',
      );
    await pollStatus(pipeName, { state: 'busy' });

    await first.close();
    client = null;
    transport = null;
    expect(await inFlight).toBe('dropped');
    const alive = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    expect(alive.ok).toBe(true);

    const second = boot('slow');
    await second.connect(transport!);
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0, activeModel: 'DeepSeek V4.1 Flash' });
    const status = JSON.parse(
      toolText((await second.callTool({ name: 'status', arguments: {} })) as CallResult),
    ) as Record<string, unknown>;
    expect(status).toMatchObject({ state: 'ready', queueDepth: 0, activeModel: 'DeepSeek V4.1 Flash' });
    expect(String(status.targetDir)).toContain('freebuff-sup-task-');
  }, 30_000);

  // Issue #18: a full Queue is a failed call that still carries the position.
  it('returns busy with the queue position as an MCP error once the queue is full', async () => {
    const c = boot('slow', { delayMs: 1500 });
    await c.connect(transport!);
    const tasks = ['p1', 'p2', 'p3', 'p4', 'p5'].map((prompt) =>
      c.callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt } }, undefined, { timeout: 30_000 }),
    );
    await pollStatus(pipeName, { queueDepth: 4 });
    const overflow = (await c.callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'overflow' } })) as CallResult;
    expect(overflow.isError).toBe(true);
    expect(JSON.parse(overflow.content[0]!.text ?? '')).toEqual({ busy: true, position: 5 });
    const answers = (await Promise.all(tasks)).map((r) => toolText(r as CallResult));
    expect(answers).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'].map((prompt) => `stub(DeepSeek V4.1 Flash): ${PROMPT_PREAMBLE}\n${prompt}`));
  }, 30_000);

  it('replaces a stale-code daemon through the fingerprint handshake (ADR-0005)', async () => {
    // A daemon from an older code generation holds the pipe — the state an MCP reload
    // leaves behind when the supervisor code changed while it ran.
    process.env.FREEBUFF_SUPERVISOR_FINGERPRINT = 'old-code';
    supervisorProc = startSupervisor({ pipeName, mode: 'happy', ...dirs });
    await waitForPipe(pipeName, 10_000);
    // The reloaded MCP server (and the supervisor it would spawn) is a new generation.
    process.env.FREEBUFF_SUPERVISOR_FINGERPRINT = 'new-code';
    try {
      const c = boot('happy');
      await c.connect(transport!);
      const deadline = Date.now() + 15_000;
      for (;;) {
        // ADR-0005: a call racing the takeover can fail visibly — the old daemon's
        // pipe is already gone. Only the settled state is the contract.
        const result = (await c.callTool({ name: 'status', arguments: {} })) as CallResult;
        let fingerprint: unknown = null;
        if (!result.isError) {
          fingerprint = (JSON.parse(result.content[0]!.text ?? '') as Record<string, unknown>).fingerprint;
        }
        if (fingerprint === 'new-code') break;
        if (Date.now() > deadline) throw new Error(`status still served by the old daemon after 15 s (last error: ${result.isError})`);
        await sleep(300);
      }
      await expectExit(supervisorProc, 10_000);
      supervisorProc = null; // already reaped; afterEach would hang on its exit event
      // A fresh daemon sits at 'stopped' until its first Task spawns the Instance.
      expect(await pollStatus(pipeName, { state: 'stopped', fingerprint: 'new-code' })).toMatchObject({ ok: true });
    } finally {
      delete process.env.FREEBUFF_SUPERVISOR_FINGERPRINT;
    }
  }, 60_000);

  it('runs the doctor protocol check through the supervisor op', async () => {
    const c = boot('happy');
    await c.connect(transport!);
    const report = JSON.parse(toolText((await c.callTool({ name: 'doctor', arguments: {} })) as CallResult)) as {
      ok: boolean;
      skipped: boolean;
      screen: string | null;
      level: string | null;
      missing: string[];
    };
    expect(report).toEqual({ ok: false, skipped: true, screen: null, level: null, missing: [] });
  }, 30_000);

  // Issue #21: the screen tool hands back the Instance's flattened Screen.
  it('returns the running Screen through the screen tool', async () => {
    const c = boot('happy');
    await c.connect(transport!);
    const done = c.callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'screen' } }, undefined, {
      timeout: 30_000,
    });
    // The screen op legitimately returns '' before the stub's first paint, so poll
    // until the ready box is on the Instance's screen instead of sampling once.
    const deadline = Date.now() + 10_000;
    let screen = '';
    while (!screen.includes(READY_PROMPT)) {
      if (Date.now() > deadline) throw new Error(`screen never showed the ready box: ${JSON.stringify(screen)}`);
      await sleep(150);
      screen = toolText((await c.callTool({ name: 'screen', arguments: {} })) as CallResult);
    }
    await done;
  }, 30_000);

  it('starts the supervisor with a console, so programs it starts open no console window', async () => {
    const parentPidFile = join(dirs.otherDir, 'instance-parent.pid');
    const c = boot('happy', { stubEnv: { FREEBUFF_STUB_PARENT_PID_FILE: parentPidFile } });
    await c.connect(transport!);
    const done = c.callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'console check' } }, undefined, {
      timeout: 30_000,
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(parentPidFile)) {
      if (Date.now() > deadline) throw new Error(`stub never wrote ${parentPidFile}`);
      await sleep(100);
    }
    const supervisorPid = Number(readFileSync(parentPidFile, 'utf8'));
    // A console-less supervisor makes Windows open a new console window for every
    // console program it starts: node-pty's agent on each pty.kill(), taskkill.
    expect(await consoleProcessList(supervisorPid), 'the supervisor has no console').toEqual(
      expect.arrayContaining([supervisorPid]),
    );
    await done;
  }, 30_000);
});
