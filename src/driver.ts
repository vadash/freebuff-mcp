// PTY driver adapted from Praket7/freebuff-mcp (MIT).
/// <reference lib="es2024" />
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { ACK_TIMEOUT_MS, NEW_SETTLE_MS, PICKER_REENTER_MS, POLL_MS, READY_TIMEOUT_MS, SCREEN_COLS, SCREEN_ROWS, STOP_GRACE_MS, STOP_POLL_MS, STOP_TIMEOUT_MS, TYPE_DELAY_MS, UNKNOWN_SCREEN_FALLBACK_MS } from './config.ts';
import { byNewest, detectTurnEnd, hasLineSince, lineMentionsPrompt, newestChatDir, projectKey } from './protocol/chatStore.ts';
import type { ChatDirSnapshot, TurnBaseline } from './protocol/chatStore.ts';
import { CHATS_DIRNAME, DOWN_ARROW, INSTANCE_RECORD_FILENAME, LOCK_FILENAME, LOGIN_REQUIRED, LOG_FILENAME, METADATA_FILENAME, MSG_KEY, NEW_COMMAND, PASTE_END, PASTE_START, PROJECTS_DIRNAME, SCREEN_DUMPS_DIRNAME, VERSION_BANNER_REGEX, mentionsSingleInstance } from './protocol/markers.ts';
import { CliTerminalScreen, classifyScreen, freezeSignature, isKnownScreen, type PickerEntry, type ScreenVerdict } from './protocol/screen.ts';
import { sleep } from './util.ts';

export type DriverFailureReason = 'ready_timeout' | 'dir_mismatch' | 'ack_missing' | 'process_exited' | 'needs_login' | 'no_answer';

export class FreebuffDriverError extends Error {
  readonly reason: DriverFailureReason;
  constructor(reason: DriverFailureReason, detail?: string) {
    super(`freebuff driver failure: ${reason}${detail ? `: ${detail}` : ''}`);
    this.name = 'FreebuffDriverError';
    this.reason = reason;
  }
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
  configDir: join(homedir(), '.config', 'manicode'),
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

// ADR-0001 #6: first deepseek the balance can afford, else first glm, else first mimo,
// else the top row. Case-insensitive substring in displayed order; affordability gates
// only the deepseek candidate.
export const pickModelIndex = (entries: PickerEntry[], balance: number | null): number => {
  const first = (needle: string): number => entries.findIndex((entry) => entry.name.toLowerCase().includes(needle));
  const deepseek = first('deepseek');
  if (deepseek !== -1 && balance !== null && balance >= entries[deepseek]!.price) return deepseek;
  const glm = first('glm');
  if (glm !== -1) return glm;
  const mimo = first('mimo');
  if (mimo !== -1) return mimo;
  return 0;
};

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

  constructor(options: DriverOptions) {
    this.options = options;
    this.readyMs = options.timeouts?.readyMs ?? READY_TIMEOUT_MS;
    this.ackMs = options.timeouts?.ackMs ?? ACK_TIMEOUT_MS;
  }

  isAlive(): boolean {
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
  instancePid(): number | null {
    const instance = this.live;
    return instance !== null && !instance.exited ? instance.pty.pid : null;
  }

  probe(): {
    hourSessionMinutesLeft: number | null;
    freebucksBalance: number | null;
    freebucksDaily: number | null;
    runningVersion: string | null;
    onDiskVersion: string | null;
  } {
    const text = this.screenText();
    const verdict = classifyScreen(text);
    return {
      hourSessionMinutesLeft: verdict.countdownMinutes,
      freebucksBalance: verdict.freebucksBalance,
      freebucksDaily: verdict.freebucksDaily,
      runningVersion: VERSION_BANNER_REGEX.exec(text)?.[1] ?? null,
      onDiskVersion: this.metadataVersion(),
    };
  }

  // The installed CLI version from the metadata file, shared by the updatePending
  // probe and the screen-dump folder name; null when unreadable.
  private metadataVersion(): string | null {
    try {
      const meta = JSON.parse(readFileSync(join(this.options.configDir, METADATA_FILENAME), 'utf8')) as { version?: unknown };
      return typeof meta.version === 'string' ? meta.version : null;
    } catch {
      return null;
    }
  }

  // Issue #21: an unknown Screen frame is dumped once per freeze signature under the
  // config directory, in a folder per installed CLI version. Countdown repaints dedupe
  // to one file because the signature strips the Countdown lines; the file keeps them.
  // Write-only diagnostics: nothing reads dumps back, and a failed dump never fails
  // the settle loop.
  private dumpUnknownScreen(text: string): void {
    try {
      const version = this.metadataVersion() ?? 'unknown';
      const hash = createHash('sha256').update(freezeSignature(text)).digest('hex');
      const dir = join(this.options.configDir, SCREEN_DUMPS_DIRNAME, version);
      const path = join(dir, `${hash}.ansi`);
      if (!existsSync(path)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, text);
      }
    } catch {
      // Diagnostics only.
    }
  }

