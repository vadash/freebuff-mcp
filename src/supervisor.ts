import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FREEZE_THRESHOLD_MINUTES, MAX_TASK_RESPAWNS, PASTE_THRESHOLD_BYTES, QUEUE_DEPTH, SUPERVISOR_PIPE, TASK_TIMEOUT_MS, resolveModelPolicy } from './config.ts';
import { FreebuffDriver } from './driver.ts';
import type { DriverOptions } from './driver.ts';
import { FreebuffDriverError } from './driver.ts';
import { runDoctor } from './doctor.ts';
import { pipeReachable, waitForPipe } from './ipc.ts';

export type SupervisorState = 'idle' | 'spawning' | 'busy' | 'parked';

export interface SupervisorConfig {
  pipeName?: string;
  driver?: DriverOptions;
  taskTimeoutMs?: number;
  freezeThresholdMs?: number;
}

export type SupervisorRequest =
  | { op: 'bind'; dir: string }
  | { op: 'run_prompt'; dir: string; prompt: string }
  | { op: 'cancel_task' }
  | { op: 'new_session' }
  | { op: 'status' }
  | { op: 'doctor' }
  | { op: 'shutdown' };

export type SupervisorResponse =
  | { ok: true }
  | { ok: true; answer: string }
  | {
      ok: true;
      state: SupervisorState;
      boundDir: string | null;
      queueDepth: number;
      activeModel: string | null;
      trialMinutesLeft: number | null;
      freebucksDaily: string | null;
      needsLogin: boolean;
      updatePending: { running: string; onDisk: string } | null;
    }
  | { ok: false; error: string }
  | { ok: false; busy: true; position: number; error: string }
  | { ok: true; failures: string[] };

interface QueuedTask {
  prompt: string;
  cancelled?: boolean;
  reply: (response: SupervisorResponse) => void;
}

const FROZEN = Symbol('frozen');

export const defaultDriverOptions = (): DriverOptions => ({
  ...resolveFreebuffCommand(),
  configDir: join(homedir(), '.config', 'manicode'),
});

const resolveFreebuffCommand = (): { executable: string; argsPrefix: string[] } => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    if (existsSync(join(dir, 'freebuff.exe'))) return { executable: join(dir, 'freebuff.exe'), argsPrefix: [] };
    if (existsSync(join(dir, 'freebuff.cmd'))) {
      return { executable: process.execPath, argsPrefix: [join(dir, 'node_modules', 'freebuff', 'index.js')] };
    }
  }
  return { executable: 'freebuff', argsPrefix: [] };
};

export class Supervisor {
  private state: SupervisorState = 'idle';
  private boundDir: string | null = null;
  private readonly queue: QueuedTask[] = [];
  private active: QueuedTask | null = null;
  private activeModel: string | null = null;
  private readonly driver: FreebuffDriver;
  private readonly taskTimeoutMs: number;
  private readonly freezeMs: number;
  private readonly pipeName: string;
  private readonly configDir: string;
  private tempCounter = 0;

