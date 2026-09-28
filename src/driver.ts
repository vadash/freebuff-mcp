// PTY driver adapted from Praket7/freebuff-mcp (MIT).
/// <reference lib="es2024" />
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { ACK_TIMEOUT_MS, NEW_SETTLE_MS, POLL_MS, READY_TIMEOUT_MS, SCREEN_COLS, SCREEN_ROWS, STOP_GRACE_MS, STOP_POLL_MS, STOP_TIMEOUT_MS, TYPE_DELAY_MS } from './config.ts';
import { byNewest, detectTurnEnd, DEFAULT_CONFIG_DIR, hasLineSince, lineMentionsPrompt, newestChatDir, readChats } from './protocol/chatStore.ts';
import type { ChatDirSnapshot, TurnBaseline } from './protocol/chatStore.ts';
import { corpusVersions } from './protocol/corpus.ts';
import { INSTANCE_RECORD_FILENAME, LOCK_FILENAME, NEW_COMMAND, PASTE_END, PASTE_START } from './protocol/markers.ts';
import { CliTerminalScreen, classifyScreen } from './protocol/screen.ts';
import { hasScreenDump, metadataVersion, writeScreenDump } from './protocol/screenDump.ts';
import { awaitSettled, type SettleIo } from './settle.ts';
import { sleep } from './util.ts';

export type DriverFailureReason = 'ready_timeout' | 'dir_mismatch' | 'ack_missing' | 'process_exited' | 'needs_login' | 'no_answer';

// The Supervisor's seam (C4): everything the Supervisor and the TurnRunner need from
// the Driver, and nothing of the PTY mechanics — facts via observe()/screenDrift()/
// instanceState(), actions via the rest. Tests inject a scripted implementation;
// production builds the FreebuffDriver in main. The error channel stays
// FreebuffDriverError with the reason union above.
export type DriverLike = Pick<
  FreebuffDriver,
  | 'observe'
  | 'screenDrift'
  | 'instanceState'
  | 'newestLogSize'
  | 'kill'
  | 'stop'
  | 'cancelActive'
  | 'newConversation'
  | 'awaitIdle'
  | 'runTask'
>;

