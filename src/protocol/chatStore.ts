import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { FULL_RESPONSE_KEY, MSG_KEY, SHOULD_END_TURN_KEY, TURN_END_MSG } from './markers.ts';

export function projectKey(cwd: string, resolvedCwd: string): string {
  return `${basename(cwd)}--${createHash('sha256').update(resolvedCwd).digest('hex').slice(0, 12)}`;
}

export type ChatDirSnapshot = { dirName: string; mtimeMs: number; logBytes: number; logText: string };
export type TurnBaseline = { dirName: string; logBytes: number };
export type TurnCompletion = { done: boolean; answer: string | null };

type JsonLine = { start: number; byteStart: number; json: Record<string, unknown> | null };

export const byNewest = (a: ChatDirSnapshot, b: ChatDirSnapshot): number =>
  b.mtimeMs - a.mtimeMs || (a.dirName < b.dirName ? 1 : a.dirName > b.dirName ? -1 : 0);

// Lazy flushes split lines mid-write: a trailing fragment without a newline is
// not a line yet.
function logLines(text: string): JsonLine[] {
  const lines: JsonLine[] = [];
  let byteStart = 0;
  const limit = text.endsWith('\n') ? text.length : text.lastIndexOf('\n') + 1;
  for (let start = 0; start < limit; ) {
    const nl = text.indexOf('\n', start);
    if (nl < 0 || nl >= limit) break;
    let json: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(text.slice(start, nl));
      if (value !== null && typeof value === 'object') json = value as Record<string, unknown>;
    } catch {
      // Malformed or half-flushed line: skip silently.
    }
    lines.push({ start, byteStart, json });
    const lineBytes = Buffer.byteLength(text.slice(start, nl), 'utf8') + 1;
    byteStart += lineBytes;
    start = nl + 1;
  }
  return lines;
}

export function newestChatDir(dirs: ChatDirSnapshot[]): ChatDirSnapshot | null {
  return dirs.length === 0 ? null : dirs.reduce((newest, d) => (byNewest(d, newest) < 0 ? d : newest));
}

export function hasLineSince(snap: ChatDirSnapshot, fromBytes: number, test: (json: Record<string, unknown>) => boolean): boolean {
  for (const { byteStart, json } of logLines(snap.logText)) {
    if (byteStart >= fromBytes && json !== null && test(json)) return true;
  }
  return false;
}

function completionAt(lines: JsonLine[], i: number): TurnCompletion {
  for (let j = i - 1; j >= 0; j--) {
    const prev = lines[j].json;
    if (prev && prev[SHOULD_END_TURN_KEY] === true) {
      const data = prev.data;
      const answer =
        data !== null && typeof data === 'object' && typeof (data as Record<string, unknown>)[FULL_RESPONSE_KEY] === 'string'
          ? ((data as Record<string, unknown>)[FULL_RESPONSE_KEY] as string)
          : null;
      return { done: true, answer };
    }
  }
  return { done: true, answer: null };
}

function scanDir(snap: ChatDirSnapshot, from: number): TurnCompletion | null {
  const lines = logLines(snap.logText);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].byteStart < from) continue;
    if (lines[i].json?.[MSG_KEY] !== TURN_END_MSG) continue;
    return completionAt(lines, i);
  }
  return null;
}

export function detectTurnEnd(snapshots: ChatDirSnapshot[], baseline: TurnBaseline): TurnCompletion {
  const base = snapshots.find((s) => s.dirName === baseline.dirName);
  if (base) {
    const hit = scanDir(base, baseline.logBytes);
    if (hit) return hit;
  }
  const newer = base
    ? snapshots.filter((s) => byNewest(s, base) < 0)
    : snapshots.filter((s) => s.dirName !== baseline.dirName);
  for (const snap of newer.sort(byNewest)) {
    const hit = scanDir(snap, 0);
    if (hit) return hit;
  }
  return { done: false, answer: null };
}
