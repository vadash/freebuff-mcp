// Screen capture for the gated real smoke (issue #9): spawns the real freebuff CLI on a
// ConPTY, mirrors it through the same VT emulator the driver uses, and writes each named
// screen as a fixture. A fixture is the flattened visible screen (trailing row padding
// trimmed) behind the same clear+home prefix the driver's full repaints use, so
// flattenScreen([fixture]) reproduces the screen and the stub can replay it verbatim.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type IPty } from 'node-pty';
import { SCREEN_COLS, SCREEN_ROWS } from '../../src/config.ts';
import { sleep } from '../../src/util.ts';
import { CHATS_DIRNAME, CONNECTING, LOG_FILENAME, LOGIN_REQUIRED, PROJECTS_DIRNAME, READY_PROMPT, TURN_END_MSG, mentionsSingleInstance } from '../../src/protocol/markers.ts';
import { projectKey, type ChatDirSnapshot } from '../../src/protocol/chatStore.ts';
import { classifyScreen, CliTerminalScreen } from '../../src/protocol/screen.ts';
import { defaultDriverOptions } from '../../src/driver.ts';

// Real TUIs repaint in bursts (spinner, status line); require the wanted screen to hold
// still briefly so fixtures capture the settled frame.
const POLL_MS = 250;
const SETTLE_MS = 1_500;
// Unknown-screen watchdog: a frame only counts once it has been stable for a while, so
// spinner bursts and repaint transitions are not dumped.
const UNKNOWN_POLL_MS = 2_000;
const UNKNOWN_STABLE_MS = 2_500;

export const CLEAR_HOME = '\x1b[2J\x1b[H';

/** Collapses blank runs and trailing padding so a screen can be quoted in errors and notes. */
export const flatDump = (text: string): string => text.replace(/\n{2,}/g, '\n').replace(/[ \t]+$/gm, '').trim();

// Screens the capture flows already understand. Anything else that holds still on the
// emulator gets dumped for later analysis instead of being silently lost.
const knownScreen = (text: string): boolean =>
  classifyScreen(text).picker !== null ||
  text.includes(READY_PROMPT) ||
  text.includes(CONNECTING) ||
  text.includes(LOGIN_REQUIRED) ||
  mentionsSingleInstance(text) ||
  text.includes('Press Enter to continue') ||
  text.includes('Session ended') ||
  text.includes(TURN_END_MSG) ||
  text.includes('Refer friends') ||
  /\d+(?:m|h) left|\d+:\d\d left/.test(text) ||
  text.trim() === '';

export class RealCli {
  private readonly pty: IPty;
  private readonly screen = new CliTerminalScreen();
  private exited = false;
  private watchdog?: NodeJS.Timeout;
  /** Full raw PTY byte stream so far, kept for human review next to the fixtures. */
  raw = '';

  constructor(cwd: string) {
    const { executable, argsPrefix = [] } = defaultDriverOptions();
    // Deliberately no FREEBUFF_CONFIG_DIR override: captures must come from the real
    // logged-in profile, not a redirected config dir.
    this.pty = spawn(executable, [...argsPrefix, '--cwd', cwd], {
      name: 'xterm-256color',
      cols: SCREEN_COLS,
      rows: SCREEN_ROWS,
      cwd,
      env: { ...process.env, CODEBUFF_TRUST_AGENT_DIRS: '1' } as NodeJS.ProcessEnv,
    });
    this.pty.onData((chunk) => {
      this.raw += chunk;
      this.screen.write(chunk);
    });
    this.pty.onExit(() => {
      this.exited = true;
    });
  }

  text(): string {
    return this.screen.text();
  }

  /** Waits for the emulator to process every bytes written so far. */
  async flush(): Promise<void> {
    await this.screen.flush();
  }

  type(text: string): void {
    this.pty.write(text);
  }

