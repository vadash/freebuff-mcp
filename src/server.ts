import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { READY_TIMEOUT_MS, SUPERVISOR_PIPE, TASK_TIMEOUT_MS } from './config.ts';
import type { DriverOptions } from './driver.ts';
import { defaultDriverOptions } from './supervisor.ts';
import type { SupervisorRequest, SupervisorResponse } from './supervisor.ts';
import { pipeReachable, requestPipe, waitForPipe } from './ipc.ts';

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

  async request(request: SupervisorRequest, timeoutMs = 30_000): Promise<SupervisorResponse> {
    await this.ensureStarted();
    return await requestPipe<SupervisorResponse>(this.options.pipeName, request, timeoutMs);
  }

  async ensureStarted(): Promise<void> {
    if (await pipeReachable(this.options.pipeName, 250)) return;
    if (!this.spawnIfMissing) throw new Error(`no supervisor is listening on ${this.options.pipeName}`);
    const child = spawn(process.execPath, ['--experimental-strip-types', supervisorEntry], {
      env: {
        ...process.env,
        FREEBUFF_SUPERVISOR_PIPE: this.options.pipeName,
        FREEBUFF_TASK_TIMEOUT_MS: String(this.options.taskTimeoutMs),
        FREEBUFF_DRIVER_JSON: JSON.stringify(this.options.driver),
      },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    await waitForPipe(this.options.pipeName, READY_TIMEOUT_MS);
  }
}

export const createMcpServer = (client: SupervisorClient): McpServer => {
  const server = new McpServer({ name: 'freebuff-supervisor', version: '0.1.0' });
  server.tool(
    'bind',
    'Bind freebuff to an existing project directory. Rejected while a task is active; rebinding purges queued tasks.',
    { dir: z.string().describe('Project directory to bind') },
    async ({ dir }) => result(await client.request({ op: 'bind', dir })),
  );
  server.tool(
    'run_prompt',
    'Queue a prompt against the bound directory and wait for the final answer. Returns {busy, position} when the queue is full.',
    { dir: z.string().describe('Must equal the bound directory'), prompt: z.string().describe('Task prompt') },
    async ({ dir, prompt }) =>
      result(await client.request({ op: 'run_prompt', dir, prompt }, client.taskTimeoutMs + 30_000)),
  );
  server.tool(
    'cancel_task',
    'Cancel the active task. The driver is stopped gracefully (ESC then Ctrl-C) and killed if it does not go idle; the next queued task runs afterward.',
    {},
    async () => result(await client.request({ op: 'cancel_task' })),
  );
  server.tool(
    'new_session',
    'Reset the session context. Rejected while a task is active or queued; the next task starts with fresh context.',
    {},
    async () => result(await client.request({ op: 'new_session' })),
  );
  server.tool(
    'status',
    'Report supervisor state, bound directory, queue depth, and active model.',
    {},
    async () => result(await client.request({ op: 'status' })),
  );
  server.tool(
    'doctor',
    'Verify terminal markers against pinned fixtures and committed protocol signatures.',
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
  if (response.ok && 'answer' in response) return { content: [{ type: 'text', text: response.answer }] };
  if (response.ok && 'state' in response) {
    const { state, boundDir, queueDepth, activeModel, trialMinutesLeft, freebucksDaily, needsLogin, updatePending } = response;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ state, boundDir, queueDepth, activeModel, trialMinutesLeft, freebucksDaily, needsLogin, updatePending }),
        },
      ],
    };
  }
  if (response.ok && 'failures' in response) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: response.failures.length === 0, failures: response.failures }) }] };
  }
  if (response.ok) return { content: [{ type: 'text', text: 'ok' }] };
  if ('busy' in response) {
    return { content: [{ type: 'text', text: JSON.stringify({ busy: true, position: response.position }) }] };
  }
  return { content: [{ type: 'text', text: response.error }], isError: true };
};

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const main = async (): Promise<void> => {
    const client = new SupervisorClient({
      pipeName: process.env.FREEBUFF_SUPERVISOR_PIPE ?? SUPERVISOR_PIPE,
      driver: process.env.FREEBUFF_DRIVER_JSON
        ? (JSON.parse(process.env.FREEBUFF_DRIVER_JSON) as DriverOptions)
        : defaultDriverOptions(),
      taskTimeoutMs: Number(process.env.FREEBUFF_TASK_TIMEOUT_MS) || TASK_TIMEOUT_MS,
    });
    const server = createMcpServer(client);
    await server.connect(new StdioServerTransport());
    process.stdin.on('end', () => process.exit(0));
  };
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
