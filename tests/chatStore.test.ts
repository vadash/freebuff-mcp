import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectTurnEnd, newestChatDir, projectKey } from '../src/protocol/chatStore.ts';
import type { ChatDirSnapshot, TurnBaseline } from '../src/protocol/chatStore.ts';

const dir = new URL('./fixtures/chat/', import.meta.url);
const load = (name: string): string => readFileSync(new URL(name, dir), 'utf8');
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const upTo = (text: string, marker: string): number => bytes(text.slice(0, text.indexOf(marker) + marker.length));
const prefix = (text: string, logBytes: number): string => Buffer.from(text, 'utf8').subarray(0, logBytes).toString('utf8');

const snap = (dirName: string, mtimeMs: number, logText: string, logBytes = bytes(logText)): ChatDirSnapshot =>
  ({ dirName, mtimeMs, logBytes, logText });
const baselineOf = (s: ChatDirSnapshot): TurnBaseline => ({ dirName: s.dirName, logBytes: s.logBytes });

describe('projectKey', () => {
  it('builds basename--12-char-hash of the resolved cwd', () => {
    expect(projectKey('demo-app', 'C:/work/demo-app')).toBe('demo-app--a3d7ae616906');
  });

  it('distinguishes same-named dirs under different parents', () => {
    expect(projectKey('demo-app', 'C:/work/demo-app')).not.toBe(projectKey('demo-app', 'D:/elsewhere/demo-app'));
  });
});

describe('newestChatDir', () => {
  it('returns null when there are no chat dirs', () => {
    expect(newestChatDir([])).toBeNull();
  });

  it('picks the dir with the newest mtime', () => {
    const a = snap('chat-a', 1000, '');
    const b = snap('chat-b', 2000, '');
    expect(newestChatDir([a, b])).toBe(b);
  });

  it('breaks mtime ties by dirName', () => {
    const a = snap('chat-a', 1000, '');
    const b = snap('chat-b', 1000, '');
    expect(newestChatDir([a, b])).toBe(b);
  });
});

describe('detectTurnEnd', () => {
  it('sees a completed turn and extracts the answer', () => {
    const text = load('full-turn.jsonl');
    const baseline: TurnBaseline = { dirName: 'chat-001', logBytes: upTo(text, '"parts":["fix the login bug"]}'), };
    expect(detectTurnEnd([snap('chat-001', 1000, text)], baseline)).toEqual({ done: true, answer: 'Fixed the login redirect.' });
  });

  it('tolerates lazy flushes spread over several observations', () => {
    const text = load('lazy-flush.jsonl');
    const head = text.slice(0, text.indexOf('\n') + 1);
    const baseline: TurnBaseline = { dirName: 'chat-002', logBytes: bytes(head) };

    expect(detectTurnEnd([snap('chat-002', 1000, head)], baseline)).toEqual({ done: false, answer: null });

    const cut = text.indexOf('"msg"') + '"msg":"Main prompt fin'.length;
    expect(detectTurnEnd([snap('chat-002', 1000, prefix(text, cut))], baseline)).toEqual({ done: false, answer: null });

    expect(detectTurnEnd([snap('chat-002', 1000, text)], baseline)).toEqual({ done: true, answer: 'Added /health returning ok.' });
  });

  it('follows a completion into a newer chat dir', () => {
    const before = load('newer-dir-before.jsonl');
    const after = load('newer-dir-after.jsonl');
    const old = snap('2026-09-23--a111', 1000, before);
    const newer = snap('2026-09-23--b222', 2000, after);
    expect(detectTurnEnd([old, newer], baselineOf(old))).toEqual({ done: true, answer: 'Refactor complete.' });
  });

  it('finds the answer even when it predates the baseline', () => {
    const text = load('answer-below-baseline.jsonl');
    const baseline: TurnBaseline = { dirName: 'chat-004', logBytes: upTo(text, '"parts":["now benchmark it"]'), };
    expect(detectTurnEnd([snap('chat-004', 1000, text)], baseline)).toEqual({ done: true, answer: 'Parser handles nested lists.' });
  });

  it('detects completion past a baseline that contains multibyte characters', () => {
    const text =
      '{"type":"user","parts":["explain 🤖 emoji handling"]}\n' +
      '{"type":"end","role":"agent","shouldEndTurn":true,"data":{"fullResponse":"Emoji-safe."}}\n' +
      '{"msg":"Main prompt finished"}\n';
    const baseline: TurnBaseline = { dirName: 'chat-007', logBytes: upTo(text, '"parts":["explain 🤖 emoji handling"]') };
    expect(detectTurnEnd([snap('chat-007', 1000, text)], baseline)).toEqual({ done: true, answer: 'Emoji-safe.' });
  });

  it('ignores a JSONL line split at the byte boundary', () => {
    const text = load('split-line.jsonl');
    const s = snap('chat-005', 1000, text, upTo(text, '"parts":["run the tests"]}'));
    expect(detectTurnEnd([s], baselineOf(s))).toEqual({ done: false, answer: null });
  });

  it('stays pending without a completion line', () => {
    const text = load('no-completion.jsonl');
    const s = snap('chat-006', 1000, text);
    expect(detectTurnEnd([s], baselineOf(s))).toEqual({ done: false, answer: null });
  });
});
