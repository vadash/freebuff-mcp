import { appendFileSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { ERROR_LOG_PATH, ERROR_LOG_POLL_MS, FAILURE_SCREEN_LINES, FREEZE_POLL_MAX_MS, FREEZE_POLL_MIN_MS, FREEZE_THRESHOLD_MS, PASTE_THRESHOLD_BYTES, PIPE_CONNECT_TIMEOUT_MS, PIPE_PROBE_TIMEOUT_MS, QUEUE_DEPTH, SHUTDOWN_EXIT_MS, STARTUP_PIPE_WAIT_MS, SUPERVISOR_PIPE, TASK_TIMEOUT_MS } from './config.ts';
import { FreebuffDriver, defaultDriverOptions } from './driver.ts';
import type { DriverOptions } from './driver.ts';
import { FreebuffDriverError } from './driver.ts';
import { checkMarkers } from './doctor.ts';
import { classifyScreen, errorLines, freezeSignature, screenExcerpt } from './protocol/screen.ts';
import { pipeReachable, waitForPipe } from './ipc.ts';
import { errorMessage } from './util.ts';
import { isMainModule, mainOptions } from './entry.ts';

export type SupervisorState = 'stopped' | 'spawning' | 'picker' | 'ready' | 'busy';

export interface SupervisorConfig {
  pipeName?: string;
  driver?: DriverOptions;
  taskTimeoutMs?: number;
  freezeThresholdMs?: number;
  errorLogPath?: string;
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
  | { ok: true; kind: 'doctor'; skipped: boolean; failures: string[] }
  | { ok: false; kind: 'error'; error: string }
  | { ok: false; kind: 'busy'; busy: true; position: number; error: string };

interface QueuedTask {
  prompt: string;
  cancelled?: boolean;
  // Answered while the Watchdog respawns the Instance behind it; no longer cancellable.
  answered?: boolean;
  reply: (response: SupervisorResponse) => void;
}

type WatchdogReason = 'frozen' | 'crashed' | 'deadline';

// The Watchdog's verdict on a Task, with the last Screen lines for the caller.
class WatchdogFailure extends Error {
  readonly reason: WatchdogReason;
  constructor(reason: WatchdogReason, detail: string, screen: string) {
    super(`watchdog failure: ${reason}: ${detail}\nlast screen lines:\n${screen}`);
    this.name = 'WatchdogFailure';
    this.reason = reason;
  }
}

// Issue #14: switching directories abandons an Hour session with more than this
// much time left on it; the supervisor refuses until the window narrows.
const BIND_LOCK_GRACE_MINUTES = 30;

export class Supervisor {
  private state: SupervisorState = 'stopped';
  private boundDir: string | null = null;
  private readonly queue: QueuedTask[] = [];
  private active: QueuedTask | null = null;
  // new_session is typing /new into the Instance.
  private resetting = false;
  private readonly driver: FreebuffDriver;
  private readonly taskTimeoutMs: number;
  private readonly freezeMs: number;
  private readonly errorLogPath: string;
  private readonly pipeName: string;
  private tempCounter = 0;

  constructor(config: SupervisorConfig = {}) {
    this.pipeName = config.pipeName ?? SUPERVISOR_PIPE;
    this.taskTimeoutMs = config.taskTimeoutMs ?? TASK_TIMEOUT_MS;
    this.freezeMs = config.freezeThresholdMs ?? FREEZE_THRESHOLD_MS;
    this.errorLogPath = config.errorLogPath ?? ERROR_LOG_PATH;
    this.driver = new FreebuffDriver({
      ...(config.driver ?? defaultDriverOptions()),
      keepAlive: true,
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
        reply(await this.newConversation());
        break;
      case 'status': {
        const probe = this.driver.probe();
        // Observed on the ready Screen status line; a dead Instance observes nothing.
        const activeModel = this.driver.isAlive() ? classifyScreen(this.driver.screenText()).activeModel : null;
        reply({
          ok: true,
          kind: 'status',
          state: this.observedState(),
          boundDir: this.boundDir,
          queueDepth: this.queue.length,
          activeModel,
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
      case 'doctor': {
        // The live check needs an idle Instance's Screen; otherwise it is skipped, not passed.
        // An Instance whose Markers drifted may read as 'stopped', so check any live idle one.
        const observed = this.observedState();
        reply(
          this.driver.isAlive() && observed !== 'busy' && observed !== 'spawning'
            ? { ok: true, kind: 'doctor', skipped: false, failures: checkMarkers(this.driver.screenText()) }
            : { ok: true, kind: 'doctor', skipped: true, failures: [] },
        );
        break;
      }
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
    let resolved: string;
    try {
      resolved = resolve(dir);
      if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
    } catch {
      reply({ ok: false, kind: 'error', error: `bind failed: ${dir} is not an existing directory` });
      return;
    }
    if (resolved === this.boundDir && this.driver.isAlive()) {
      reply({ ok: true, kind: 'ok' });
      return;
    }
    if (this.boundDir !== null && resolved !== this.boundDir) {
      const minutesLeft = this.driver.probe().hourSessionMinutesLeft;
      if (minutesLeft !== null && minutesLeft > BIND_LOCK_GRACE_MINUTES) {
        const unlocksInMinutes = minutesLeft - BIND_LOCK_GRACE_MINUTES;
        reply({
          ok: false,
          kind: 'error',
          error: `bind rejected: bound_dir_locked: ${this.boundDir} unlocks in ${unlocksInMinutes} minutes; restart the supervisor to switch now`,
        });
        return;
      }
    }
    for (const task of this.queue.splice(0)) {
      task.reply({ ok: false, kind: 'error', error: 'rebind purged this queued task: the directory was rebound' });
    }
    this.driver.kill();
    this.boundDir = resolved;
    this.state = 'spawning';
    try {
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
    if (task === null || task.answered) {
      reply({ ok: false, kind: 'error', error: 'cancel_task failed: no task is active' });
      return;
    }
    task.cancelled = true;
    await this.driver.cancelActive();
    reply({ ok: true, kind: 'ok' });
  }

  // Issue #18: /new goes to the ready Instance, which keeps running. At the picker or
  // with no Instance there is no Conversation to leave: every Task starts with /new.
  private async newConversation(): Promise<SupervisorResponse> {
    if (this.active !== null || this.queue.length > 0 || this.resetting) {
      return { ok: false, kind: 'error', error: 'new_session failed: a task is active or queued' };
    }
    if (this.observedState() !== 'ready') return { ok: true, kind: 'ok' };
    // Tasks arriving meanwhile queue behind /new instead of typing over it.
    this.resetting = true;
    try {
      await this.driver.newConversation();
    } finally {
      this.resetting = false;
      this.pump();
    }
    return { ok: true, kind: 'ok' };
  }

  private observedState(): SupervisorState {
    if (this.active !== null && !this.active.answered) return 'busy';
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
    if (this.active !== null || this.resetting || this.queue.length === 0) return;
    const task = this.queue.shift()!;
    this.active = task;
    this.state = this.driver.isAlive() ? 'busy' : 'spawning';
    void this.runOne(task);
  }

  // Issue #16: one attempt per Task. A freeze, a crash or the deadline fails it and the
  // prompt is never resubmitted: a half-run coding task is not idempotent.
  private async supervised(task: QueuedTask, prompt: string): Promise<string> {
    const work = this.driver.runTask(this.boundDir!, prompt);
    work.catch(() => {});
    const { promise: tripped, reject: trip } = Promise.withResolvers<never>();
    const deadline = setTimeout(
      () => trip(this.watchdogFailure('deadline', `still running at its ${formatDuration(this.taskTimeoutMs)} deadline`)),
      this.taskTimeoutMs,
    );
    const freeze = this.watchFreeze(task, () =>
      trip(this.watchdogFailure('frozen', `no Screen or Chat store change for ${formatDuration(this.freezeMs)}`)),
    );
    const errors = this.watchErrors();
    try {
      return await Promise.race([work, tripped]);
    } catch (error) {
      if (error instanceof FreebuffDriverError && error.reason === 'process_exited' && !task.cancelled) {
        throw this.watchdogFailure('crashed', 'freebuff exited mid-task');
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      clearInterval(freeze);
      errors.stop();
    }
  }

  // Issue #17: Screen lines carrying a known error Marker during a Turn are appended to
  // the error log for later analysis; nothing acts on them. A line counts once it shows
  // more often than when the Turn started (earlier Turns' copies stay on the Screen), and
  // is logged once per Turn.
  private watchErrors(): { stop: () => void } {
    const boundDir = this.boundDir!;
    const tally = (): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const line of errorLines(this.driver.screenText())) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    // A dead Instance's last Screen is not what the respawned one will show.
    const baseline = this.driver.isAlive() ? tally() : new Map<string, number>();
    const logged = new Set<string>();
    const scan = (): void => {
      const lines = [...tally()]
        .filter(([line, count]) => count > (baseline.get(line) ?? 0) && !logged.has(line))
        .map(([line]) => line);
      if (lines.length === 0) return;
      for (const line of lines) logged.add(line);
      try {
        mkdirSync(dirname(this.errorLogPath), { recursive: true });
        appendFileSync(this.errorLogPath, JSON.stringify({ time: new Date().toISOString(), boundDir, lines }) + '\n');
      } catch {
        // The log is best-effort; it never fails a Task.
      }
    };
    const timer = setInterval(scan, ERROR_LOG_POLL_MS);
    // A final scan catches lines printed just before the Turn ended.
    return {
      stop: () => {
        clearInterval(timer);
        scan();
      },
    };
  }

  private watchdogFailure(reason: WatchdogReason, detail: string): WatchdogFailure {
    return new WatchdogFailure(reason, detail, screenExcerpt(this.driver.screenText(), FAILURE_SCREEN_LINES));
  }

  // Frozen: neither the Screen (minus the Countdown and Freebucks lines) nor the Chat
  // store changed for the freeze threshold.
  private watchFreeze(task: QueuedTask, onFrozen: () => void): NodeJS.Timeout {
    const dir = this.boundDir!;
    let lastLog = this.driver.newestLogSize(dir);
    let lastScreen = freezeSignature(this.driver.screenText());
    let lastChange = Date.now();
    const timer = setInterval(() => {
      if (this.active !== task || task.cancelled) {
        clearInterval(timer);
        return;
      }
      const log = this.driver.newestLogSize(dir);
      const screen = freezeSignature(this.driver.screenText());
      if (log !== lastLog || screen !== lastScreen) {
        lastLog = log;
        lastScreen = screen;
        lastChange = Date.now();
        return;
      }
      if (Date.now() - lastChange >= this.freezeMs) {
        clearInterval(timer);
        onFrozen();
      }
    }, Math.min(FREEZE_POLL_MAX_MS, Math.max(FREEZE_POLL_MIN_MS, Math.floor(this.freezeMs / 4))));
    return timer;
  }

  // A fresh Instance in the Bound directory, idle at the picker or ready (an unexpired Hour
  // session resumes). A failed respawn leaves the supervisor stopped; the next Task spawns.
  private async respawn(): Promise<void> {
    this.state = 'spawning';
    await this.driver.stop();
    try {
      this.state = await this.driver.awaitIdle(this.boundDir!);
    } catch {
      this.driver.kill();
      this.state = 'stopped';
    }
  }

  private async runOne(task: QueuedTask): Promise<void> {
    let tempFile: string | null = null;
    try {
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
      if (!task.cancelled && error instanceof WatchdogFailure) {
        // Reply first: the caller is freed while the Instance respawns behind it.
        task.answered = true;
        task.reply({ ok: false, kind: 'error', error: error.message });
        await this.respawn();
      } else if (!task.cancelled && error instanceof FreebuffDriverError && error.reason === 'no_answer') {
        // The Turn ended; the Instance is idle and stays up for the next Task.
        this.state = this.screenState();
        task.reply({ ok: false, kind: 'error', error: error.message });
      } else {
        this.driver.kill();
        this.state = 'stopped';
        task.reply(
          task.cancelled
            ? { ok: false, kind: 'error', error: 'task cancelled' }
            : { ok: false, kind: 'error', error: errorMessage(error) },
        );
      }
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

const formatDuration = (ms: number): string => {
  if (ms % 60_000 !== 0) return `${ms / 1000}s`;
  const minutes = ms / 60_000;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
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
    const errorLogPath = process.env.FREEBUFF_ERROR_LOG || ERROR_LOG_PATH;
    if (await pipeReachable(pipeName, PIPE_PROBE_TIMEOUT_MS)) process.exit(0);
    const supervisor = new Supervisor({ pipeName, driver, taskTimeoutMs, freezeThresholdMs, errorLogPath });
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