  constructor(config: SupervisorConfig = {}) {
    this.pipeName = config.pipeName ?? SUPERVISOR_PIPE;
    this.taskTimeoutMs = config.taskTimeoutMs ?? TASK_TIMEOUT_MS;
    this.freezeMs = config.freezeThresholdMs ?? FREEZE_THRESHOLD_MINUTES * 60_000;
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
      case 'cancel_task':
        await this.cancelTask(reply);
        break;
      case 'new_session':
        reply(this.newSession());
        break;
      case 'status': {
        const probe = this.driver.probe();
        reply({
          ok: true,
          state: this.state,
          boundDir: this.boundDir,
          queueDepth: this.queue.length,
          activeModel: this.activeModel,
          trialMinutesLeft: probe.trialMinutesLeft,
          freebucksDaily: probe.freebucksDaily,
          needsLogin: this.driver.needsLogin(),
          updatePending:
            probe.runningVersion !== null &&
            probe.onDiskVersion !== null &&
            versionNewer(probe.onDiskVersion, probe.runningVersion)
              ? { running: probe.runningVersion, onDisk: probe.onDiskVersion }
              : null,
        });
        break;
      }
      case 'doctor':
        reply({ ok: true, failures: (await runDoctor()).failures });
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
    // Issue #5: a rebind is blocked only by an active task; queued tasks are purged.
    if (this.active !== null) {
      return { ok: false, error: 'bind rejected: a task is active' };
    }
    for (const task of this.queue.splice(0)) {
      task.reply({ ok: false, error: 'rebind purged this queued task: the directory was rebound' });
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

  private async cancelTask(reply: (response: SupervisorResponse) => void): Promise<void> {
    const task = this.active;
    if (task === null || this.state !== 'busy') {
      reply({ ok: false, error: 'cancel_task failed: no task is active' });
      return;
    }
    task.cancelled = true;
    await this.driver.cancelActive();
    reply({ ok: true });
  }

  private newSession(): SupervisorResponse {
    if (this.active !== null || this.queue.length > 0) {
      return { ok: false, error: 'new_session failed: a task is active or queued' };
    }
    this.driver.kill();
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

  private async supervised(task: QueuedTask, prompt: string): Promise<string> {
    let respawns = 0;
    for (;;) {
      const work = this.driver.runTask(this.boundDir!, prompt);
      work.catch(() => {});
      const freeze = this.watchFreeze(task);
      let answer: string | typeof FROZEN;
      try {
        answer = await Promise.race([
          withTimeout(work, this.taskTimeoutMs, `task timed out after ${this.taskTimeoutMs}ms`),
          freeze.promise,
        ]);
      } catch (error) {
        const crash = error instanceof FreebuffDriverError && error.reason === 'process-exited' && !task.cancelled;
        if (!crash) throw error;
        if (respawns >= MAX_TASK_RESPAWNS) throw new Error('freebuff driver crashed: respawn limit reached');
        respawns += 1;
        await this.respawnDriver();
        continue;
      } finally {
        freeze.stop();
      }
      if (answer !== FROZEN) return answer;
      if (task.cancelled) throw new Error('task cancelled');
      if (respawns >= MAX_TASK_RESPAWNS) throw new Error('freebuff driver crashed: respawn limit reached');
      respawns += 1;
      await this.respawnDriver();
    }
  }

  private watchFreeze(task: QueuedTask): { promise: Promise<typeof FROZEN>; stop(): void } {
    const dir = this.boundDir!;
    let lastLog = this.driver.newestLogSize(dir);
    let lastScreen = this.driver.screenText();
    let lastChange = Date.now();
    const { promise, resolve } = Promise.withResolvers<typeof FROZEN>();
    const timer = setInterval(() => {
      if (this.active !== task || task.cancelled) {
        clearInterval(timer);
        return;
      }
      const log = this.driver.newestLogSize(dir);
      const screen = this.driver.screenText();
      if (log !== lastLog || screen !== lastScreen) {
        lastLog = log;
        lastScreen = screen;
        lastChange = Date.now();
        return;
      }
      if (Date.now() - lastChange >= this.freezeMs) {
        clearInterval(timer);
        resolve(FROZEN);
      }
    }, Math.min(1_000, Math.max(50, Math.floor(this.freezeMs / 4))));
    return { promise, stop: () => clearInterval(timer) };
  }

  private async respawnDriver(): Promise<void> {
    this.state = 'spawning';
    await this.driver.stop();
    applyModelPolicy(this.configDir);
  }

  private async runOne(task: QueuedTask): Promise<void> {
    let tempFile: string | null = null;
    try {
      try {
        this.activeModel = applyModelPolicy(this.configDir);
      } catch (error) {
        throw new Error(`model policy failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      let prompt = task.prompt;
      if (Buffer.byteLength(prompt, 'utf8') > PASTE_THRESHOLD_BYTES) {
        tempFile = join(this.boundDir!, `.freebuff-task-${++this.tempCounter}.md`);
        writeFileSync(tempFile, prompt);
        prompt = `Read the instructions in ${basename(tempFile)} in the current directory and follow them.`;
      }
      const answer = await this.supervised(task, prompt);
      await this.driver.park();
      this.state = 'parked';
      task.reply({ ok: true, answer });
    } catch (error) {
      this.driver.kill();
      this.state = 'idle';
      task.reply(
        task.cancelled
          ? { ok: false, error: 'task cancelled' }
          : { ok: false, error: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      if (tempFile !== null) rmSync(tempFile, { force: true });
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
    const settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { freebuffModel?: unknown };
    return typeof settings.freebuffModel === 'string' ? settings.freebuffModel : null;
  } catch {
    return null;
  }
};

const applyModelPolicy = (configDir: string): string => {
  const [head] = resolveModelPolicy();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    settings = {};
  }
  settings.freebuffModel = head;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  return head;
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

const versionNewer = (candidate: string, current: string): boolean => {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
};

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const pipeName = process.env.FREEBUFF_SUPERVISOR_PIPE ?? SUPERVISOR_PIPE;
  const driver = process.env.FREEBUFF_DRIVER_JSON
    ? (JSON.parse(process.env.FREEBUFF_DRIVER_JSON) as DriverOptions)
    : defaultDriverOptions();
  const taskTimeoutMs = Number(process.env.FREEBUFF_TASK_TIMEOUT_MS) || TASK_TIMEOUT_MS;
  const freezeThresholdMs = Number(process.env.FREEBUFF_FREEZE_THRESHOLD_MS) || FREEZE_THRESHOLD_MINUTES * 60_000;
  const main = async (): Promise<void> => {
    if (await pipeReachable(pipeName, 250)) process.exit(0);
    const supervisor = new Supervisor({ pipeName, driver, taskTimeoutMs, freezeThresholdMs });
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
