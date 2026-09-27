import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PIPE_PROBE_TIMEOUT_MS, READY_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from './config.ts';
import type { DriverOptions } from './driver.ts';
import type { SupervisorRequest, SupervisorResponse } from './supervisor.ts';
import { pipeReachable, requestPipe, waitForPipe } from './ipc.ts';
import { supervisorFingerprint } from './supervisorLock.ts';
import { sleep } from './util.ts';
import { isMainModule, mainOptions } from './entry.ts';

const supervisorEntry = resolve(dirname(fileURLToPath(import.meta.url)), 'supervisor.ts');

export interface SupervisorClientOptions {
  pipeName: string;
  driver: DriverOptions;
  taskTimeoutMs: number;
  spawnIfMissing?: boolean;
}

export class SupervisorClient {
  private readonly options: SupervisorClientOptions;
  private readonly spawnIfMissing: boolean;
  readonly taskTimeoutMs: number;

  constructor(options: SupervisorClientOptions) {
    this.options = options;
    this.spawnIfMissing = options.spawnIfMissing ?? true;
    this.taskTimeoutMs = options.taskTimeoutMs;
  }

  async request(request: SupervisorRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<SupervisorResponse> {
    await this.ensureStarted();
    return await requestPipe<SupervisorResponse>(this.options.pipeName, request, timeoutMs);
  }

  async ensureStarted(): Promise<void> {
    if (await pipeReachable(this.options.pipeName, PIPE_PROBE_TIMEOUT_MS)) {
      // ADR-0005: a reachable pipe may still be a daemon running older code (the
      // Supervisor outlives MCP reloads). Ask for its fingerprint; on a mismatch, fall
      // through and spawn a replacement, which takes the lock over from the stale one.
      const status = await requestPipe<{ fingerprint?: string }>(this.options.pipeName, { op: 'status' }, REQUEST_TIMEOUT_MS).catch(() => null);
      if (status !== null && status.fingerprint === supervisorFingerprint()) return;
    }
    if (!this.spawnIfMissing) throw new Error(`no supervisor is listening on ${this.options.pipeName}`);
    // Not `detached`: that leaves the supervisor with no console, so Windows opens a
    // console window for every console program it starts (node-pty's agent on each
    // pty.kill(), taskkill). `start /b` under a hidden cmd hands it cmd's hidden console;
    // Node kills cmd with us, but not what cmd started, so the supervisor outlives us.
    const command = `start "" /b "${process.execPath}" --experimental-strip-types "${supervisorEntry}"`;
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
      env: {
        ...process.env,
        FREEBUFF_SUPERVISOR_PIPE: this.options.pipeName,
        FREEBUFF_TASK_TIMEOUT_MS: String(this.options.taskTimeoutMs),
        FREEBUFF_DRIVER_JSON: JSON.stringify(this.options.driver),
      },
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.unref();
    await waitForPipe(this.options.pipeName, READY_TIMEOUT_MS);
    // On a takeover the pipe answers during the handover (the stale daemon holds it
    // until its shutdown lands), so wait — bounded — until the new fingerprint serves.
    // ensureStarted runs per request, so a call that rides the old daemon self-corrects.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const status = await requestPipe<{ fingerprint?: string }>(this.options.pipeName, { op: 'status' }, REQUEST_TIMEOUT_MS).catch(() => null);
      if (status === null || status.fingerprint === supervisorFingerprint()) break;
      if (Date.now() > deadline) break;
      await sleep(150);
    }
  }
}

export const createMcpServer = (client: SupervisorClient): McpServer => {
  const server = new McpServer({ name: 'freebuff-supervisor', version: '0.1.0' });
  server.tool(
    'run_prompt',
    'Queue a prompt against the repo at `dir` and wait for the final answer. Changing `dir` between calls swaps the workspace junction at idle time and purges queued tasks; a change while a task is active is refused. A full queue fails with {busy, position}; a turn that ends without an answer fails with no_answer.',
    { dir: z.string().describe('Real repo directory for this task'), prompt: z.string().describe('Task prompt') },
    async ({ dir, prompt }) =>
      result(await client.request({ op: 'run_prompt', dir, prompt }, client.taskTimeoutMs + REQUEST_TIMEOUT_MS)),
  );
  server.tool(
    'cancel_task',
    'Cancel the active task. The driver is stopped gracefully (ESC then Ctrl-C) and killed if it does not go idle; the next queued task runs afterward.',
    {},
    async () => result(await client.request({ op: 'cancel_task' })),
  );
  server.tool(
    'new_session',
    'Start a new conversation by sending /new to the running freebuff, which keeps running. Rejected while a task is active or queued.',
    {},
    async () => result(await client.request({ op: 'new_session' })),
  );
  server.tool(
    'status',
    'Report supervisor state, the fixed workspace directory the Instance runs in, the repo directory the workspace junction currently targets, queue depth, and active model.',
    {},
    async () => result(await client.request({ op: 'status' })),
  );
  server.tool(
    'screen',
    "Return the running freebuff Instance's current Screen, flattened to text — the exact text the supervisor's Driver and Watchdog read. Works in every supervisor state.",
    {},
    async () => result(await client.request({ op: 'screen' })),
  );
  server.tool(
    'doctor',
    'Report pass, degraded or fail for the showing freebuff screen against its Screen signature, naming the missing Markers when Drift has started.',
    {},
    async () => result(await client.request({ op: 'doctor' })),
  );
  return server;
};

interface ToolContent {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const result = (response: SupervisorResponse): ToolContent => {
  switch (response.kind) {
    case 'answer':
      return { content: [{ type: 'text', text: response.answer }] };
    case 'status': {
      const { ok: _ok, kind: _kind, ...payload } = response;
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
    case 'doctor':
      return { content: [{ type: 'text', text: JSON.stringify({ ok: !response.skipped && response.level === 'pass', skipped: response.skipped, screen: response.screen, level: response.level, missing: response.missing }) }] };
    case 'screen':
      return { content: [{ type: 'text', text: response.screen }] };
    case 'ok':
      return { content: [{ type: 'text', text: 'ok' }] };
    case 'busy':
      return { content: [{ type: 'text', text: JSON.stringify({ busy: true, position: response.position }) }], isError: true };
    case 'error':
      return { content: [{ type: 'text', text: response.error }], isError: true };
  }
};

if (isMainModule(import.meta.url)) {
  const main = async (): Promise<void> => {
    const client = new SupervisorClient(mainOptions());
    const server = createMcpServer(client);
    await server.connect(new StdioServerTransport());
    process.stdin.on('end', () => process.exit(0));
  };
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
