// PTY driver adapted from Praket7/freebuff-mcp (MIT).
/// <reference lib="es2024" />
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { ACK_TIMEOUT_MS, PICKER_REENTER_MS, READY_TIMEOUT_MS, SCREEN_COLS, SCREEN_ROWS, STOP_GRACE_MS } from './config.ts';
import { byNewest, detectTurnEnd, hasLineSince, lineMentionsPrompt, newestChatDir, projectKey } from './protocol/chatStore.ts';
import type { ChatDirSnapshot, TurnBaseline } from './protocol/chatStore.ts';
import { CHATS_DIRNAME, LOGIN_REQUIRED, LOG_FILENAME, MSG_KEY, PROJECTS_DIRNAME, READY_PROMPT, SINGLE_INSTANCE } from './protocol/markers.ts';
import { CliTerminalScreen, classifyScreen } from './protocol/screen.ts';

export type DriverFailureReason = 'ready-timeout' | 'dir-mismatch' | 'ack-missing' | 'process-exited' | 'lock_held' | 'needs_login';

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

const POLL_MS = 250;
const TYPE_DELAY_MS = 150;
// /new has no log-line echo, so wait for the TUI to swallow it before typing the task.
const NEW_SETTLE_MS = 300;

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

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

interface LiveSession {
  pty: IPty;
  screen: CliTerminalScreen;
  exited: boolean;
  cwd: string;
}

