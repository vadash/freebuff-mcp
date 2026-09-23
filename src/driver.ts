/// <reference lib="es2024" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { ACK_TIMEOUT_MS, READY_TIMEOUT_MS, SCREEN_COLS, SCREEN_ROWS } from './config.ts';
import { byNewest, detectTurnEnd, hasLineSince, newestChatDir, projectKey } from './protocol/chatStore.ts';
import type { ChatDirSnapshot, TurnBaseline } from './protocol/chatStore.ts';
import { CHATS_DIRNAME, LOG_FILENAME, MANICODE_DIRNAME, MSG_KEY, PROJECTS_DIRNAME } from './protocol/markers.ts';
import { CliTerminalScreen, classifyScreen } from './protocol/screen.ts';

export type DriverFailureReason = 'ready-timeout' | 'dir-mismatch' | 'ack-missing' | 'process-exited';

export class FreebuffDriverError extends Error {
  readonly reason: DriverFailureReason;
  constructor(reason: DriverFailureReason) {
    super(`freebuff driver failure: ${reason}`);
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

  constructor(options: DriverOptions) {
    this.options = options;
    this.readyMs = options.timeouts?.readyMs ?? READY_TIMEOUT_MS;
    this.ackMs = options.timeouts?.ackMs ?? ACK_TIMEOUT_MS;
  }

  isAlive(): boolean {
    return this.live !== null && !this.live.exited;
  }

  kill(): void {
    const session = this.live;
    this.live = null;
    if (session) session.pty.kill();
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
      if (text !== stale && classifyScreen(text).picker !== null) return;
      await sleep(POLL_MS);
    }
    throw new FreebuffDriverError('ready-timeout');
  }

  async runTask(cwd: string, prompt: string): Promise<string> {
    const chatsRoot = join(
      this.options.configDir,
      MANICODE_DIRNAME,
      PROJECTS_DIRNAME,
      projectKey(cwd, resolve(cwd)),
      CHATS_DIRNAME,
    );
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
    const pty = this.spawn(cwd);
    const screen = new CliTerminalScreen();
    const session: LiveSession = { pty, screen, exited: false, cwd };
    pty.onData((chunk) => screen.write(chunk));
    pty.onExit(() => {
      session.exited = true;
    });
    if (this.options.keepAlive) this.live = session;
    return session;
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
    let dismissed = false;
    while (Date.now() < deadline) {
      assertAlive();
      const verdict = classifyScreen(screen.text(), cwd);
      if (verdict.picker === 'expanded' && !dismissed) {
        pty.write('\r');
        dismissed = true;
      } else if (verdict.ready) {
        if (verdict.banner === null) throw new FreebuffDriverError('dir-mismatch');
        return;
      }
      await sleep(POLL_MS);
    }
    throw new FreebuffDriverError('ready-timeout');
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
      if (hasLineSince(snap, snap === base ? baseline.logBytes : 0, (json) => json[MSG_KEY] === prompt)) return true;
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
