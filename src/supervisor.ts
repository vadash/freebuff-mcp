import { mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { FREEZE_POLL_MAX_MS, FREEZE_POLL_MIN_MS, FREEZE_THRESHOLD_MS, MAX_TASK_RESPAWNS, PASTE_THRESHOLD_BYTES, PIPE_CONNECT_TIMEOUT_MS, PIPE_PROBE_TIMEOUT_MS, QUEUE_DEPTH, SHUTDOWN_EXIT_MS, STARTUP_PIPE_WAIT_MS, SUPERVISOR_PIPE, TASK_TIMEOUT_MS, resolveModelPolicy } from './config.ts';
import { FreebuffDriver, defaultDriverOptions } from './driver.ts';
import type { DriverOptions } from './driver.ts';
import { FreebuffDriverError } from './driver.ts';
import { runDoctor } from './doctor.ts';
import { SETTINGS_FILENAME } from './protocol/markers.ts';
import { classifyScreen } from './protocol/screen.ts';
import { pipeReachable, waitForPipe } from './ipc.ts';
import { errorMessage, readSettings } from './util.ts';
import { isMainModule, mainOptions } from './entry.ts';

export type SupervisorState = 'stopped' | 'spawning' | 'picker' | 'ready' | 'busy';

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

// The status field list is defined once, here. Field names are the public wire
// contract.
export interface StatusPayload {
  state: SupervisorState;
  boundDir: string | null;
  queueDepth: number;
  activeModel: string | null;
  hourSessionMinutesLeft: number | null;
  freebucksDaily: number | null;
  needsLogin: boolean;
  updatePending: { running: string; onDisk: string } | null;
}

export type SupervisorResponse =
  | { ok: true; kind: 'ok' }
  | { ok: true; kind: 'answer'; answer: string }
  | ({ ok: true; kind: 'status' } & StatusPayload)
  | { ok: true; kind: 'doctor'; failures: string[] }
  | { ok: false; kind: 'error'; error: string }
  | { ok: false; kind: 'busy'; busy: true; position: number; error: string };

interface QueuedTask {
  prompt: string;
  cancelled?: boolean;
  reply: (response: SupervisorResponse) => void;
}

const FROZEN = Symbol('frozen');

export class Supervisor {
  private state: SupervisorState = 'stopped';
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
    this.freezeMs = config.freezeThresholdMs ?? FREEZE_THRESHOLD_MS;
    this.configDir = config.driver?.configDir ?? defaultDriverOptions().configDir;
    this.driver = new FreebuffDriver({
      ...(config.driver ?? defaultDriverOptions()),
      keepAlive: true,
      onReady: () => {
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
        await this.bindInstance(request.dir, reply);
        break;
      case 'run_prompt':
        await this.runPrompt(request.dir, request.prompt, reply);
        break;
      case 'cancel_task':
        await this.cancelTask(reply);
        break;
      case 'new_session':
        reply(this.newConversation());
        break;
      case 'status': {
        const probe = this.driver.probe();
        reply({
          ok: true,
          kind: 'status',
          state: this.observedState(),
          boundDir: this.boundDir,
          queueDepth: this.queue.length,
          activeModel: this.activeModel,
          hourSessionMinutesLeft: probe.hourSessionMinutesLeft,
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
        reply({ ok: true, kind: 'doctor', failures: (await runDoctor()).failures });
        break;
      case 'shutdown':
        this.driver.kill();
        reply({ ok: true, kind: 'ok' });
        setTimeout(() => process.exit(0), SHUTDOWN_EXIT_MS).unref();
        break;
      default:
        reply({ ok: false, kind: 'error', error: `unsupported op: ${JSON.stringify(request)}` });
        break;
    }
  };

  private async bindInstance(dir: string, reply: (response: SupervisorResponse) => void): Promise<void> {
    // Issue #5: a rebind is blocked only by an active task; queued tasks are purged.
    if (this.active !== null) {
      reply({ ok: false, kind: 'error', error: 'bind rejected: a task is active' });
      return;
    }
    for (const task of this.queue.splice(0)) {
      task.reply({ ok: false, kind: 'error', error: 'rebind purged this queued task: the directory was rebound' });
    }
    let resolved: string;
    try {
      resolved = resolve(dir);
      if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
    } catch {
      reply({ ok: false, kind: 'error', error: `bind failed: ${dir} is not an existing directory` });
      return;
    }
    this.driver.kill();
    this.boundDir = resolved;
    this.state = 'spawning';
    try {
      this.activeModel = applyModelPolicy(this.configDir);
      this.state = await this.driver.awaitIdle(resolved);
      reply({ ok: true, kind: 'ok' });
    } catch (error) {
      this.driver.kill();
      this.state = 'stopped';
      reply({ ok: false, kind: 'error', error: `bind failed: ${errorMessage(error)}` });
    }
  }

  private async cancelTask(reply: (response: SupervisorResponse) => void): Promise<void> {
    const task = this.active;
    if (task === null) {
      reply({ ok: false, kind: 'error', error: 'cancel_task failed: no task is active' });
      return;
    }
    task.cancelled = true;
    await this.driver.cancelActive();
    reply({ ok: true, kind: 'ok' });
  }

  private newConversation(): SupervisorResponse {
    if (this.active !== null || this.queue.length > 0) {
      return { ok: false, kind: 'error', error: 'new_session failed: a task is active or queued' };
    }
    this.driver.kill();
    this.state = 'stopped';
    return { ok: true, kind: 'ok' };
  }

  private observedState(): SupervisorState {
    if (this.active !== null) return 'busy';
    if (this.state === 'spawning') return 'spawning';
    return this.screenState();
  }

  private screenState(): SupervisorState {
    if (!this.driver.isAlive()) return 'stopped';
    const verdict = classifyScreen(this.driver.screenText());
    if (verdict.ready) return 'ready';
    if (verdict.picker !== null || verdict.continueScreen) return 'picker';
    return 'stopped';
  }

  private async runPrompt(dir: string, prompt: string, reply: (response: SupervisorResponse) => void): Promise<void> {
    if (this.boundDir === null) {
      reply({ ok: false, kind: 'error', error: 'run_prompt failed: no directory is bound' });
      return;
    }
    const resolved = resolve(dir);
    if (resolved !== this.boundDir) {
      reply({ ok: false, kind: 'error', error: `run_prompt failed: ${dir} does not match the bound directory ${this.boundDir}` });
      return;
    }
    if (this.active !== null && this.queue.length >= QUEUE_DEPTH) {
      reply({
        ok: false,
        kind: 'busy',
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
    const respawnOrLimit = async (): Promise<void> => {
      if (respawns >= MAX_TASK_RESPAWNS) throw new Error('freebuff driver crashed: respawn limit reached');
      respawns += 1;
      await this.respawnDriver();
    };
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
        const crash = error instanceof FreebuffDriverError && error.reason === 'process_exited' && !task.cancelled;
        if (!crash) throw error;
        await respawnOrLimit();
        continue;
      } finally {
        freeze.stop();
      }
      if (answer !== FROZEN) return answer;
      if (task.cancelled) throw new Error('task cancelled');
      await respawnOrLimit();
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
    }, Math.min(FREEZE_POLL_MAX_MS, Math.max(FREEZE_POLL_MIN_MS, Math.floor(this.freezeMs / 4))));
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
        throw new Error(`model policy failed: ${errorMessage(error)}`);
      }
      let prompt = task.prompt;
      if (Buffer.byteLength(prompt, 'utf8') > PASTE_THRESHOLD_BYTES) {
        tempFile = join(this.boundDir!, `.freebuff-task-${++this.tempCounter}.md`);
        writeFileSync(tempFile, prompt);
        prompt = `Read the instructions in ${basename(tempFile)} in the current directory and follow them.`;
      }
      const answer = await this.supervised(task, prompt);
      this.state = this.screenState();
      task.reply({ ok: true, kind: 'answer', answer });
    } catch (error) {
      this.driver.kill();
      this.state = 'stopped';
      task.reply(
        task.cancelled
          ? { ok: false, kind: 'error', error: 'task cancelled' }
          : { ok: false, kind: 'error', error: errorMessage(error) },
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
      this.send(socket, { ok: false, kind: 'error', error: 'malformed request: expected a JSON line' });
      return;
    }
    try {
      await this.handle(request, (response) => this.send(socket, response));
    } catch (error) {
      this.send(socket, { ok: false, kind: 'error', error: errorMessage(error) });
    }
  }

  private send(socket: Socket, response: SupervisorResponse): void {
    if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
  }
}

const readModelSlug = (configDir: string): string | null => {
  const settings = readSettings(configDir);
  return typeof settings.freebuffModel === 'string' ? settings.freebuffModel : null;
};

const applyModelPolicy = (configDir: string): string => {
  const [head] = resolveModelPolicy();
  const settings = readSettings(configDir);
  settings.freebuffModel = head;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, SETTINGS_FILENAME), JSON.stringify(settings, null, 2));
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

if (isMainModule(import.meta.url)) {
  const main = async (): Promise<void> => {
    const { pipeName, driver, taskTimeoutMs } = mainOptions();
    const freezeThresholdMs = Number(process.env.FREEBUFF_FREEZE_THRESHOLD_MS) || FREEZE_THRESHOLD_MS;
    if (await pipeReachable(pipeName, PIPE_PROBE_TIMEOUT_MS)) process.exit(0);
    const supervisor = new Supervisor({ pipeName, driver, taskTimeoutMs, freezeThresholdMs });
    try {
      await supervisor.listen();
    } catch (error) {
      if (await pipeReachable(pipeName, PIPE_CONNECT_TIMEOUT_MS)) process.exit(0);
      throw error;
    }
    await waitForPipe(pipeName, STARTUP_PIPE_WAIT_MS);
  };
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
