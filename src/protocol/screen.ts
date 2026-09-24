// Screen classification over a real VT emulator (@xterm/headless, MIT); the CLI's rendering
// exceeds hand-rolled VT support, and raw PTY history is not the visible screen.
import headless from '@xterm/headless';
import { SCREEN_COLS, SCREEN_ROWS } from '../config.ts';
import { CONNECTING, CONTINUE_PROMPT, COUNTDOWN_REGEX, FREEBUCKS_BALANCE_REGEX, FREEBUCKS_LEFT_REGEX, PICKER_TITLE, PRICE_REGEX, READY_PROMPT, SESSION_ENDED } from './markers.ts';

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
    freebucksBalance: balance !== null ? Number(balance[1]) : left !== null ? Number(left[1]) : null,
    freebucksDaily: balance !== null ? Number(balance[2]) : null,
    countdownMinutes: countdownMinutes(text),
    continueScreen: text.includes(SESSION_ENDED) && text.includes(CONTINUE_PROMPT),
  };
}

export const flattenScreen = async (chunks: string[]): Promise<string> => {
  const screen = new CliTerminalScreen();
  for (const chunk of chunks) screen.write(chunk);
  await screen.flush();
  return screen.text();
};
