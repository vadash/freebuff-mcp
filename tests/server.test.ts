import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestPipe, waitForPipe } from '../src/ipc.ts';
import { consoleProcessList, expectExit, makeDirs, plainEnv, pollStatus, serverEntry, startSupervisor, uniquePipe, type HarnessDirs, type HarnessOptions, type SupervisorProcess } from './helpers/harness.ts';
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

const chatsRoot = (configDir: string, taskDir: string): string =>
  join(configDir, 'projects', basename(taskDir), 'chats');

describe('freebuff MCP server (stdio, tools bind/run_prompt/status)', () => {
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

  it('binds, runs two queued prompts in order, and idles at ready with /new per task', async () => {
    const c = boot('happy');
    await c.connect(transport!);
    toolText((await c.callTool({ name: 'bind', arguments: { dir: dirs.taskDir } })) as CallResult);
    await pollStatus(pipeName, { state: 'picker' });
    const pickerStatus = JSON.parse(toolText((await c.callTool({ name: 'status', arguments: {} })) as CallResult)) as Record<string, unknown>;
    expect(pickerStatus).toMatchObject({ state: 'picker', freebucksDaily: 25, hourSessionMinutesLeft: null });
    const completions: string[] = [];
    const first = c
      .callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'task one' } })
      .then((r) => completions.push(toolText(r as CallResult)));
    await pollStatus(pipeName, { state: 'busy' });
    const second = c
      .callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'task two' } })
      .then((r) => completions.push(toolText(r as CallResult)));
    await Promise.all([first, second]);
    expect(completions).toEqual(['stub(DeepSeek V4.1 Flash): task one', 'stub(DeepSeek V4.1 Flash): task two']);
    const status = await pollStatus(pipeName, { state: 'ready', activeModel: 'DeepSeek V4.1 Flash', queueDepth: 0 });
    expect(status.boundDir).toContain('freebuff-sup-task-');
    const toolStatus = JSON.parse(toolText((await c.callTool({ name: 'status', arguments: {} })) as CallResult)) as Record<string, unknown>;
    expect(toolStatus.hourSessionMinutesLeft).toBe(432);
    expect(toolStatus.freebucksDaily).toBeNull();
    const chatDirs = readdirSync(chatsRoot(dirs.configDir, dirs.taskDir));
    expect(chatDirs.length).toBeGreaterThanOrEqual(2);
    for (const dir of chatDirs) expect(dir.startsWith('chat-new-')).toBe(true);
  }, 90_000);

  it('errors run_prompt when nothing is bound, without spawning', async () => {
    const c = boot('happy');
    await c.connect(transport!);
    const result = (await c.callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'x' } })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/bound/i);
    const status = await pollStatus(pipeName, { state: 'stopped', activeModel: null, boundDir: null });
    expect(status.queueDepth).toBe(0);
  }, 60_000);

  it('errors run_prompt on a directory mismatch, naming the bound directory', async () => {
    const c = boot('happy');
    await c.connect(transport!);
    toolText((await c.callTool({ name: 'bind', arguments: { dir: dirs.taskDir } })) as CallResult);
    const result = (await c.callTool({ name: 'run_prompt', arguments: { dir: dirs.otherDir, prompt: 'x' } })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(resolve(dirs.taskDir));
  }, 60_000);

  it('surfaces the bind lock as an MCP error naming the bound directory', async () => {
    const c = boot('happy', { stubEnv: { FREEBUFF_STUB_SESSION_ALIVE: '1', FREEBUFF_STUB_COUNTDOWN_MIN: '45' } });
    await c.connect(transport!);
    toolText((await c.callTool({ name: 'bind', arguments: { dir: dirs.taskDir } })) as CallResult);
    await pollStatus(pipeName, { state: 'ready', hourSessionMinutesLeft: 45 });
    const locked = (await c.callTool({ name: 'bind', arguments: { dir: dirs.otherDir } })) as CallResult;
    expect(locked.isError).toBe(true);
    expect(locked.content[0]!.text).toMatch(/bound_dir_locked/);
    expect(locked.content[0]!.text).toContain(resolve(dirs.taskDir));
  }, 60_000);

  it('cancels the active task and resets the session through the new tools', async () => {
    const c = boot('slow', { delayMs: 4000 });
    await c.connect(transport!);
    toolText((await c.callTool({ name: 'bind', arguments: { dir: dirs.taskDir } })) as CallResult);
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
    expect(toolText(next)).toBe('stub(DeepSeek V4.1 Flash): after reset');
  }, 90_000);

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
    toolText((await first.callTool({ name: 'bind', arguments: { dir: dirs.taskDir } })) as CallResult);
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
    expect(String(status.boundDir)).toContain('freebuff-sup-task-');
  }, 60_000);

  it('runs the doctor protocol check through the supervisor op', async () => {
    const c = boot('happy');
    await c.connect(transport!);
    const report = JSON.parse(toolText((await c.callTool({ name: 'doctor', arguments: {} })) as CallResult)) as {
      ok: boolean;
      failures: string[];
    };
    expect(report).toEqual({ ok: true, failures: [] });
  }, 30_000);

  it('starts the supervisor with a console, so programs it starts open no console window', async () => {
    const parentPidFile = join(dirs.otherDir, 'instance-parent.pid');
    const c = boot('happy', { stubEnv: { FREEBUFF_STUB_PARENT_PID_FILE: parentPidFile } });
    await c.connect(transport!);
    toolText((await c.callTool({ name: 'bind', arguments: { dir: dirs.taskDir } })) as CallResult);
    await pollStatus(pipeName, { state: 'picker' });
    const supervisorPid = Number(readFileSync(parentPidFile, 'utf8'));
    // A console-less supervisor makes Windows open a new console window for every
    // console program it starts: node-pty's agent on each pty.kill(), taskkill.
    expect(await consoleProcessList(supervisorPid), 'the supervisor has no console').toEqual(
      expect.arrayContaining([supervisorPid]),
    );
  }, 30_000);
});
