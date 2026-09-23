// Screen state machine vendored from Praket7/freebuff-mcp (MIT).
// ponytail: readiness relies on these VT controls; add xterm-headless if the CLI adopts others.
import { SCREEN_COLS, SCREEN_ROWS } from '../config.ts';
import { CONNECTING, PICKER_TITLE, READY_PROMPT } from './markers.ts';

/** Minimal VT screen state for readiness checks; raw PTY history is not the visible screen. */
export class CliTerminalScreen {
  private lines = Array.from({ length: SCREEN_ROWS }, () => Array<string>(SCREEN_COLS).fill(' '));
  private row = 0;
  private col = 0;
  private mode: 'text' | 'escape' | 'csi' | 'osc' | 'osc-escape' = 'text';
  private csi = '';
  private savedRow = 0;
  private savedCol = 0;

  write(chunk: string): void {
    for (const char of chunk) {
      if (this.mode === 'osc') { if (char === '\x07') this.mode = 'text'; else if (char === '\x1b') this.mode = 'osc-escape'; continue; }
      if (this.mode === 'osc-escape') { this.mode = char === '\\' ? 'text' : 'osc'; continue; }
      if (this.mode === 'escape') {
        this.mode = 'text';
        if (char === '[') { this.mode = 'csi'; this.csi = ''; }
        else if (char === ']') this.mode = 'osc';
        else if (char === '7') { this.savedRow = this.row; this.savedCol = this.col; }
        else if (char === '8') { this.row = this.savedRow; this.col = this.savedCol; }
        else if (char === 'D') this.down(1);
        else if (char === 'M') this.row = Math.max(0, this.row - 1);
        else if (char === 'E') { this.down(1); this.col = 0; }
        continue;
      }
      if (this.mode === 'csi') {
        if (char >= '@' && char <= '~') { this.applyCsi(char); this.mode = 'text'; }
        else this.csi += char;
        continue;
      }
      if (char === '\x1b') this.mode = 'escape';
      else if (char === '\r') this.col = 0;
      else if (char === '\n') this.down(1);
      else if (char === '\b') this.col = Math.max(0, this.col - 1);
      else if (char === '\t') this.col = Math.min(SCREEN_COLS - 1, (this.col + 8) & ~7);
      else if (char >= ' ' && char !== '\x7f') {
        if (this.col >= SCREEN_COLS) { this.col = 0; this.down(1); }
        this.lines[this.row]![this.col++] = char;
      }
    }
  }

  text(): string { return this.lines.map((line) => line.join('').trimEnd()).join('\n'); }

  private down(count: number): void { this.row = Math.min(SCREEN_ROWS - 1, this.row + count); }

  private applyCsi(final: string): void {
    const params = this.csi.replace(/^[?>!]+/, '').split(';').map((n) => Number(n) || 0);
    const n = (index = 0): number => params[index] || 1;
    switch (final) {
      case 'A': this.row = Math.max(0, this.row - n()); break;
      case 'B': this.down(n()); break;
      case 'C': this.col = Math.min(SCREEN_COLS - 1, this.col + n()); break;
      case 'D': this.col = Math.max(0, this.col - n()); break;
      case 'E': this.down(n()); this.col = 0; break;
      case 'F': this.row = Math.max(0, this.row - n()); this.col = 0; break;
      case 'G': this.col = Math.max(0, Math.min(SCREEN_COLS - 1, n() - 1)); break;
      case 'H': case 'f': this.row = Math.max(0, Math.min(SCREEN_ROWS - 1, n() - 1)); this.col = Math.max(0, Math.min(SCREEN_COLS - 1, n(1) - 1)); break;
      case 'd': this.row = Math.max(0, Math.min(SCREEN_ROWS - 1, n() - 1)); break;
      case 'J':
        if (params[0] === 2 || params[0] === 3) this.lines = Array.from({ length: SCREEN_ROWS }, () => Array<string>(SCREEN_COLS).fill(' '));
        else if (params[0] === 0) { this.lines[this.row]!.fill(' ', this.col); for (let r = this.row + 1; r < SCREEN_ROWS; r++) this.lines[r]!.fill(' '); }
        else { for (let r = 0; r < this.row; r++) this.lines[r]!.fill(' '); this.lines[this.row]!.fill(' ', 0, this.col + 1); }
        break;
      case 'K':
        if (params[0] === 0) this.lines[this.row]!.fill(' ', this.col);
        else if (params[0] === 1) this.lines[this.row]!.fill(' ', 0, this.col + 1);
        else if (params[0] === 2) this.lines[this.row]!.fill(' ');
        break;
      case 's': this.savedRow = this.row; this.savedCol = this.col; break;
      case 'u': this.row = this.savedRow; this.col = this.savedCol; break;
    }
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

export function flattenScreen(chunks: string[]): string {
  const screen = new CliTerminalScreen();
  for (const chunk of chunks) screen.write(chunk);
  return screen.text();
}