export class FreebuffDriverError extends Error {
  readonly reason: DriverFailureReason;
  constructor(reason: DriverFailureReason, detail?: string) {
    super(`freebuff driver failure: ${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'FreebuffDriverError';
    this.reason = reason;
  }
}

/**
 * The facts the Supervisor reads from the Instance without acting: liveness, the
 * Screen text exactly as the Driver and Watchdog read it, the login flag, and the
 * Hour-session numbers observed on the Screen (CONTEXT: Observation).
 */
export interface Observation {
  alive: boolean;
  screenText: string;
  pid: number | null;
  needsLogin: boolean;
  hourSessionMinutesLeft: number | null;
  freebucksDaily: number | null;
}

export interface DriverOptions {
  executable: string;
  configDir: string;
  argsPrefix?: string[];
  timeouts?: { readyMs?: number; ackMs?: number };
  env?: Record<string, string>;
  keepAlive?: boolean;
}

export const resolveFreebuffCommand = (): { executable: string; argsPrefix: string[] } => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    if (existsSync(join(dir, 'freebuff.exe'))) return { executable: join(dir, 'freebuff.exe'), argsPrefix: [] };
    if (existsSync(join(dir, 'freebuff.cmd'))) {
      return { executable: process.execPath, argsPrefix: [join(dir, 'node_modules', 'freebuff', 'index.js')] };
    }
  }
  return { executable: 'freebuff', argsPrefix: [] };
};

export const defaultDriverOptions = (): DriverOptions => ({
  ...resolveFreebuffCommand(),
  configDir: DEFAULT_CONFIG_DIR,
});

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const turnBaseline = (snaps: ChatDirSnapshot[]): TurnBaseline => {
  const newest = newestChatDir(snaps);
  return newest ? { dirName: newest.dirName, logBytes: newest.logBytes } : { dirName: '', logBytes: 0 };
};

// ADR-0004: no model selection. The supervisor never picks a model and never sends
// `/model`; the Instance runs whatever model freebuff remembers.

interface LiveInstance {
  pty: IPty;
  screen: CliTerminalScreen;
  exited: boolean;
  dir: string;
}

export class FreebuffDriver {
  private readonly readyMs: number;
  private readonly ackMs: number;
  private readonly options: DriverOptions;
  private live: LiveInstance | null = null;
  private dying: LiveInstance | null = null;
  private lastPainted = '';
  private loginRequired = false;
  // Acquires in flight that are actually spawning a pty; instanceState reads it.
  private spawning = 0;
  // Keep the Instance alive across Tasks (ADR-0001: killing is cheap but a fresh
  // Hour session is not). `false` tears the pty down after each Task — driver tests
  // only; the Supervisor no longer writes this policy.
  private readonly keepAlive: boolean;

  constructor(options: DriverOptions) {
    this.options = options;
    this.keepAlive = options.keepAlive ?? true;
    this.readyMs = options.timeouts?.readyMs ?? READY_TIMEOUT_MS;
    this.ackMs = options.timeouts?.ackMs ?? ACK_TIMEOUT_MS;
  }

  private isAlive(): boolean {
    return this.live !== null && !this.live.exited;
  }

  screenText(): string {
    const text = this.live?.screen.text() ?? '';
    if (text.trim() !== '') return text;
    return this.lastPainted;
  }

  needsLogin(): boolean {
    return this.loginRequired;
  }

  /** The running Instance's pid, or null once it has exited. The 2026-09 CLI no longer writes its pid to disk. */
  private instancePid(): number | null {
    const instance = this.live;
    return instance !== null && !instance.exited ? instance.pty.pid : null;
  }

  // The one observation snapshot: memory only, no disk reads — the Watchdog polls it
  // per freeze tick. Disk-backed facts (the Drift record) live behind screenDrift().
  observe(): Observation {
    const text = this.screenText();
    const { verdict } = classifyScreen(text);
    return {
      alive: this.isAlive(),
      screenText: text,
      pid: this.instancePid(),
      needsLogin: this.loginRequired,
      hourSessionMinutesLeft: verdict.countdownMinutes,
      freebucksDaily: verdict.freebucksDaily,
    };
  }

  // Issue #31: Drift on record for the installed CLI version — a Screen dump for it
  // (the settle loop files unknown and degraded frames there) — while the fixture
  // corpus does not cover the version yet: promoting a dump into the corpus is what
  // clears the signal. Keyed by the installed version, the same folder name the dump
  // writer uses ('unknown' when the metadata file is unreadable). Disk-backed: status
  // reads it per call so an intermittent screen never flickers it; the Watchdog never
  // does. The configDir fact stays here — callers never learn where the chat store
  // lives.
  screenDrift(): boolean {
    const version = metadataVersion(this.options.configDir) ?? 'unknown';
    return hasScreenDump(this.options.configDir, version) && !corpusVersions().includes(version);
  }

  // The Instance's process facts (CONTEXT: Supervisor states): no Instance, a
  // bring-up in flight, or an Instance live in the workspace. ready/idle are screen
  // facts and stay with the Screen, not here.
  instanceState(): 'stopped' | 'spawning' | 'live' {
    if (this.spawning > 0) return 'spawning';
    if (this.isAlive()) return 'live';
    return 'stopped';
  }

  newestLogSize(dir: string): number {
    return newestChatDir(this.store(dir))?.logBytes ?? 0;
  }

  // The chat store of this Instance's configDir, keyed by the target directory.
  private store(dir: string): ChatDirSnapshot[] {
    return readChats(this.options.configDir, dir);
  }

  kill(): void {
    const instance = this.live;
    this.live = null;
    if (instance) {
      instance.pty.kill();
      this.dying = instance;
    }
  }

  async stop(timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
    const instance = this.live;
    this.kill();
    const deadline = Date.now() + timeoutMs;
    while (instance && !instance.exited && Date.now() < deadline) await sleep(STOP_POLL_MS);
  }

  async cancelActive(): Promise<void> {
    const instance = this.live;
    if (!instance || instance.exited) {
      this.kill();
      return;
    }
    instance.pty.write('\x1b');
    await sleep(TYPE_DELAY_MS);
    instance.pty.write('\x03');
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline) {
      if (instance.exited) break;
      if (classifyScreen(instance.screen.text()).recognition.screen === 'Welcome screen') break;
      await sleep(POLL_MS);
    }
    this.kill();
  }

  // Issue #18: a new Conversation in the live Instance; nothing to do without one.
  async newConversation(): Promise<void> {
    const instance = this.live;
    if (instance === null || instance.exited) return;
    await this.startConversation(instance.pty);
  }

  async awaitIdle(dir: string): Promise<'idle' | 'ready'> {
    // A bring-up: spawn (or reuse) plus the settle wait all count as 'spawning' to
    // instanceState, so a status poll mid-respawn never reads a half-started Instance
    // as merely 'stopped'. The counter nests: acquire() runs its own window inside.
    this.spawning++;
    try {
      const instance = await this.acquire(dir);
      return await this.waitSettled(instance, true);
    } finally {
      this.spawning--;
    }
  }

  async runTask(dir: string, prompt: string): Promise<string> {
    const instance = await this.acquire(dir);
    const pty = instance.pty;
    const assertAlive = (): void => {
      if (instance.exited) throw new FreebuffDriverError('process_exited');
    };
    try {
      await this.waitSettled(instance, false);
      const baseline = turnBaseline(this.store(dir));
      if (this.keepAlive) await this.startConversation(pty);
      await this.pastePrompt(pty, prompt);
      if (!(await this.awaitAck(dir, baseline, prompt, assertAlive))) {
        await this.pastePrompt(pty, prompt);
        if (!(await this.awaitAck(dir, baseline, prompt, assertAlive))) throw new FreebuffDriverError('ack_missing');
      }
      return await this.awaitTurnEnd(dir, baseline, assertAlive);
    } catch (error) {
      // A Watchdog respawn may already have replaced this Instance; never kill its successor.
      // A Turn that ended without an Answer leaves the Instance idle and healthy.
      const turnEnded = error instanceof FreebuffDriverError && error.reason === 'no_answer';
      if (this.keepAlive && this.live === instance && !turnEnded) this.kill();
      throw error;
    } finally {
      if (!this.keepAlive) pty.kill();
    }
  }

  private async acquire(dir: string): Promise<LiveInstance> {
    if (this.keepAlive && this.isAlive()) {
      const instance = this.live!;
      if (instance.dir !== dir) throw new FreebuffDriverError('dir_mismatch');
      return instance;
    }
    // The stale-pid lock check must see the previous Instance dead before a new
    // spawn claims the lock; a killed pty dies asynchronously.
    this.spawning++;
    try {
      const dying = this.dying;
      this.dying = null;
      if (dying !== null && !dying.exited) {
        const deadline = Date.now() + STOP_TIMEOUT_MS;
        while (!dying.exited && Date.now() < deadline) await sleep(STOP_POLL_MS);
      }
      await this.claimLock();
      const pty = this.spawn(dir);
      const screen = new CliTerminalScreen();
      this.lastPainted = '';
      const instance: LiveInstance = { pty, screen, exited: false, dir };
      pty.onData((chunk) => {
        screen.write(chunk);
        // text() reads the buffer before the async parse queue drains, so a sync
        // snapshot here can freeze on a stale mid-paint; re-read after the flush.
        void screen.flush().then(() => {
          const painted = screen.text();
          if (painted.trim() !== '') this.lastPainted = painted;
        });
      });
      pty.onExit(() => {
        instance.exited = true;
      });
      if (this.keepAlive) this.live = instance;
      return instance;
    } finally {
      this.spawning--;
    }
  }

  private async claimLock(): Promise<void> {
    // The real app records the live instance in the instance record; the stub and
    // older builds use the legacy lock. Dead pids never block startup.
    for (const name of [INSTANCE_RECORD_FILENAME, LOCK_FILENAME]) {
      let pid: number | null = null;
      try {
        const raw: unknown = JSON.parse(readFileSync(join(this.options.configDir, name), 'utf8').trim());
        if (name.endsWith('.json') && typeof raw === 'object' && raw !== null && 'pid' in raw && typeof raw.pid === 'number') {
          pid = raw.pid;
        } else if (!name.endsWith('.json')) {
          pid = Number.parseInt(String(raw), 10) || null;
        }
      } catch {
        continue;
      }
      if (pid !== null && Number.isFinite(pid) && pidAlive(pid)) {
        await promisify(execFile)('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {});
        const deadline = Date.now() + STOP_TIMEOUT_MS;
        while (pidAlive(pid) && Date.now() < deadline) await sleep(STOP_POLL_MS);
      }
      rmSync(join(this.options.configDir, name), { force: true });
    }
  }

  private spawn(dir: string): IPty {
    return spawn(this.options.executable, [...(this.options.argsPrefix ?? []), '--cwd', dir], {
      name: 'xterm-256color',
      cols: SCREEN_COLS,
      rows: SCREEN_ROWS,
      cwd: dir,
      env: {
        ...process.env,
        ...this.options.env,
        CODEBUFF_TRUST_AGENT_DIRS: '1',
        FREEBUFF_CONFIG_DIR: this.options.configDir,
      },
    });
  }

  // The PTY-backed adapter at the settle seam: the loop's only effects on the Instance.
  private settleIo(instance: LiveInstance): SettleIo {
    return {
      read: () => instance.screen.text(),
      press: () => instance.pty.write('\r'),
      sleep,
      now: () => Date.now(),
      dump: (text) => writeScreenDump(this.options.configDir, text),
      alive: () => !instance.exited,
    };
  }

  private async waitSettled(instance: LiveInstance, idle: boolean): Promise<'idle' | 'ready'> {
    const outcome = await awaitSettled(this.settleIo(instance), {
      readyMs: this.readyMs,
      idle,
      expectedDir: instance.dir,
    });
    if ('error' in outcome) {
      if (outcome.error === 'needs_login') this.loginRequired = true;
      throw new FreebuffDriverError(outcome.error, outcome.excerpt);
    }
    this.loginRequired = false;
    return outcome.ok;
  }

  // /new has no log-line echo, so wait for the TUI to swallow it before typing on.
  private async startConversation(pty: IPty): Promise<void> {
    await this.typeCommand(pty, NEW_COMMAND);
    await sleep(NEW_SETTLE_MS);
  }

  // Slash commands are typed as keys so the TUI parses them as commands.
  private async typeCommand(pty: IPty, command: string): Promise<void> {
    pty.write(command);
    await sleep(TYPE_DELAY_MS);
    pty.write('\r');
  }

  // Issue #18: one bracketed paste, then one Enter; a newline inside never submits early.
  private async pastePrompt(pty: IPty, prompt: string): Promise<void> {
    pty.write(PASTE_START + prompt + PASTE_END);
    await sleep(TYPE_DELAY_MS);
    pty.write('\r');
  }

  private async awaitAck(dir: string, baseline: TurnBaseline, prompt: string, assertAlive: () => void): Promise<boolean> {
    const deadline = Date.now() + this.ackMs;
    while (Date.now() < deadline) {
      assertAlive();
      if (this.ackReceived(this.store(dir), baseline, prompt)) return true;
      await sleep(POLL_MS);
    }
    return this.ackReceived(this.store(dir), baseline, prompt);
  }

  private ackReceived(snaps: ChatDirSnapshot[], baseline: TurnBaseline, prompt: string): boolean {
    const base = snaps.find((s) => s.dirName === baseline.dirName);
    for (const snap of snaps) {
      if (base !== undefined && snap !== base && byNewest(snap, base) > 0) continue;
      if (hasLineSince(snap, snap === base ? baseline.logBytes : 0, (json) => lineMentionsPrompt(json, prompt))) return true;
    }
    return false;
  }

  private async awaitTurnEnd(dir: string, baseline: TurnBaseline, assertAlive: () => void): Promise<string> {
    for (;;) {
      assertAlive();
      const { done, answer } = detectTurnEnd(this.store(dir), baseline);
      if (done) {
        // ADR-0001 #8: no backup Turn-end signal; a Turn without an Answer fails the Task.
        if (answer === null) throw new FreebuffDriverError('no_answer', 'the Turn ended without a fullResponse');
        return answer;
      }
      await sleep(POLL_MS);
    }
  }
}
