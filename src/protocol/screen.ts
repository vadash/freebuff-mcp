// Screen classification over a real VT emulator (@xterm/headless, MIT); the CLI's rendering
// exceeds hand-rolled VT support, and raw PTY history is not the visible screen.
import headless from '@xterm/headless';
import { homedir } from 'node:os';
import { SCREEN_COLS, SCREEN_ROWS } from '../config.ts';
import { COUNTDOWN_REGEX, FOOTER_SEPARATOR, FREEBUCKS_BALANCE_REGEX, FREEBUCKS_LEFT_REGEX, KNOWN_ERROR_STRINGS, MODEL_FOOTER_HINT, STATUS_SEPARATOR } from './markers.ts';
import { recognizeScreen, type Recognition } from './signatures.ts';

const { Terminal } = headless;

/** VT screen state from @xterm/headless; writes parse asynchronously behind an ordered queue. */
export class CliTerminalScreen {
  private term = new Terminal({ cols: SCREEN_COLS, rows: SCREEN_ROWS, scrollback: 0, allowProposedApi: true });
  private pending: Promise<void> = Promise.resolve();

  write(chunk: string): void {
    this.pending = this.pending.then(() => new Promise<void>((resolve) => this.term.write(chunk, resolve)));
  }

  flush(): Promise<void> {
    return this.pending;
  }

  text(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < SCREEN_ROWS; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    return lines.join('\n');
  }
}

/** Strict parses of the Screen text — values only. Screen identity is never here:
 *  it lives only in recognition.screen (one screen oracle, ADR-0002). */
export interface ScreenVerdict {
  banner: string | null;
  activeModel: string | null;
  freebucksBalance: number | null;
  freebucksDaily: number | null;
  countdownMinutes: number | null;
}

/** The one screen assessment: which screen is showing (tolerant recognition) plus the
 *  strict parses. Callers branch on recognition.screen and read verdict values. */
export interface ScreenAssessment {
  recognition: Recognition;
  verdict: ScreenVerdict;
}

/** Minutes left in the Hour session from the Countdown line, or null. `m:ss left` floors.
 *  Null is "time left unknown", never zero: the Bind lock enforces only on minutes it
 *  has proven (issue #30; story 10 of #25). */
export const countdownMinutes = (text: string): number | null => {
  const match = COUNTDOWN_REGEX.exec(text);
  if (match === null) return null;
  if (match[4] !== undefined) return Number(match[4]);
  const hours = match[1] !== undefined ? Number(match[1]) : 0;
  const minutes = match[2] !== undefined ? Number(match[2]) : match[3] !== undefined ? Number(match[3]) : 0;
  return hours * 60 + minutes;
};

/** Model on the footer status line (`DeepSeek V4.1 Flash • high · <dir> · /model to
 *  change · Chat: New chat`), the same line on the Welcome screen and while a session
 *  runs: the bottom-most hint-anchored line, first segment before `•`. Null — including
 *  a drifted footer — reports no active model and never guesses one. */
export const footerModel = (text: string): string | null => {
  const lines = text.split('\n');
  let line: string | undefined;
  for (const candidate of lines) if (candidate.includes(MODEL_FOOTER_HINT)) line = candidate;
  if (line === undefined) return null;
  const bullet = line.indexOf(FOOTER_SEPARATOR);
  const cut = bullet !== -1 ? bullet : line.indexOf(STATUS_SEPARATOR);
  const model = line.slice(0, cut).trim();
  return model === '' ? null : model;
};

export function classifyScreen(text: string, expectedDir?: string): ScreenAssessment {
  // One recognition pass per call: recognition is tolerant (priority, regions,
  // thresholds), the parsing below stays strict and fails safely per field (issue #30).
  const recognition = recognizeScreen(text);
  const lines = text.split('\n');

  // Strict banner parse: ready or Welcome without the expected dir line yields null and
  // the Driver fails dir_mismatch rather than working in the wrong directory.
  // freebuff tilde-compresses dirs under the user profile in its dir line
  // (`~\AppData\...`), so expand before the literal match or every home-under
  // workspace (e.g. %TEMP%) fails dir_mismatch.
  const expandTilde = (line: string): string =>
    line.replace(/(^|\s)~(?=[\\/])/, (_match, before: string) => before + homedir());
  const banner =
    expectedDir !== undefined && lines.some((line) => expandTilde(line).includes(expectedDir)) ? expectedDir : null;
  const balance = FREEBUCKS_BALANCE_REGEX.exec(text);
  const left = FREEBUCKS_LEFT_REGEX.exec(text);
  return {
    recognition,
    verdict: {
      banner,
      // ADR-0004: the model is never chosen, only observed — the footer carries it on
      // the Welcome screen and while a session runs. Mid-Turn (neither recognized)
      // reports null rather than a guess.
      activeModel:
        recognition.screen === 'ready' || recognition.screen === 'Welcome screen' ? footerModel(text) : null,
      freebucksBalance: balance !== null ? Number(balance[1]) : left !== null ? Number(left[1]) : null,
      freebucksDaily: balance !== null ? Number(balance[2]) : null,
      countdownMinutes: countdownMinutes(text),
    },
  };
}

/** A timer line: a parseable Countdown line, or any status-line-shaped line carrying a
 *  bare duration token — drifted wording (`58m remaining`) misses COUNTDOWN_REGEX, and
 *  the mid-Turn ticker ticks elapsed seconds (`working · 3s · ■ Esc`,
 *  `⎘ • 3s • △▽`), yet neither may ever enter the Freeze key, or every frame would
 *  hash differently each second and a hung Turn would never read as frozen (issue #31).
 *  Static lines are identical between frames, so over-stripping cannot mask a freeze. */
const isTimerLine = (line: string): boolean =>
  COUNTDOWN_REGEX.test(line) ||
  ((line.includes(STATUS_SEPARATOR) || line.includes(FOOTER_SEPARATOR)) &&
    /\b(?:\d+h(?:\s+\d+m)?|\d+m|\d+:\d\d|\d+s)\b/.test(line));

/** The Screen as the Watchdog compares it: Countdown and Freebucks lines dropped, so a
 *  ticking timer never masks a freeze. */
export const freezeKey = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !isTimerLine(line) && !FREEBUCKS_BALANCE_REGEX.test(line) && !FREEBUCKS_LEFT_REGEX.test(line))
    .join('\n');

/** Screen lines carrying a known error Marker, trimmed, one per occurrence, for the error log. */
export const errorLines = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => KNOWN_ERROR_STRINGS.some((marker) => line.includes(marker)))
    .map((line) => line.trim());

/** The last `count` non-blank Screen lines, right-trimmed, for failure messages. */
export const screenExcerpt = (text: string, count: number): string =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-count)
    .join('\n');

export const flattenScreen = async (chunks: string[]): Promise<string> => {
  const screen = new CliTerminalScreen();
  for (const chunk of chunks) screen.write(chunk);
  await screen.flush();
  return screen.text();
};
