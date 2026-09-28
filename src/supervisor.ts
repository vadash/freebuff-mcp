import { statSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { ERROR_LOG_PATH, FREEZE_THRESHOLD_MS, PIPE_CONNECT_TIMEOUT_MS, PIPE_PROBE_TIMEOUT_MS, QUEUE_DEPTH, SHUTDOWN_EXIT_MS, STARTUP_PIPE_WAIT_MS, SUPERVISOR_PIPE, TASK_TIMEOUT_MS } from './config.ts';
import { FreebuffDriver, defaultDriverOptions } from './driver.ts';
import type { DriverLike, DriverOptions } from './driver.ts';
import { classifyScreen, type ScreenAssessment } from './protocol/screen.ts';
import { recognizeScreen, type Recognition } from './protocol/signatures.ts';
import { corpusVersions } from './protocol/corpus.ts';
import { hasScreenDump, metadataVersion } from './protocol/screenDump.ts';
import { pipeReachable, waitForPipe } from './ipc.ts';
import { errorMessage } from './util.ts';
import { isMainModule, mainOptions } from './entry.ts';
import { acquireSupervisorLock, supervisorFingerprint } from './supervisorLock.ts';
import { assertSafeTarget, ensureJunction, workspaceDirFor } from './workspace.ts';
import { TurnRunner, type TurnRunnerLike } from './turnRunner.ts';

export type SupervisorState = 'stopped' | 'spawning' | 'idle' | 'ready' | 'busy';

export interface SupervisorConfig {
  pipeName?: string;
  // The real Driver's options: they build the default Driver when `driver` is unset;
  // `configDir` is read even with a `driver` injected (it locates the Screen-dump
  // record `status` reports).
  driverOptions?: DriverOptions;
  // C4 seam: an injected Driver for in-process policy tests; production leaves it unset.
  driver?: DriverLike;
  // The Turn seam: an injected runner resolves canned verdicts with no timers in
  // policy tests; production leaves it unset and gets the real TurnRunner.
  turnRunner?: TurnRunnerLike;
  taskTimeoutMs?: number;
  errorLogPath?: string;
}

export type SupervisorRequest =
  | { op: 'run_prompt'; dir: string; prompt: string }
  | { op: 'cancel_task' }
  | { op: 'new_session' }
  | { op: 'status' }
  | { op: 'screen' }
  | { op: 'doctor' }
  | { op: 'shutdown' };

// The status field list is defined once, here. Field names are the public wire
// contract.
export interface StatusPayload {
  state: SupervisorState;
  // The fixed per-pipe directory the Instance always runs in; `repo` inside it is a
  // junction to `targetDir`.
  workspaceDir: string;
  // The caller's real repo the junction points at; null until the first task.
  targetDir: string | null;
  queueDepth: number;
  activeModel: string | null;
  instancePid: number | null;
  hourSessionMinutesLeft: number | null;
  freebucksDaily: number | null;
  needsLogin: boolean;
  // Issue #31: Drift is visible on status, not just to whoever calls doctor.
  screenDrift: boolean;
  // The daemon's code fingerprint (ADR-0005): the MCP server compares it with its own
  // and spawns a replacement daemon when they differ.
  fingerprint: string;
}

export type SupervisorResponse =
  | { ok: true; kind: 'ok' }
  | { ok: true; kind: 'answer'; answer: string }
  | ({ ok: true; kind: 'status' } & StatusPayload)
  | { ok: true; kind: 'screen'; screen: string }
  // Issue #29: doctor's verdict is the recognition function's output for the showing
  // Screen — pass (every Marker), degraded (Drift: threshold met, some Marker missing)
  // or fail; `screen` is null when nothing is recognized and the fields are null when
  // the check is skipped (Instance starting, busy or dead).
  | ({ ok: true; kind: 'doctor'; skipped: false } & Recognition)
  | { ok: true; kind: 'doctor'; skipped: true; screen: null; level: null; missing: [] }
  | { ok: false; kind: 'error'; error: string }
  | { ok: false; kind: 'busy'; position: number; error: string };

interface QueuedTask {
  prompt: string;
  // Answered while the Watchdog respawns the Instance behind it; no longer cancellable.
  answered?: boolean;
  reply: (response: SupervisorResponse) => void;
}

export class Supervisor {
  private spawning = false;
  // The fixed per-pipe directory every Instance spawns in; the caller's repo is the
  // `repo` junction inside it, swapped at idle time when run_prompt changes target.
  private readonly workspace: string;
  private targetDir: string | null = null;
  private readonly queue: QueuedTask[] = [];
  private active: QueuedTask | null = null;
  private startingConversation = false;
  private readonly driver: DriverLike;
  // The options the Driver runs with; `configDir` locates the Screen-dump record.
  private readonly driverOptions: DriverOptions;
  // Runs the Task's Turn: submit, Watchdog, verdict. The Supervisor keeps the Queue,
  // the replies and the respawn policy.
  private readonly runner: TurnRunnerLike;
  private readonly pipeName: string;

  constructor(config: SupervisorConfig = {}) {
    this.pipeName = config.pipeName ?? SUPERVISOR_PIPE;
    this.workspace = workspaceDirFor(this.pipeName);
    this.driverOptions = {
      ...(config.driverOptions ?? defaultDriverOptions()),
      keepAlive: true,
    };
    this.driver = config.driver ?? new FreebuffDriver(this.driverOptions);
    this.runner = config.turnRunner ?? new TurnRunner({
      driver: this.driver,
      workspace: this.workspace,
      taskTimeoutMs: config.taskTimeoutMs ?? TASK_TIMEOUT_MS,
      freezeMs: FREEZE_THRESHOLD_MS,
      errorLogPath: config.errorLogPath ?? ERROR_LOG_PATH,
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
      case 'run_prompt':
        await this.runPrompt(request.dir, request.prompt, reply);
        break;
      case 'cancel_task':
        await this.cancelTask(reply);
        break;
      case 'new_session':
        reply(await this.newConversation());
        break;
      case 'screen':
        // Issue #21: the Instance's Screen exactly as the Driver and Watchdog read
        // it, in every supervisor state; '' while stopped with nothing painted yet.
        reply({ ok: true, kind: 'screen', screen: this.driver.screenText() });
        break;
      case 'status': {
        const probe = this.driver.probe();
        // Observed on the ready Screen status line; a dead Instance observes nothing.
        const assessed = this.driver.isAlive() ? this.assessed() : null;
        const activeModel = assessed?.verdict.activeModel ?? null;
        // Issue #31: Drift on record for the installed CLI version — a Screen dump for
        // it (the settle loop files unknown and degraded frames there) — while the
        // fixture corpus does not cover the version yet: promoting a dump into the
        // corpus is what clears the signal. Keyed by the installed version, the same
        // folder name the dump writer uses ('unknown' when the metadata file is
        // unreadable), so an update shipping a different version starts clean. Read
        // from disk on every status, so an intermittent screen never flickers it.
        const driftVersion = metadataVersion(this.driverOptions.configDir) ?? 'unknown';
        reply({
          ok: true,
          kind: 'status',
          state: this.observedState(assessed ?? undefined),
          workspaceDir: this.workspace,
          targetDir: this.targetDir,
          queueDepth: this.queue.length,
          activeModel,
          instancePid: this.driver.instancePid(),
          hourSessionMinutesLeft: probe.hourSessionMinutesLeft,
          freebucksDaily: probe.freebucksDaily,
          needsLogin: this.driver.needsLogin(),
          screenDrift: hasScreenDump(this.driverOptions.configDir, driftVersion) && !corpusVersions().includes(driftVersion),
          fingerprint: supervisorFingerprint(),
        });
        break;
      }
      case 'doctor': {
        // The live check needs an idle Instance's Screen; otherwise it is skipped, not passed.
        // An Instance whose Markers drifted may read as 'stopped', so check any live idle one.
        const observed = this.observedState();
        const recognized = this.driver.isAlive() && observed !== 'busy' && observed !== 'spawning'
          ? recognizeScreen(this.driver.screenText())
          : null;
        reply(
          recognized === null
            ? { ok: true, kind: 'doctor', skipped: true, screen: null, level: null, missing: [] }
            : { ok: true, kind: 'doctor', skipped: false, ...recognized },
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

  private async cancelTask(reply: (response: SupervisorResponse) => void): Promise<void> {
    const task = this.active;
    if (task === null || task.answered) {
      reply({ ok: false, kind: 'error', error: 'cancel_task failed: no task is active' });
      return;
    }
    await this.runner.stop();
    reply({ ok: true, kind: 'ok' });
  }

  // Issue #18: /new goes to the ready Instance, which keeps running. On the Welcome
  // screen or with no Instance there is no Conversation to leave: every Task starts with /new.
  private async newConversation(): Promise<SupervisorResponse> {
    if (this.active !== null || this.queue.length > 0 || this.startingConversation) {
      return { ok: false, kind: 'error', error: 'new_session failed: a task is active or queued' };
    }
    if (this.observedState() !== 'ready') return { ok: true, kind: 'ok' };
    // Tasks arriving meanwhile queue behind /new instead of typing over it.
    this.startingConversation = true;
    try {
      await this.driver.newConversation();
    } finally {
      this.startingConversation = false;
      this.pump();
    }
    return { ok: true, kind: 'ok' };
  }

  private assessed(): ScreenAssessment {
    return classifyScreen(this.driver.screenText());
  }

  private observedState(assessed = this.assessed()): SupervisorState {
    if (this.active !== null && !this.active.answered) return 'busy';
    if (this.spawning) return 'spawning';
    return this.screenState(assessed);
  }

  private screenState(assessed = this.assessed()): SupervisorState {
    if (!this.driver.isAlive()) return 'stopped';
    const { screen } = assessed.recognition;
    if (screen === 'ready') return 'ready';
    if (screen === 'Welcome screen' || screen === 'Continue') return 'idle';
    return 'stopped';
  }

  private async runPrompt(dir: string, prompt: string, reply: (response: SupervisorResponse) => void): Promise<void> {
    let resolved: string;
    try {
      resolved = resolve(dir);
      if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
    } catch {
      reply({ ok: false, kind: 'error', error: `run_prompt failed: ${dir} is not an existing directory` });
      return;
    }
    try {
      assertSafeTarget(resolved, this.workspace);
    } catch {
      reply({ ok: false, kind: 'error', error: `run_prompt failed: ${dir} is not a safe junction target` });
      return;
    }
    try {
      // Issue #5: a retarget is blocked only by an active task; queued tasks are purged.
      const retarget = resolved !== this.targetDir;
      if (retarget && this.active !== null) {
        reply({
          ok: false,
          kind: 'error',
          error: `run_prompt failed: ${dir} does not match the active directory ${this.targetDir} while a task is active`,
        });
        return;
      }
      // Swap the junction before recording the new target, so a failed swap (e.g. a
      // real directory named repo) leaves the previous binding reported by status.
      ensureJunction(this.workspace, resolved);
      if (retarget) {
        for (const task of this.queue.splice(0)) {
          task.reply({ ok: false, kind: 'error', error: 'retarget purged this queued task: the directory changed' });
        }
        this.targetDir = resolved;
      }
    } catch (error) {
      // Covers the real-directory-named-repo case: the swap path refuses instead of
      // removing anything it did not create as a link.
      reply({ ok: false, kind: 'error', error: `run_prompt failed: ${(error as Error).message}` });
      return;
    }
    if (this.active !== null && this.queue.length >= QUEUE_DEPTH) {
      reply({
        ok: false,
        kind: 'busy',
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
    if (this.active !== null || this.startingConversation || this.queue.length === 0) return;
    const task = this.queue.shift()!;
    this.active = task;
    this.spawning = !this.driver.isAlive();
    void this.runOne(task);
  }

  // A fresh Instance in the workspace, idle on the Welcome screen or ready (an
  // unexpired Hour session resumes). A failed respawn leaves the supervisor stopped;
  // the next Task spawns.
  private async respawn(): Promise<void> {
    this.spawning = true;
    await this.driver.stop();
    try {
      await this.driver.awaitIdle(this.workspace);
      this.spawning = false;
    } catch {
      this.driver.kill();
      this.spawning = false;
    }
  }

  // One attempt per Task (issue #16): the runner's verdict maps onto the reply and the
  // Instance policy. Watchdog failures reply first — the caller is freed while the
  // Instance respawns behind it. A Turn that throws without a verdict (e.g. the temp
  // file cannot be written) replies and kills, like any other Driver error: runOne is
  // total — every Task gets exactly one reply, or the wire request would hang.
  private async runOne(task: QueuedTask): Promise<void> {
    try {
      const outcome = await this.runner.run(task.prompt);
      if (outcome.ok) {
        this.spawning = false;
        task.reply({ ok: true, kind: 'answer', answer: outcome.answer });
      } else if (outcome.reason === 'deadline' || outcome.reason === 'frozen' || outcome.reason === 'crashed') {
        task.answered = true;
        task.reply({ ok: false, kind: 'error', error: outcome.message });
        await this.respawn();
      } else if (outcome.reason === 'no_answer') {
        // The Turn ended; the Instance is idle and stays up for the next Task.
        this.spawning = false;
        task.reply({ ok: false, kind: 'error', error: outcome.message });
      } else {
        // A cancelled Task or a Driver error: kill; the next Task spawns on demand.
        this.driver.kill();
        this.spawning = false;
        task.reply({
          ok: false,
          kind: 'error',
          error: outcome.reason === 'cancelled' ? 'task cancelled' : outcome.message,
        });
      }
    } catch (error) {
      this.driver.kill();
      this.spawning = false;
      task.reply({ ok: false, kind: 'error', error: errorMessage(error) });
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

if (isMainModule(import.meta.url)) {
  const main = async (): Promise<void> => {
    const { pipeName, driverOptions, taskTimeoutMs } = mainOptions();
    const errorLogPath = process.env.FREEBUFF_ERROR_LOG || ERROR_LOG_PATH;
    // Windows lets several servers share one named pipe, so reachability alone
    // cannot detect a duplicate; the pid lock makes a second supervisor exit. A start
    // with different code (a new build after an update) replaces the holder instead.
    const lock = await acquireSupervisorLock(pipeName);
    if (lock === null) process.exit(0);
    process.on('exit', () => lock.release());
    // Checked only after the lock: a duplicate exits because the lock said so, and a
    // takeover start must not — the stale daemon's socket is still draining, so the
    // reachability probe would misread this start as the duplicate.
    if (!lock.replaced && (await pipeReachable(pipeName, PIPE_PROBE_TIMEOUT_MS))) process.exit(0);
    const supervisor = new Supervisor({ pipeName, driverOptions, taskTimeoutMs, errorLogPath });
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