export class FreebuffDriver {
  private readonly readyMs: number;
  private readonly ackMs: number;
  private readonly options: DriverOptions;
  private live: LiveSession | null = null;
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
    trialMinutesLeft: number | null;
    freebucksDaily: string | null;
    runningVersion: string | null;
    onDiskVersion: string | null;
  } {
    const text = this.screenText();
    const trial = /(\d+)\s*min\s+left/i.exec(text);
    const daily = /Daily\s+Freebucks:\s*(\S+)/i.exec(text);
    const running = /freebuff\s+v(\S+)/i.exec(text);
    let onDiskVersion: string | null = null;
    try {
      const meta = JSON.parse(readFileSync(join(this.options.configDir, 'freebuff-metadata.json'), 'utf8')) as { version?: unknown };
      if (typeof meta.version === 'string') onDiskVersion = meta.version;
    } catch {
      onDiskVersion = null;
    }
    return {
      trialMinutesLeft: trial === null ? null : Number(trial[1]),
      freebucksDaily: daily === null ? null : daily[1],
      runningVersion: running === null ? null : running[1],
      onDiskVersion,
    };
  }

  newestLogSize(cwd: string): number {
    const snaps = this.snapshot(this.chatsRoot(cwd));
    return snaps.reduce<ChatDirSnapshot | null>(
      (newest, snap) => (newest === null || byNewest(snap, newest) > 0 ? snap : newest),
      null,
    )?.logBytes ?? 0;
  }

  kill(): void {
    const session = this.live;
    this.live = null;
    if (session) session.pty.kill();
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    const session = this.live;
    this.kill();
    const deadline = Date.now() + timeoutMs;
    while (session && !session.exited && Date.now() < deadline) await sleep(50);
  }

  async cancelActive(): Promise<void> {
    const session = this.live;
    if (!session || session.exited) {
      this.kill();
      return;
    }
    session.pty.write('\x1b');
    await sleep(TYPE_DELAY_MS);
    session.pty.write('\x03');
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline) {
      if (session.exited) break;
      if (classifyScreen(session.screen.text()).picker !== null) break;
      await sleep(POLL_MS);
    }
    this.kill();
  }

  async park(): Promise<void> {
    const session = this.live;
    if (!session || session.exited) return;
    const stale = session.screen.text();
    session.pty.write('/end-session');
    await sleep(TYPE_DELAY_MS);
    session.pty.write('\r');
    const deadline = Date.now() + this.readyMs;
    while (Date.now() < deadline) {
      if (session.exited) throw new FreebuffDriverError('process-exited');
      const text = session.screen.text();
      if (text !== stale && !text.includes(READY_PROMPT) && classifyScreen(text).picker !== null) return;
      await sleep(POLL_MS);
    }
    throw new FreebuffDriverError('ready-timeout');
  }

  private chatsRoot(cwd: string): string {
    return join(
      this.options.configDir,
      PROJECTS_DIRNAME,
      projectKey(cwd, resolve(cwd)),
      CHATS_DIRNAME,
    );
  }

  async runTask(cwd: string, prompt: string): Promise<string> {
    const chatsRoot = this.chatsRoot(cwd);
    const session = this.acquire(cwd);
    const pty = session.pty;
    const assertAlive = (): void => {
      if (session.exited) throw new FreebuffDriverError('process-exited');
    };
    try {
      await this.waitReady(pty, session.screen, assertAlive, cwd);
      this.options.onReady?.();
      const baseline = turnBaseline(this.snapshot(chatsRoot));
      if (this.options.keepAlive) {
        await this.typePrompt(pty, '/new');
        await sleep(NEW_SETTLE_MS);
      }
      await this.typePrompt(pty, prompt);
      if (!(await this.awaitAck(chatsRoot, baseline, prompt, assertAlive))) {
        await this.typePrompt(pty, prompt);
        if (!(await this.awaitAck(chatsRoot, baseline, prompt, assertAlive))) throw new FreebuffDriverError('ack-missing');
      }
      return await this.awaitTurnEnd(chatsRoot, baseline, assertAlive);
    } catch (error) {
      if (this.options.keepAlive) this.kill();
      throw error;
    } finally {
      if (!this.options.keepAlive) pty.kill();
    }
  }

  private acquire(cwd: string): LiveSession {
    if (this.options.keepAlive && this.isAlive()) {
      const session = this.live!;
      if (session.cwd !== cwd) throw new FreebuffDriverError('dir-mismatch');
      return session;
    }
    this.claimLock();
    const pty = this.spawn(cwd);
    const screen = new CliTerminalScreen();
    this.lastPainted = '';
    const session: LiveSession = { pty, screen, exited: false, cwd };
    pty.onData((chunk) => {
      screen.write(chunk);
      const painted = screen.text();
      if (painted.trim() !== '') this.lastPainted = painted;
    });
    pty.onExit(() => {
      session.exited = true;
    });
    if (this.options.keepAlive) this.live = session;
    return session;
  }

  private claimLock(): void {
    // The real app records the live instance in freebuff-instance-owner.json; the stub and
    // older builds use freebuff.lock. Dead pids never block startup.
    for (const name of ['freebuff-instance-owner.json', 'freebuff.lock']) {
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

  private spawn(cwd: string): IPty {
    return spawn(this.options.executable, [...(this.options.argsPrefix ?? []), '--cwd', cwd], {
      name: 'xterm-256color',
      cols: SCREEN_COLS,
      rows: SCREEN_ROWS,
      cwd,
      env: {
        ...process.env,
        ...this.options.env,
        CODEBUFF_TRUST_AGENT_DIRS: '1',
        FREEBUFF_CONFIG_DIR: this.options.configDir,
      },
    });
  }

  private async waitReady(pty: IPty, screen: CliTerminalScreen, assertAlive: () => void, cwd: string): Promise<void> {
    const deadline = Date.now() + this.readyMs;
    let lastPickerEnterAt = 0;
    while (Date.now() < deadline) {
      assertAlive();
      const text = screen.text();
      if (text.includes(LOGIN_REQUIRED)) {
        this.loginRequired = true;
        throw new FreebuffDriverError('needs_login');
      }
      if (text.includes(SINGLE_INSTANCE) && Date.now() - lastPickerEnterAt > PICKER_REENTER_MS) {
        pty.write('\r');
        lastPickerEnterAt = Date.now();
        await sleep(POLL_MS);
        continue;
      }
      const verdict = classifyScreen(text, cwd);
      if (verdict.ready) {
        if (verdict.banner === null) throw new FreebuffDriverError('dir-mismatch');
        this.loginRequired = false;
        return;
      }
      if (verdict.picker !== null && Date.now() - lastPickerEnterAt > PICKER_REENTER_MS) {
        pty.write('\r');
        lastPickerEnterAt = Date.now();
      }
      await sleep(POLL_MS);
    }
    throw new FreebuffDriverError('ready-timeout', screen.text().replace(/\n{2,}/g, '\n').slice(0, 2000));
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
