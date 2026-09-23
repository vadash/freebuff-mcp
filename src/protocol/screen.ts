// Screen classification over a real VT emulator (@xterm/headless, MIT); the CLI's rendering
// exceeds hand-rolled VT support, and raw PTY history is not the visible screen.
import headless from '@xterm/headless';
import { SCREEN_COLS, SCREEN_ROWS } from '../config.ts';
import { CONNECTING, PICKER_TITLE, READY_PROMPT } from './markers.ts';

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

export interface ScreenVerdict { ready: boolean; connecting: boolean; picker: 'expanded' | 'collapsed' | null; banner: string | null }

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
  return { ready, connecting, picker, banner };
}

export const flattenScreen = async (chunks: string[]): Promise<string> => {
  const screen = new CliTerminalScreen();
  for (const chunk of chunks) screen.write(chunk);
  await screen.flush();
  return screen.text();
};
