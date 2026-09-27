// Screen classification over a real VT emulator (@xterm/headless, MIT); the CLI's rendering
// exceeds hand-rolled VT support, and raw PTY history is not the visible screen.
import headless from '@xterm/headless';
import { homedir } from 'node:os';
import { SCREEN_COLS, SCREEN_ROWS } from '../config.ts';
import { COUNTDOWN_REGEX, FREEBUCKS_BALANCE_REGEX, FREEBUCKS_LEFT_REGEX, KNOWN_ERROR_STRINGS, PICKER_TITLE, PRICE_REGEX, STATUS_SEPARATOR } from './markers.ts';
import { recognizeScreen } from './signatures.ts';

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

export interface PickerEntry { name: string; price: number }

export interface ScreenVerdict {
  ready: boolean;
  connecting: boolean;
  picker: 'expanded' | 'collapsed' | null;
  banner: string | null;
  entries: PickerEntry[];
  activeModel: string | null;
  freebucksBalance: number | null;
  freebucksDaily: number | null;
  countdownMinutes: number | null;
  continueScreen: boolean;
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

/** Model observed on the ready status line (`GLM 5.3 Flash · 58m left · 12.8K (1%)`): the
 *  segment before the first `·` on the line carrying the Countdown. Null — including a
 *  drifted, empty first segment — reports no active model and never guesses one. */
export const statusModel = (text: string): string | null => {
  const line = text.split('\n').find((candidate) => COUNTDOWN_REGEX.test(candidate) && candidate.includes(STATUS_SEPARATOR));
  if (line === undefined) return null;
  const model = line.slice(0, line.indexOf(STATUS_SEPARATOR)).trim();
  return model === '' ? null : model;
};

/** Picker rows after the title: a name line, then its `<n> Freebucks/hr` price line.
 *  No parseable rows → [], and the pick rule then Enters the highlighted row — what
 *  freebuff itself would do (Fallback Enter; story 9 of #25) — never a wrong pick. */
const pickerEntries = (lines: string[]): PickerEntry[] => {
  const title = lines.findIndex((line) => line.includes(PICKER_TITLE));
  if (title === -1) return [];
  const entries: PickerEntry[] = [];
  let name: string | null = null;
  for (const line of lines.slice(title + 1)) {
    const price = PRICE_REGEX.exec(line);
    if (price !== null) {
      if (name !== null) entries.push({ name, price: Number(price[1]) });
      name = null;
      continue;
    }
    // Price, balance, and invite lines carry the word Freebucks; box borders are not rows.
    if (line.includes('Freebucks') || /[─┌└]/.test(line)) continue;
    const clean = line.replace(/[│›]/g, ' ').trim();
    if (clean === '') continue;
    name = clean.split(/\s{2,}/)[0] ?? null;
  }
  return entries;
};

export function classifyScreen(text: string, expectedDir?: string): ScreenVerdict {
  // Issue #30: the classifier reads the recognized screen from the recognition function
  // instead of re-testing literals; recognition is tolerant (priority, regions,
  // thresholds), the parsing below stays strict and fails safely per field.
  const recognized = recognizeScreen(text).screen;
  const lines = text.split('\n');
  const connecting = recognized === 'connecting';
  const ready = recognized === 'ready';

  // A recognized Model picker whose rows fail to parse stays the picker — degraded to
  // 'collapsed' once fewer than two rows render — so the settle loop still reaches the
  // pick rule and its safe fallback instead of timing out on a drifted picker.
  let picker: ScreenVerdict['picker'] = null;
  if (recognized === 'Model picker') {
    const title = lines.findIndex((line) => line.includes(PICKER_TITLE));
    const rows = title === -1 ? [] : lines.slice(title + 1).filter((line) => line.trim() !== '');
    picker = rows.length >= 2 ? 'expanded' : 'collapsed';
  }

  // Strict banner parse: ready without the expected dir line yields null and the
  // Driver fails dir_mismatch rather than working in the wrong directory.
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
    ready,
    connecting,
    picker,
    banner,
    entries: pickerEntries(lines),
    activeModel: statusModel(text),
    // Missing balance is null, and null keeps the pick rule on its safe default: the
    // deepseek candidate is skipped because affordability cannot be proven (story 11 of #25).
    freebucksBalance: balance !== null ? Number(balance[1]) : left !== null ? Number(left[1]) : null,
    freebucksDaily: balance !== null ? Number(balance[2]) : null,
    countdownMinutes: countdownMinutes(text),
    continueScreen: recognized === 'Continue',
  };
}

/** A timer line: a parseable Countdown line, or any status-line-shaped line carrying a
 *  bare duration token — drifted wording (`58m remaining`) misses COUNTDOWN_REGEX, and
 *  the mid-Turn status line ticks elapsed seconds (`working · 3s · ■ Esc`), yet neither
 *  may ever enter the Freeze key, or every frame would hash differently each second and
 *  a hung Turn would never read as frozen (issue #31). Static lines are identical
 *  between frames, so over-stripping cannot mask a freeze. */
const isTimerLine = (line: string): boolean =>
  COUNTDOWN_REGEX.test(line) || (line.includes(STATUS_SEPARATOR) && /\b(?:\d+h(?:\s+\d+m)?|\d+m|\d+:\d\d|\d+s)\b/.test(line));

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
