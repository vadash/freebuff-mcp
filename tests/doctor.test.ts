import { describe, expect, it } from 'vitest';
import { runDoctor } from '../src/doctor.ts';

describe('runDoctor', () => {
  it('reports ok with no failures when every marker matches its pinned fixture and signature', () => {
    expect(runDoctor()).toEqual({ ok: true, failures: [] });
  });

  it('names the marker when a tampered value drifts from the pinned protocol', () => {
    const report = runDoctor({ markers: { READY_PROMPT: 'Type a task below' } });
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([expect.stringContaining('READY_PROMPT')]);
  });
});