  /**
   * Watches the emulator for stable frames that match no known screen and dumps each
   * distinct one into `dir` (`unknown-<hash>.ansi` flattened, `.raw.ansi` raw bytes) so
   * surprises can be analyzed after a run instead of being lost. Real-PTY latency only;
   * the timer drives an external process.
   */
  startUnknownWatch(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const seen = new Set<string>();
    let last = '';
    let stableSince: number | null = null;
    const tick = (): void => {
      void (async () => {
        if (this.exited) return;
        await this.screen.flush();
        const text = this.text();
        if (knownScreen(text) || text !== last) {
          stableSince = knownScreen(text) ? null : Date.now();
          last = text;
          return;
        }
        if (stableSince === null || Date.now() - stableSince < UNKNOWN_STABLE_MS) return;
        const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
        if (seen.has(hash)) return;
        seen.add(hash);
        writeFileSync(join(dir, `unknown-${hash}.ansi`), CLEAR_HOME + text);
        writeFileSync(join(dir, `unknown-${hash}.raw.ansi`), this.raw);
        console.warn(`[capture] unknown screen dumped: ${dir}/unknown-${hash}.ansi`);
      })();
    };
    this.watchdog = setInterval(tick, UNKNOWN_POLL_MS);
    this.watchdog.unref?.();
  }

  stopUnknownWatch(): void {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  /**
   * Clicks the screen cell holding the first occurrence of `label` (e.g. the `✕ End
   * session` status-bar button) via an SGR mouse press/release pair. Coordinates are
   * 1-based; the flattened text is a SCREEN_ROWS x SCREEN_COLS grid, matching what the
   * TUI laid out. Returns false when the label is not on screen.
   */
  clickText(label: string): boolean {
    const lines = this.text().split('\n').slice(0, SCREEN_ROWS);
    for (let row = 0; row < lines.length; row++) {
      const col = lines[row]!.indexOf(label);
      if (col < 0) continue;
      const x = col + 1 + Math.floor(label.length / 2);
      const y = row + 1;
      this.pty.write(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
      return true;
    }
    return false;
  }

  /** Resolves once `want` holds and the screen has stopped repainting; fails with the last screen. */
  async waitScreen(why: string, want: (text: string) => boolean, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let matchedAt: number | null = null;
    let last = '';
    for (;;) {
      if (this.exited) throw new Error(`freebuff exited while waiting for screen "${why}"`);
      await this.screen.flush();
      const text = this.text();
      if (want(text) && text === last) {
        matchedAt ??= Date.now();
        if (Date.now() - matchedAt >= SETTLE_MS) return text;
      } else {
        matchedAt = null;
      }
      last = text;
      if (Date.now() > deadline) {
        throw new Error(`screen "${why}" not reached within ${timeoutMs}ms; last screen:\n${flatDump(text)}`);
      }
      await sleep(POLL_MS);
    }
  }

  /** Writes `<name>.ansi` (committed fixture) into `fixtureDir` and `<name>.raw.ansi` (review copy) into `rawDir`. */
  saveFixture(fixtureDir: string, rawDir: string, name: string): string {
    mkdirSync(fixtureDir, { recursive: true });
    mkdirSync(rawDir, { recursive: true });
    const flattened = this.text();
    const fixture = CLEAR_HOME + flattened.split('\n').map((row) => row.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '') + '\n';
    writeFileSync(join(fixtureDir, `${name}.ansi`), fixture);
    writeFileSync(join(rawDir, `${name}.raw.ansi`), this.raw);
    return fixture;
  }

  kill(): void {
    this.stopUnknownWatch();
    this.pty.kill();
  }
}

/** Chats root of the real CLI (launcher-installed 0.0.193: ~/.config/manicode/projects/<basename>/chats). */
export const realChatsRoot = (cwd: string): string =>
  join(homedir(), '.config', 'manicode', PROJECTS_DIRNAME, projectKey(cwd), CHATS_DIRNAME);

export const snapshotChats = (root: string): ChatDirSnapshot[] => {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.flatMap((dirName) => {
    const logPath = join(root, dirName, LOG_FILENAME);
    try {
      const log = statSync(logPath);
      return [{ dirName, mtimeMs: log.mtimeMs, logBytes: log.size, logText: readFileSync(logPath, 'utf8') }];
    } catch {
      return [];
    }
  });
};
