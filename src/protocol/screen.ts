// Screen classification over a real VT emulator (@xterm/headless, MIT); the CLI's rendering
// exceeds hand-rolled VT support, and raw PTY history is not the visible screen.
import headless from '@xterm/headless';
import { SCREEN_COLS, SCREEN_ROWS } from '../config.ts';
import { CONNECTING, CONTINUE_PROMPT, COUNTDOWN_REGEX, FREEBUCKS_BALANCE_REGEX, FREEBUCKS_LEFT_REGEX, KNOWN_ERROR_STRINGS, PICKER_TITLE, PRICE_REGEX, READY_PROMPT, SESSION_ENDED, STATUS_SEPARATOR } from './markers.ts';

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

/** Minutes left in the Hour session from the Countdown line, or null. `m:ss left` floors. */
export const countdownMinutes = (text: string): number | null => {
  const match = COUNTDOWN_REGEX.exec(text);
  if (match === null) return null;
  if (match[4] !== undefined) return Number(match[4]);
  const hours = match[1] !== undefined ? Number(match[1]) : 0;
  const minutes = match[2] !== undefined ? Number(match[2]) : match[3] !== undefined ? Number(match[3]) : 0;
  return hours * 60 + minutes;
};

/** Model observed on the ready status line (`Solar Mini 4 · 1h left · 12.9K (3%)`): the
 *  segment before the first `·` on the line carrying the Countdown; null when absent. */
export const statusModel = (text: string): string | null => {
  const line = text.split('\n').find((candidate) => COUNTDOWN_REGEX.test(candidate) && candidate.includes(STATUS_SEPARATOR));
  if (line === undefined) return null;
  const model = line.slice(0, line.indexOf(STATUS_SEPARATOR)).trim();
  return model === '' ? null : model;
};

/** Picker rows after the title: a name line, then its `<n> Freebucks/hr` price line. */
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
  const lines = text.split('\n');
  const connecting = new RegExp(`\\b${CONNECTING}\\b`, 'i').test(text);
  const ready = text.includes(READY_PROMPT) && !connecting;

  let picker: ScreenVerdict['picker'] = null;
  const title = lines.findIndex((line) => line.includes(PICKER_TITLE));
  if (title !== -1) {
    const rows = lines.slice(title + 1).filter((line) => line.trim() !== '');
    picker = rows.length >= 2 ? 'expanded' : rows.length === 1 ? 'collapsed' : null;
  }

  const banner = expectedDir !== undefined && lines.some((line) => line.includes(expectedDir)) ? expectedDir : null;
  const balance = FREEBUCKS_BALANCE_REGEX.exec(text);
  const left = FREEBUCKS_LEFT_REGEX.exec(text);
  return {
    ready,
    connecting,
    picker,
    banner,
    entries: pickerEntries(lines),
    activeModel: statusModel(text),
    freebucksBalance: balance !== null ? Number(balance[1]) : left !== null ? Number(left[1]) : null,
    freebucksDaily: balance !== null ? Number(balance[2]) : null,
    countdownMinutes: countdownMinutes(text),
    continueScreen: text.includes(SESSION_ENDED) && text.includes(CONTINUE_PROMPT),
  };
}

/** The Screen as the Watchdog compares it: Countdown and Freebucks lines dropped, so a
 *  ticking timer never masks a freeze. */
export const freezeSignature = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !COUNTDOWN_REGEX.test(line) && !FREEBUCKS_BALANCE_REGEX.test(line) && !FREEBUCKS_LEFT_REGEX.test(line))
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
