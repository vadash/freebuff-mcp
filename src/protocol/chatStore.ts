import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { FULL_RESPONSE_KEY, MSG_KEY, SHOULD_END_TURN_KEY, TURN_END_MSG } from './markers.ts';

// freebuff's config dir: the chat store, the metadata file and the lock records live
// under it. The Driver hands it to the CLI as FREEBUFF_CONFIG_DIR and the capture
// harness reads the real store under it — one owner, so the spellings cannot drift.
export const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'manicode');

// The chat store's on-disk layout: <configDir>/projects/<projectKey(cwd)>/chats/
// <timestamp>/log.jsonl. An Ack line mentioning the prompt, then the Turn end line
// carrying data.fullResponse. Re-verified on 0.0.199; `~/.freebuff` held per-project
// state only for older builds.
const PROJECTS_DIRNAME = 'projects';
const CHATS_DIRNAME = 'chats';
const LOG_FILENAME = 'log.jsonl';

// Issue #1: basename-key collisions are accepted; the real app keys chats by plain basename.
export function projectKey(dir: string): string {
  return basename(dir);
}

export type ChatDirSnapshot = { dirName: string; mtimeMs: number; logBytes: number; logText: string };
export type TurnBaseline = { dirName: string; logBytes: number };
export type TurnCompletion = { done: boolean; answer: string | null };

const chatsRoot = (configDir: string, dir: string): string =>
  join(configDir, PROJECTS_DIRNAME, projectKey(dir), CHATS_DIRNAME);

// Reads every chat dir of the store: log mtime, size and text when log.jsonl exists;
// a dir-mtime fallback entry (logBytes 0, empty text) for a chat dir whose log is not
// written yet (the Turn-start race) or cannot be read (e.g. locked mid-write); a
// missing store reads as none.
export function readChats(configDir: string, dir: string): ChatDirSnapshot[] {
  const root = chatsRoot(configDir, dir);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const snaps: ChatDirSnapshot[] = [];
  for (const dirName of names) {
    const logPath = join(root, dirName, LOG_FILENAME);
    try {
      const log = statSync(logPath);
      snaps.push({ dirName, mtimeMs: log.mtimeMs, logBytes: log.size, logText: readFileSync(logPath, 'utf8') });
    } catch {
      try {
        const chatDir = statSync(join(root, dirName));
        snaps.push({ dirName, mtimeMs: chatDir.mtimeMs, logBytes: 0, logText: '' });
      } catch {
        // Dir vanished between readdir and stat.
      }
    }
  }
  return snaps;
}

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

// Ack shapes seen in the wild: the stub logs the prompt as the msg field; the real app
// nests it under data.prompt on the agent start/end lines. Since the 2026-09 update the
// real app labels bigger bracketed pastes, storing `[Pasted Text]\n` + prompt, so a
// mention is an exact match or a labeled paste carrying the prompt as its tail.
export function lineMentionsPrompt(json: Record<string, unknown>, prompt: string): boolean {
  if (json[MSG_KEY] === prompt) return true;
  const data = typeof json.data === 'object' && json.data !== null ? (json.data as Record<string, unknown>) : null;
  const stored = data?.prompt;
  return typeof stored === 'string' && (stored === prompt || stored.endsWith(prompt));
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

function completionAt(lines: JsonLine[], i: number): TurnCompletion {
  for (let j = i - 1; j >= 0; j--) {
    const prev = lines[j].json;
    if (prev === null) continue;
    const data = asRecord(prev.data);
    if (prev[SHOULD_END_TURN_KEY] !== true && data?.[SHOULD_END_TURN_KEY] !== true) continue;
    const answer =
      typeof data?.[FULL_RESPONSE_KEY] === 'string'
        ? data[FULL_RESPONSE_KEY]
        : typeof prev[FULL_RESPONSE_KEY] === 'string'
          ? prev[FULL_RESPONSE_KEY]
          : null;
    return { done: true, answer };
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
