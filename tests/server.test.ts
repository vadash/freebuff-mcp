import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestPipe, waitForPipe } from '../src/ipc.ts';
import { expectExit, makeDirs, plainEnv, pollStatus, serverEntry, startSupervisor, uniquePipe, type HarnessDirs, type HarnessOptions, type SupervisorProcess } from './helpers/harness.ts';
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
    env: plainEnv({ pipeName, mode, settings: { model: 'opus-test' }, ...dirs, ...extra }),
  });
  client = new Client({ name: 'test-client', version: '0.0.0' });
  return client;
};

const toolText = (result: CallResult): string => {
  expect(result.isError).toBeFalsy();
  return result.content[0]!.text ?? '';
};

const chatsRoot = (configDir: string, taskDir: string): string =>
  join(
    configDir,
    'manicode',
    'projects',
    `${basename(taskDir)}--${createHash('sha256').update(resolve(taskDir)).digest('hex').slice(0, 12)}`,
    'chats',
  );

describe('freebuff MCP server (stdio, tools bind/run_prompt/status)', () => {
  beforeEach(() => {
    pipeName = uniquePipe('mcp');
    dirs = makeDirs({ model: 'opus-test' });
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

  it('binds, runs two queued prompts in order, and parks at the picker with /new per task', async () => {
    const c = boot('happy');
    await c.connect(transport!);
    toolText((await c.callTool({ name: 'bind', arguments: { dir: dirs.taskDir } })) as CallResult);
    const completions: string[] = [];
    const first = c
      .callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'task one' } })
      .then((r) => completions.push(toolText(r as CallResult)));
    await pollStatus(pipeName, { state: 'busy' });
    const second = c
      .callTool({ name: 'run_prompt', arguments: { dir: dirs.taskDir, prompt: 'task two' } })
      .then((r) => completions.push(toolText(r as CallResult)));
    await Promise.all([first, second]);
    expect(completions).toEqual(['stub(deepseek/deepseek-v4.1-flash): task one', 'stub(deepseek/deepseek-v4.1-flash): task two']);
    const status = await pollStatus(pipeName, { state: 'parked', activeModel: 'deepseek/deepseek-v4.1-flash', queueDepth: 0 });
    expect(status.boundDir).toContain('freebuff-sup-task-');
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
    const status = await pollStatus(pipeName, { state: 'idle', activeModel: null, boundDir: null });
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
    await pollStatus(pipeName, { state: 'idle', queueDepth: 0 });
    const idleReset = (await c.callTool({ name: 'new_session', arguments: {} })) as CallResult;
    toolText(idleReset);
    const next = (await c.callTool({
      name: 'run_prompt',
      arguments: { dir: dirs.taskDir, prompt: 'after reset' },
    })) as CallResult;
    expect(toolText(next)).toBe('stub(deepseek/deepseek-v4.1-flash): after reset');
  }, 90_000);

  it('survives the MCP client disconnecting and completes the in-flight task', async () => {
    supervisorProc = startSupervisor({
      pipeName,
      mode: 'slow',
      delayMs: 3000,
      settings: { model: 'opus-test' },
      ...dirs,
    });
    await waitForPipe(pipeName, 10_000);
    const first = boot('slow');
    const firstEnv = plainEnv({ pipeName, mode: 'slow', delayMs: 3000, settings: { model: 'opus-test' }, ...dirs });
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
    await pollStatus(pipeName, { state: 'parked', queueDepth: 0, activeModel: 'deepseek/deepseek-v4.1-flash' });
    const status = JSON.parse(
      toolText((await second.callTool({ name: 'status', arguments: {} })) as CallResult),
    ) as Record<string, unknown>;
    expect(status).toMatchObject({ state: 'parked', queueDepth: 0, activeModel: 'deepseek/deepseek-v4.1-flash' });
    expect(String(status.boundDir)).toContain('freebuff-sup-task-');
  }, 60_000);
});
