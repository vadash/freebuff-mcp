import { statSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QUEUE_DEPTH, SUPERVISOR_PIPE, TASK_TIMEOUT_MS } from './config.ts';
import { FreebuffDriver } from './driver.ts';
import type { DriverOptions } from './driver.ts';
import { pipeReachable, waitForPipe } from './ipc.ts';

export type SupervisorState = 'idle' | 'spawning' | 'busy' | 'parked';

export interface SupervisorConfig {
  pipeName?: string;
  driver?: DriverOptions;
  taskTimeoutMs?: number;
}

export type SupervisorRequest =
  | { op: 'bind'; dir: string }
  | { op: 'run_prompt'; dir: string; prompt: string }
  | { op: 'status' }
  | { op: 'shutdown' };

export type SupervisorResponse =
  | { ok: true }
  | { ok: true; answer: string }
  | { ok: true; state: SupervisorState; boundDir: string | null; queueDepth: number; activeModel: string | null }
  | { ok: false; error: string }
  | { ok: false; busy: true; position: number; error: string };

interface QueuedTask {
  prompt: string;
  reply: (response: SupervisorResponse) => void;
}

export const defaultDriverOptions = (): DriverOptions => ({
  executable: 'freebuff',
  configDir: join(homedir(), '.freebuff'),
});

export class Supervisor {
  private state: SupervisorState = 'idle';
  private boundDir: string | null = null;
  private readonly queue: QueuedTask[] = [];
  private active: QueuedTask | null = null;
  private activeModel: string | null = null;
  private readonly driver: FreebuffDriver;
  private readonly taskTimeoutMs: number;
  private readonly pipeName: string;
  private readonly configDir: string;

  constructor(config: SupervisorConfig = {}) {
    this.pipeName = config.pipeName ?? SUPERVISOR_PIPE;
    this.taskTimeoutMs = config.taskTimeoutMs ?? TASK_TIMEOUT_MS;
    this.configDir = config.driver?.configDir ?? defaultDriverOptions().configDir;
    this.driver = new FreebuffDriver({
      ...(config.driver ?? defaultDriverOptions()),
      keepAlive: true,
      onReady: () => {
        if (this.state === 'spawning') this.state = 'busy';
        this.activeModel = readModelSlug(this.configDir);
      },
    });
  }

  async listen(): Promise<Server> {
    const server = createServer((socket) => this.onConnection(socket));
    return await new Promise<Server>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(this.pipeName, () => {
        server.removeListener('error', reject);
        resolveListen(server);
      });
    });
  }

  handle = async (request: SupervisorRequest, reply: (response: SupervisorResponse) => void): Promise<void> => {
    switch (request.op) {
      case 'bind':
        reply(this.bind(request.dir));
        break;
      case 'run_prompt':
        await this.runPrompt(request.dir, request.prompt, reply);
        break;
      case 'status':
        reply({
          ok: true,
          state: this.state,
          boundDir: this.boundDir,
          queueDepth: this.queue.length,
          activeModel: this.activeModel,
        });
        break;
      case 'shutdown':
        this.driver.kill();
        reply({ ok: true });
        setTimeout(() => process.exit(0), 100).unref();
        break;
      default:
        reply({ ok: false, error: `unsupported op: ${JSON.stringify(request)}` });
        break;
    }
  };

  private bind(dir: string): SupervisorResponse {
    if (this.active !== null || this.queue.length > 0) {
      return { ok: false, error: 'bind rejected: a task is active or queued' };
    }
    let resolved: string;
    try {
      resolved = resolve(dir);
      if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
    } catch {
      return { ok: false, error: `bind failed: ${dir} is not an existing directory` };
    }
    this.driver.kill();
    this.boundDir = resolved;
    this.state = 'idle';
    return { ok: true };
  }

  private async runPrompt(dir: string, prompt: string, reply: (response: SupervisorResponse) => void): Promise<void> {
    if (this.boundDir === null) {
      reply({ ok: false, error: 'run_prompt failed: no directory is bound' });
      return;
    }
    const resolved = resolve(dir);
    if (resolved !== this.boundDir) {
      reply({ ok: false, error: `run_prompt failed: ${dir} does not match the bound directory ${this.boundDir}` });
      return;
    }
    if (this.active !== null && this.queue.length >= QUEUE_DEPTH) {
      reply({
        ok: false,
        busy: true,
        position: this.queue.length + 1,
        error: `queue full: ${this.queue.length} tasks queued ahead`,
      });
      return;
    }
    const { promise, resolve: done } = Promise.withResolvers<void>();
    this.queue.push({
      prompt,
      reply: (response) => {
        reply(response);
        done();
      },
    });
    this.pump();
    await promise;
  }

  private pump(): void {
    if (this.active !== null || this.queue.length === 0) return;
    const task = this.queue.shift()!;
    this.active = task;
    this.state = this.driver.isAlive() ? 'busy' : 'spawning';
    void this.runOne(task);
  }

  private async runOne(task: QueuedTask): Promise<void> {
    const work = this.driver.runTask(this.boundDir!, task.prompt);
    work.catch(() => {});
    try {
      const answer = await withTimeout(work, this.taskTimeoutMs, `task timed out after ${this.taskTimeoutMs}ms`);
      await this.driver.park();
      this.state = 'parked';
      task.reply({ ok: true, answer });
    } catch (error) {
      this.driver.kill();
      this.state = 'idle';
      task.reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.active = null;
      this.pump();
    }
  }

  private onConnection(socket: Socket): void {
    socket.on('error', () => {});
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() !== '') void this.dispatch(line, socket);
      }
    });
  }

  private async dispatch(line: string, socket: Socket): Promise<void> {
    let request: SupervisorRequest;
    try {
      request = JSON.parse(line) as SupervisorRequest;
    } catch {
      this.send(socket, { ok: false, error: 'malformed request: expected a JSON line' });
      return;
    }
    try {
      await this.handle(request, (response) => this.send(socket, response));
    } catch (error) {
      this.send(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private send(socket: Socket, response: SupervisorResponse): void {
    if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
  }
}

const readModelSlug = (configDir: string): string | null => {
  try {
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { model?: unknown };
    return typeof settings.model === 'string' ? settings.model : null;
  } catch {
    return null;
  }
};

const withTimeout = async <T>(work: Promise<T>, ms: number, message: string): Promise<T> => {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(message)), ms);
  try {
    return await Promise.race([work, promise]);
  } finally {
    clearTimeout(timer);
  }
};

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const pipeName = process.env.FREEBUFF_SUPERVISOR_PIPE ?? SUPERVISOR_PIPE;
  const driver = process.env.FREEBUFF_DRIVER_JSON
    ? (JSON.parse(process.env.FREEBUFF_DRIVER_JSON) as DriverOptions)
    : defaultDriverOptions();
  const taskTimeoutMs = Number(process.env.FREEBUFF_TASK_TIMEOUT_MS) || TASK_TIMEOUT_MS;
  const main = async (): Promise<void> => {
    if (await pipeReachable(pipeName, 250)) process.exit(0);
    const supervisor = new Supervisor({ pipeName, driver, taskTimeoutMs });
    try {
      await supervisor.listen();
    } catch (error) {
      if (await pipeReachable(pipeName, 5_000)) process.exit(0);
      throw error;
    }
    await waitForPipe(pipeName, 1_000);
  };
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
