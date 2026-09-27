import { describe, expect, it } from 'vitest';
import { buildPrompt, lastReset, pickFile } from '../scripts/streak-keeper.mjs';

describe('lastReset', () => {
  it('returns today 21:00 UTC after the boundary', () => {
    expect(lastReset(new Date('2026-09-27T22:00:00Z')).toISOString()).toBe('2026-09-27T21:00:00.000Z');
  });

  it('returns yesterday 21:00 UTC before the boundary', () => {
    // 00:45 TRT = 21:45 UTC previous day — already past the boundary.
    expect(lastReset(new Date('2026-09-27T00:45:00Z')).toISOString()).toBe('2026-09-26T21:00:00.000Z');
  });

  it('at exactly 21:00 UTC the reset has happened', () => {
    expect(lastReset(new Date('2026-09-27T21:00:00Z')).toISOString()).toBe('2026-09-27T21:00:00.000Z');
  });
});

describe('prompt variance', () => {
  const files = ['src/a.ts', 'src/b.ts', 'src/protocol/screen.ts'];

  it('is deterministic within a day and varies across days', () => {
    expect(buildPrompt(files, '2026-09-26')).toBe(buildPrompt(files, '2026-09-26'));
    expect(buildPrompt(files, '2026-09-27')).not.toBe(buildPrompt(files, '2026-09-26'));
  });

  it('names a real file and forbids edits', () => {
    const prompt = buildPrompt(files, '2026-09-26');
    expect(files.some((file) => prompt.includes(file))).toBe(true);
    expect(prompt).toMatch(/do not edit/i);
  });

  it('falls back when no source files exist', () => {
    expect(buildPrompt([], '2026-09-26')).toMatch(/\btoday\b/);
  });

  it('every file is reachable across a long run', () => {
    const picked = new Set(Array.from({ length: 60 }, (_, day) => pickFile(files, `2026-09-${String(day + 1).padStart(2, '0')}`)));
    expect(picked.size).toBeGreaterThan(1);
  });
});