  newestLogSize(dir: string): number {
    return newestChatDir(this.snapshot(this.chatsRoot(dir)))?.logBytes ?? 0;
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
      if (classifyScreen(instance.screen.text()).picker !== null) break;
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

  async awaitIdle(dir: string): Promise<'picker' | 'ready'> {
    const instance = await this.acquire(dir);
    return await this.waitSettled(
      instance,
      () => {
        if (instance.exited) throw new FreebuffDriverError('process_exited');
      },
      true,
    );
  }

  private chatsRoot(dir: string): string {
    return join(
      this.options.configDir,
      PROJECTS_DIRNAME,
      projectKey(dir),
      CHATS_DIRNAME,
    );
  }

  async runTask(dir: string, prompt: string): Promise<string> {
    const chatsRoot = this.chatsRoot(dir);
    const instance = await this.acquire(dir);
    const pty = instance.pty;
    const assertAlive = (): void => {
      if (instance.exited) throw new FreebuffDriverError('process_exited');
    };
    try {
      await this.waitSettled(instance, assertAlive, false);
      const baseline = turnBaseline(this.snapshot(chatsRoot));
      if (this.options.keepAlive) await this.startConversation(pty);
      await this.pastePrompt(pty, prompt);
      if (!(await this.awaitAck(chatsRoot, baseline, prompt, assertAlive))) {
        await this.pastePrompt(pty, prompt);
        if (!(await this.awaitAck(chatsRoot, baseline, prompt, assertAlive))) throw new FreebuffDriverError('ack_missing');
      }
      return await this.awaitTurnEnd(chatsRoot, baseline, assertAlive);
    } catch (error) {
      // A Watchdog respawn may already have replaced this Instance; never kill its successor.
      // A Turn that ended without an Answer leaves the Instance idle and healthy.
      const turnEnded = error instanceof FreebuffDriverError && error.reason === 'no_answer';
      if (this.options.keepAlive && this.live === instance && !turnEnded) this.kill();
      throw error;
    } finally {
      if (!this.options.keepAlive) pty.kill();
    }
  }

  private async acquire(dir: string): Promise<LiveInstance> {
    if (this.options.keepAlive && this.isAlive()) {
      const instance = this.live!;
      if (instance.dir !== dir) throw new FreebuffDriverError('dir_mismatch');
      return instance;
    }
    // The stale-pid lock check must see the previous Instance dead before a new
    // spawn claims the lock; a killed pty dies asynchronously.
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
    if (this.options.keepAlive) this.live = instance;
    return instance;
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

  private async waitSettled(instance: LiveInstance, assertAlive: () => void, idle: boolean): Promise<'picker' | 'ready'> {
    const { pty, screen, dir } = instance;
    const deadline = Date.now() + this.readyMs;
    let lastEnterAt = 0;
    let continuePressed = false;
    // Issue #23: start of the current stretch of continuously unrecognized Screen.
    let unknownSince: number | null = null;
    // One throttle for every unsolicited Enter: the single-instance dialog's
    // re-entries, the picker pick, and the issue #23 unknown-screen fallback.
    const pressEnterThrottled = (): boolean => {
      const now = Date.now();
      if (now - lastEnterAt <= PICKER_REENTER_MS) return false;
      pty.write('\r');
      lastEnterAt = now;
      return true;
    };
    while (Date.now() < deadline) {
      assertAlive();
      const text = screen.text();
      if (text.includes(LOGIN_REQUIRED)) {
        this.loginRequired = true;
        throw new FreebuffDriverError('needs_login');
      }
      if (mentionsSingleInstance(text)) {
        // The single-instance dialog clears on ENTER, and any dialog frame is a
        // recognized screen: seeing it stops any running unknown-screen fallback.
        unknownSince = null;
        pressEnterThrottled();
        await sleep(POLL_MS);
        continue;
      }
      const verdict = classifyScreen(text, dir);
      if (!isKnownScreen(verdict, text)) {
        this.dumpUnknownScreen(text);
        // Issue #23: after ~10 s of continuously unrecognized Screen, press Enter once
        // and let the loop re-evaluate; any recognized screen restarts the wait.
        const now = Date.now();
        if (unknownSince === null) unknownSince = now;
        if (now - unknownSince >= UNKNOWN_SCREEN_FALLBACK_MS && pressEnterThrottled()) unknownSince = now;
      } else if (text.trim() !== '') {
        // A blank frame is a paint transition (ConPTY emits transient blanks between
        // repaints), not a recognized screen: it neither starts nor resets the wait.
        unknownSince = null;
      }
      if (verdict.ready) {
        if (verdict.banner === null) throw new FreebuffDriverError('dir_mismatch');
        this.loginRequired = false;
        return 'ready';
      }
      if (idle) {
        if (verdict.picker !== null || verdict.continueScreen) {
          this.loginRequired = false;
          return 'picker';
        }
      } else if (verdict.continueScreen && !continuePressed) {
        // Issue #12: the Continue screen clears on one ENTER per task arrival; an idle
        // Instance at the Continue screen must not be touched.
        continuePressed = true;
        pty.write('\r');
        await sleep(POLL_MS);
      } else if (verdict.picker !== null) {
        // ADR-0001 #6: pick the model by rule instead of taking the top row.
        if (Date.now() - lastEnterAt > PICKER_REENTER_MS) {
          await this.pickModel(pty, verdict);
          lastEnterAt = Date.now();
        }
      }
      await sleep(POLL_MS);
    }
    throw new FreebuffDriverError('ready_timeout', screen.text().replace(/\n{2,}/g, '\n').slice(0, 2000));
  }

  private async pickModel(pty: IPty, verdict: ScreenVerdict): Promise<void> {
    const index = pickModelIndex(verdict.entries, verdict.freebucksBalance);
    for (let row = 0; row < index; row++) {
      pty.write(DOWN_ARROW);
      await sleep(TYPE_DELAY_MS);
    }
    pty.write('\r');
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

  private snapshot(chatsRoot: string): ChatDirSnapshot[] {
    let names: string[];
    try {
      names = readdirSync(chatsRoot);
    } catch {
      return [];
    }
    const snaps: ChatDirSnapshot[] = [];
    for (const dirName of names) {
      const logPath = join(chatsRoot, dirName, LOG_FILENAME);
      try {
        const log = statSync(logPath);
        snaps.push({ dirName, mtimeMs: log.mtimeMs, logBytes: log.size, logText: readFileSync(logPath, 'utf8') });
      } catch {
        try {
          const dir = statSync(join(chatsRoot, dirName));
          snaps.push({ dirName, mtimeMs: dir.mtimeMs, logBytes: 0, logText: '' });
        } catch {
          // Dir vanished between readdir and stat.
        }
      }
    }
    return snaps;
  }

  private async awaitAck(chatsRoot: string, baseline: TurnBaseline, prompt: string, assertAlive: () => void): Promise<boolean> {
    const deadline = Date.now() + this.ackMs;
    while (Date.now() < deadline) {
      assertAlive();
      if (this.ackReceived(this.snapshot(chatsRoot), baseline, prompt)) return true;
      await sleep(POLL_MS);
    }
    return this.ackReceived(this.snapshot(chatsRoot), baseline, prompt);
  }

  private ackReceived(snaps: ChatDirSnapshot[], baseline: TurnBaseline, prompt: string): boolean {
    const base = snaps.find((s) => s.dirName === baseline.dirName);
    for (const snap of snaps) {
      if (base !== undefined && snap !== base && byNewest(snap, base) > 0) continue;
      if (hasLineSince(snap, snap === base ? baseline.logBytes : 0, (json) => lineMentionsPrompt(json, prompt))) return true;
    }
    return false;
  }

  private async awaitTurnEnd(chatsRoot: string, baseline: TurnBaseline, assertAlive: () => void): Promise<string> {
    for (;;) {
      assertAlive();
      const { done, answer } = detectTurnEnd(this.snapshot(chatsRoot), baseline);
      if (done) {
        // ADR-0001 #8: no backup Turn-end signal; a Turn without an Answer fails the Task.
        if (answer === null) throw new FreebuffDriverError('no_answer', 'the Turn ended without a fullResponse');
        return answer;
      }
      await sleep(POLL_MS);
    }
  }
}
