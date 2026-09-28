/// <reference lib="es2024" />
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_LOG_POLL_MS, FREEZE_THRESHOLD_MS, TASK_TIMEOUT_MS } from '../src/config.ts';
import { TurnRunner } from '../src/turnRunner.ts';
import { PROMPT_PREAMBLE } from '../src/workspace.ts';
import { ScriptedDriver } from './helpers/scriptedDriver.ts';
import { VirtualClock } from './helpers/virtualClock.ts';

// The captured ready Screen: its ticking Countdown line is what the freeze tests
// mutate, and its wording shows up in failure screenExcerpts.
const readyScreen = readFileSync(new URL('./fixtures/screen/0.1.0/ready.ansi', import.meta.url), 'utf8');

interface Rig {
  driver: ScriptedDriver;
  clock: VirtualClock;
  runner: TurnRunner;
  workspace: string;
  errorLogPath: string;
}

let current: Rig | null = null;

// Fresh rig per test: the ScriptedDriver branches, the VirtualClock drives every
// timer the runner sets, and nothing real ever ticks.
const rig = (config: { taskTimeoutMs?: number; freezeMs?: number } = {}): Rig => {
  const driver = new ScriptedDriver();
  const clock = new VirtualClock();
  const workspace = mkdtempSync(join(tmpdir(), 'turn-runner-'));
  const errorLogPath = join(workspace, 'errors.jsonl');
  const runner = new TurnRunner({
    driver,
    workspace,
    clock,
    taskTimeoutMs: config.taskTimeoutMs ?? TASK_TIMEOUT_MS,
    freezeMs: config.freezeMs ?? FREEZE_THRESHOLD_MS,
    errorLogPath,
  });
  current = { driver, clock, runner, workspace, errorLogPath };
  return current;
};

afterEach(() => {
  if (current !== null) rmSync(current.workspace, { recursive: true, force: true });
  current = null;
});

