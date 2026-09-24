// PTY driver adapted from Praket7/freebuff-mcp (MIT).
/// <reference lib="es2024" />
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { ACK_TIMEOUT_MS, NEW_SETTLE_MS, PICKER_REENTER_MS, POLL_MS, READY_TIMEOUT_MS, SCREEN_COLS, SCREEN_ROWS, STOP_GRACE_MS, STOP_POLL_MS, STOP_TIMEOUT_MS, TYPE_DELAY_MS } from './config.ts';
import { byNewest, detectTurnEnd, hasLineSince, lineMentionsPrompt, newestChatDir, projectKey } from './protocol/chatStore.ts';
import type { ChatDirSnapshot, TurnBaseline } from './protocol/chatStore.ts';
import { CHATS_DIRNAME, END_SESSION_COMMAND, INSTANCE_RECORD_FILENAME, LOCK_FILENAME, LOGIN_REQUIRED, LOG_FILENAME, METADATA_FILENAME, MSG_KEY, NEW_COMMAND, PROJECTS_DIRNAME, READY_PROMPT, SINGLE_INSTANCE, VERSION_BANNER_REGEX } from './protocol/markers.ts';
import { CliTerminalScreen, classifyScreen } from './protocol/screen.ts';
import { sleep } from './util.ts';

export type DriverFailureReason = 'ready_timeout' | 'dir_mismatch' | 'ack_missing' | 'process_exited' | 'lock_held' | 'needs_login';

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
  onReady?: () => void;
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

  probe(): {
    hourSessionMinutesLeft: number | null;
    freebucksBalance: number | null;
    freebucksDaily: number | null;
    runningVersion: string | null;
    onDiskVersion: string | null;
  } {
    const text = this.screenText();
    const verdict = classifyScreen(text);
    let onDiskVersion: string | null = null;
    try {
      const meta = JSON.parse(readFileSync(join(this.options.configDir, METADATA_FILENAME), 'utf8')) as { version?: unknown };
      if (typeof meta.version === 'string') onDiskVersion = meta.version;
    } catch {
      onDiskVersion = null;
    }
    return {
      hourSessionMinutesLeft: verdict.countdownMinutes,
      freebucksBalance: verdict.freebucksBalance,
      freebucksDaily: verdict.freebucksDaily,
      runningVersion: VERSION_BANNER_REGEX.exec(text)?.[1] ?? null,
      onDiskVersion,
    };
  }

  newestLogSize(dir: string): number {
    return newestChatDir(this.snapshot(this.chatsRoot(dir)))?.logBytes ?? 0;
  }

  kill(): void {
    const instance = this.live;
    this.live = null;
    if (instance) instance.pty.kill();
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

  async park(): Promise<void> {
    const instance = this.live;
    if (!instance || instance.exited) return;
    const stale = instance.screen.text();
    instance.pty.write(END_SESSION_COMMAND);
    await sleep(TYPE_DELAY_MS);
    instance.pty.write('\r');
    const deadline = Date.now() + this.readyMs;
    while (Date.now() < deadline) {
      if (instance.exited) throw new FreebuffDriverError('process_exited');
      const text = instance.screen.text();
      if (text !== stale && !text.includes(READY_PROMPT) && classifyScreen(text).picker !== null) return;
      await sleep(POLL_MS);
    }
    throw new FreebuffDriverError('ready_timeout');
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
    const instance = this.acquire(dir);
    const pty = instance.pty;
    const assertAlive = (): void => {
      if (instance.exited) throw new FreebuffDriverError('process_exited');
    };
    try {
      await this.waitReady(pty, instance.screen, assertAlive, dir);
      this.options.onReady?.();
      const baseline = turnBaseline(this.snapshot(chatsRoot));
      if (this.options.keepAlive) {
        // /new has no log-line echo, so wait for the TUI to swallow it before typing the task.
        await this.typePrompt(pty, NEW_COMMAND);
        await sleep(NEW_SETTLE_MS);
      }
      await this.typePrompt(pty, prompt);
      if (!(await this.awaitAck(chatsRoot, baseline, prompt, assertAlive))) {
        await this.typePrompt(pty, prompt);
        if (!(await this.awaitAck(chatsRoot, baseline, prompt, assertAlive))) throw new FreebuffDriverError('ack_missing');
      }
      return await this.awaitTurnEnd(chatsRoot, baseline, assertAlive);
    } catch (error) {
      if (this.options.keepAlive) this.kill();
      throw error;
    } finally {
      if (!this.options.keepAlive) pty.kill();
    }
  }

  private acquire(dir: string): LiveInstance {
    if (this.options.keepAlive && this.isAlive()) {
      const instance = this.live!;
      if (instance.dir !== dir) throw new FreebuffDriverError('dir_mismatch');
      return instance;
    }
    this.claimLock();
    const pty = this.spawn(dir);
    const screen = new CliTerminalScreen();
    this.lastPainted = '';
    const instance: LiveInstance = { pty, screen, exited: false, dir };
    pty.onData((chunk) => {
      screen.write(chunk);
      const painted = screen.text();
      if (painted.trim() !== '') this.lastPainted = painted;
    });
    pty.onExit(() => {
      instance.exited = true;
    });
    if (this.options.keepAlive) this.live = instance;
    return instance;
  }

  private claimLock(): void {
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
      if (pid !== null && Number.isFinite(pid) && pidAlive(pid)) throw new FreebuffDriverError('lock_held');
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

  private async waitReady(pty: IPty, screen: CliTerminalScreen, assertAlive: () => void, dir: string): Promise<void> {
    const deadline = Date.now() + this.readyMs;
    let lastPickerEnterAt = 0;
    // Picker and single-instance dialog both clear on ENTER; throttle the re-entries.
    const pressEnterWhenBlocked = (blocked: boolean): boolean => {
      if (!blocked || Date.now() - lastPickerEnterAt <= PICKER_REENTER_MS) return false;
      pty.write('\r');
      lastPickerEnterAt = Date.now();
      return true;
    };
    while (Date.now() < deadline) {
      assertAlive();
      const text = screen.text();
      if (text.includes(LOGIN_REQUIRED)) {
        this.loginRequired = true;
        throw new FreebuffDriverError('needs_login');
      }
      if (pressEnterWhenBlocked(text.includes(SINGLE_INSTANCE))) {
        await sleep(POLL_MS);
        continue;
      }
      const verdict = classifyScreen(text, dir);
      if (verdict.ready) {
        if (verdict.banner === null) throw new FreebuffDriverError('dir_mismatch');
        this.loginRequired = false;
        return;
      }
      pressEnterWhenBlocked(verdict.picker !== null);
      await sleep(POLL_MS);
    }
    throw new FreebuffDriverError('ready_timeout', screen.text().replace(/\n{2,}/g, '\n').slice(0, 2000));
  }

  private async typePrompt(pty: IPty, prompt: string): Promise<void> {
    pty.write(prompt);
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
      if (done) return answer ?? '';
      await sleep(POLL_MS);
    }
  }
}