describe('TurnRunner (one Task, one attempt)', () => {
  it('runs one Task: composes the preamble, targets the workspace, returns the Answer', async () => {
    const { runner, driver, workspace } = rig();
    driver.script({ kind: 'answer', answer: 'stub answer' });
    await expect(runner.run('hello driver')).resolves.toEqual({ ok: true, answer: 'stub answer' });
    expect(driver.prompts).toEqual([`${PROMPT_PREAMBLE}\nhello driver`]);
    // The Instance always runs in the per-pipe workspace; the caller's repo is the junction inside it.
    expect(driver.dirs).toEqual([workspace]);
  });

  it('trips the deadline while the Screen and Chat store keep changing, and never resubmits', async () => {
    const { runner, driver, clock } = rig({ taskTimeoutMs: 20 * 60_000 });
    driver.script({ kind: 'hang' });
    const run = runner.run('endless task');
    // Real Turn output: fresh non-timer Screen lines and log growth keep resetting
    // the freeze clock, so only the deadline can end this Task.
    driver.screen = readyScreen;
    for (let gone = 0; gone < 20 * 60_000; gone += 60_000) {
      driver.screen = `${readyScreen}\nstreaming chunk ${gone}`;
      driver.logSize += 100;
      await clock.advance(60_000);
    }
    const outcome = await run;
    expect(outcome).toMatchObject({ ok: false, reason: 'deadline' });
    if (!outcome.ok) {
      expect(outcome.message).toContain('watchdog failure: deadline: still running at its 20 minutes deadline');
    }
    // Issue #16: one attempt per Task — the prompt is never resubmitted.
    expect(driver.calls.runTask).toBe(1);
  });

  it('fails a task frozen after 3 minutes when only the Countdown ticks (issue #31)', async () => {
    const { runner, driver, clock } = rig();
    driver.script({ kind: 'hang' });
    const run = runner.run('frozen task');
    // The Countdown ticks every step while the Chat store never grows; freezeKey
    // strips timer lines, so the ticking must never reset the freeze clock.
    driver.screen = readyScreen;
    for (let gone = 0; gone < 6 * 60_000; gone += 30_000) {
      driver.screen = readyScreen.replace('1h left', `${Math.max(0, 179 - Math.floor(gone / 30_000))}m left`);
      await clock.advance(30_000);
    }
    const outcome = await run;
    expect(outcome).toMatchObject({ ok: false, reason: 'frozen' });
    if (!outcome.ok) {
      expect(outcome.message).toContain('watchdog failure: frozen: no Screen or Chat store change for 3 minutes');
      // The verdict carries the last Screen lines — including the ticking Countdown itself.
      expect(outcome.screenExcerpt).toContain('Enter a coding task');
      expect(outcome.screenExcerpt).toContain(' left');
    }
    expect(driver.calls.runTask).toBe(1);
  });

  it('resets the freeze clock on a real Screen or Chat store change, so 3 minutes measure from the last change', async () => {
    const { runner, driver, clock } = rig();
    driver.script({ kind: 'hang' });
    let settled = false;
    const run = runner.run('slow then alive').then((verdict) => {
      settled = true;
      return verdict;
    });
    driver.screen = readyScreen;
    await clock.advance(150_000);
    expect(settled).toBe(false);
    // Real output at 2:30 resets the clock: no frozen at 3:00 from the old baseline.
    driver.screen = `${readyScreen}\nnew token`;
    driver.logSize += 10;
    await clock.advance(170_000);
    expect(settled).toBe(false);
    await clock.advance(20_000);
    expect(settled).toBe(true);
    await expect(run).resolves.toMatchObject({ ok: false, reason: 'frozen' });
  });

  it('fails a task crashed when freebuff exits mid-Turn, and leaves respawn to the Supervisor', async () => {
    const { runner, driver } = rig();
    driver.script({ kind: 'hang' });
    const run = runner.run('doomed task');
    driver.alive = false;
    driver.failRunTask('process_exited');
    const outcome = await run;
    expect(outcome).toMatchObject({ ok: false, reason: 'crashed' });
    if (!outcome.ok) expect(outcome.message).toContain('watchdog failure: crashed: freebuff exited mid-task');
    // The runner never touches the Instance lifecycle; the Supervisor respawns.
    expect(driver.calls).toMatchObject({ runTask: 1, stop: 0, kill: 0, awaitIdle: 0, cancelActive: 0 });
  });

  it('reports cancelled when a stopped Turn ends in rejection, with one graceful stop per cancel', async () => {
    const { runner, driver } = rig();
    driver.script({ kind: 'hang' });
    const run = runner.run('victim');
    await runner.stop();
    expect(driver.calls.cancelActive).toBe(1);
    driver.failRunTask('process_exited');
    await expect(run).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
  });

  it('lets a Turn that completes after cancel win with its Answer, as a cancel loses to a finished Turn', async () => {
    const { runner, driver } = rig();
    driver.script({ kind: 'hang' });
    const run = runner.run('racing the stop');
    await runner.stop();
    driver.settleRunTask('finished anyway');
    await expect(run).resolves.toEqual({ ok: true, answer: 'finished anyway' });
  });

  it('passes a Turn that ends without an Answer through as no_answer', async () => {
    const { runner, driver } = rig();
    driver.script({ kind: 'fail', reason: 'no_answer', detail: 'the Turn ended without a fullResponse' });
    const outcome = await runner.run('silent task');
    expect(outcome).toMatchObject({ ok: false, reason: 'no_answer' });
    if (!outcome.ok) expect(outcome.message).toContain('fullResponse');
  });

  it('classifies any other Driver failure as driver_error with its message', async () => {
    const { runner, driver } = rig();
    driver.script({ kind: 'fail', reason: 'dir_mismatch' });
    const outcome = await runner.run('misdirected task');
    expect(outcome).toMatchObject({ ok: false, reason: 'driver_error' });
    if (!outcome.ok) expect(outcome.message).toContain('dir_mismatch');
  });

  it('appends error-Marker Screen lines to the error log once per line per Turn, never acting on them', async () => {
    const { runner, driver, clock, errorLogPath, workspace } = rig();
    driver.script({ kind: 'hang' });
    const run = runner.run('noisy task');
    driver.screen = `${readyScreen}\nCommand not found: foo`;
    await clock.advance(ERROR_LOG_POLL_MS);
    let entries = logEntries(errorLogPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.workspace).toBe(workspace);
    expect(entries[0]!.lines).toEqual(['Command not found: foo']);
    // The same line again: the Turn logs each line once.
    await clock.advance(ERROR_LOG_POLL_MS);
    expect(logEntries(errorLogPath)).toHaveLength(1);
    // The Turn ends; the Instance stays up for the next Task.
    driver.failRunTask('no_answer');
    await run;
    expect(logEntries(errorLogPath)).toHaveLength(1);
    // A second Turn logs only lines new since its own baseline.
    driver.script({ kind: 'hang' });
    const second = runner.run('noisy again');
    driver.screen = `${readyScreen}\nCommand not found: foo\nCommand not found: bar`;
    await clock.advance(ERROR_LOG_POLL_MS);
    driver.failRunTask('no_answer');
    await second;
    entries = logEntries(errorLogPath);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.lines).toEqual(['Command not found: bar']);
  });

  it('formats the verdict message verbatim: prefix, detail, then the last Screen lines', async () => {
    const { runner, driver } = rig({ taskTimeoutMs: 90_000 });
    driver.screen = 'alpha\nbeta';
    driver.script({ kind: 'fail', reason: 'process_exited' });
    const outcome = await runner.run('doomed task');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toBe(
        'watchdog failure: crashed: freebuff exited mid-task\nlast screen lines:\nalpha\nbeta',
      );
      expect(outcome.screenExcerpt).toBe('alpha\nbeta');
    }
  });

  it('turns a Watchdog trip that lands after a stop into cancelled, never a respawn', async () => {
    const { runner, driver, clock } = rig({ taskTimeoutMs: 60_000, freezeMs: 3 * 60_000 });
    driver.script({ kind: 'hang' });
    const run = runner.run('cancel then deadline');
    await runner.stop();
    await clock.advance(61_000); // the deadline trips after the stop
    await expect(run).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    expect(driver.calls).toMatchObject({ stop: 0, kill: 0, awaitIdle: 0, cancelActive: 1 });
  });

  it('routes a prompt above the paste threshold through a temp file in the workspace, removed after the Turn', async () => {
    const { runner, driver, workspace } = rig();
    const big = 'x'.repeat(100 * 1024);
    driver.script({ kind: 'hang' });
    const run = runner.run(big);
    const tempPath = join(workspace, '.freebuff-task-1.md');
    expect(existsSync(tempPath)).toBe(true);
    expect(readFileSync(tempPath, 'utf8')).toBe(big);
    expect(driver.prompts[0]).toBe(
      `${PROMPT_PREAMBLE}\nRead the instructions in .freebuff-task-1.md in the current directory and follow them.`,
    );
    driver.settleRunTask('done');
    await expect(run).resolves.toEqual({ ok: true, answer: 'done' });
    expect(existsSync(tempPath)).toBe(false);
  });

  it('removes the temp file also when the Turn fails, and numbers temp files per Turn', async () => {
    const { runner, driver, workspace } = rig();
    const big = 'x'.repeat(100 * 1024);
    driver.script({ kind: 'hang' }, { kind: 'fail', reason: 'no_answer' });
    const first = runner.run(big);
    expect(existsSync(join(workspace, '.freebuff-task-1.md'))).toBe(true);
    driver.failRunTask('no_answer');
    await first;
    expect(existsSync(join(workspace, '.freebuff-task-1.md'))).toBe(false);
    // The counter is per Turn: the second big prompt gets its own file name.
    const second = runner.run(big);
    expect(driver.prompts[1]).toContain('.freebuff-task-2.md');
    driver.failRunTask('no_answer');
    await second;
    expect(existsSync(join(workspace, '.freebuff-task-2.md'))).toBe(false);
  });
});

/** The error log is JSON lines of `{time, workspace, lines}`; read for assertions. */
const logEntries = (path: string): Array<{ time: string; workspace: string; lines: string[] }> =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { time: string; workspace: string; lines: string[] })
    : [];
