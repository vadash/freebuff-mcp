import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FreebuffDriver } from '../src/driver.ts';
import { CONTINUE_PROMPT } from '../src/protocol/markers.ts';
import { classifyScreen } from '../src/protocol/screen.ts';
import { sleep } from '../src/util.ts';

const stub = fileURLToPath(new URL('./stub-freebuff.mjs', import.meta.url));

const harness = (
  mode: string,
  settings?: { freebuffModel: string },
  timeouts?: { readyMs?: number; ackMs?: number },
  opts: { stubEnv?: Record<string, string>; keepAlive?: boolean } = {},
) => {
  const configDir = mkdtempSync(join(tmpdir(), 'freebuff-config-'));
  if (settings) writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings));
  const dir = mkdtempSync(join(tmpdir(), 'freebuff-task-'));
  return {
    driver: new FreebuffDriver({
      executable: process.execPath,
      argsPrefix: [stub],
      configDir,
      timeouts,
      keepAlive: opts.keepAlive ?? false,
      env: { FREEBUFF_STUB_MODE: mode, ...opts.stubEnv },
    }),
    dir,
  };
};

describe('FreebuffDriver', () => {
  it('resolves with the exact scripted answer on the collapsed-picker happy path', async () => {
    const { driver, dir } = harness('happy', { freebuffModel: 'opus-test' });
    await expect(driver.runTask(dir, 'hello driver')).resolves.toBe('stub(opus-test): hello driver');
  }, 30_000);

  it('retries the submit once, then rejects ack-missing without hanging', async () => {
    const { driver, dir } = harness('no-ack', { freebuffModel: 'opus-test' }, { ackMs: 500 });
    const started = Date.now();
    await expect(driver.runTask(dir, 'hello driver')).rejects.toMatchObject({ reason: 'ack_missing' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('dismisses the expanded picker with a single ENTER and still completes', async () => {
    const { driver, dir } = harness('happy');
    await expect(driver.runTask(dir, 'pick me')).resolves.toBe('stub(none): pick me');
  }, 30_000);

  it('rejects process-exited when the agent dies mid-turn', async () => {
    const { driver, dir } = harness('kill-mid-turn', { freebuffModel: 'opus-test' });
    await expect(driver.runTask(dir, 'hello driver')).rejects.toMatchObject({ reason: 'process_exited' });
  }, 30_000);

  it('exposes needsLogin and rejects with needs_login when the TUI demands a login', async () => {
    const { driver, dir } = harness('needs-login', { freebuffModel: 'opus-test' });
    await expect(driver.runTask(dir, 'hello driver')).rejects.toMatchObject({ reason: 'needs_login' });
    expect(driver.needsLogin()).toBe(true);
  }, 30_000);

  it('serves the replayed picker from the last painted screen after a teardown clear', async () => {
    // keepAlive keeps the pty alive across runTask so the driver can idle the Instance at
    // the picker afterward, exactly like the supervisor's driver.
    const { driver, dir } = harness('park-clear', { freebuffModel: 'opus-test' }, undefined, { keepAlive: true });
    await driver.runTask(dir, 'hello driver');
    await driver.park();
    await driver.stop();
    expect(driver.screenText()).toContain('20/25 Freebucks daily');
    const verdict = classifyScreen(driver.screenText());
    expect(verdict.entries).toEqual([
      { name: 'GLM 5.3 Flash', price: 0 },
      { name: 'MiMo 2.6 Flash', price: 0 },
      { name: 'Solar Mini 4', price: 0 },
      { name: 'DeepSeek V4.1 Flash', price: 5 },
    ]);
    expect(verdict.freebucksBalance).toBe(20);
    const probe = driver.probe();
    expect(probe.freebucksDaily).toBe(25);
    expect(probe.freebucksBalance).toBe(20);
    expect(probe.hourSessionMinutesLeft).toBeNull();
  }, 30_000);

  it('exposes the Countdown minutes from the env-controlled stub status line', async () => {
    const { driver, dir } = harness('happy', { freebuffModel: 'opus-test' }, undefined, { stubEnv: { FREEBUFF_STUB_COUNTDOWN_MIN: '37' } });
    await driver.runTask(dir, 'count me');
    expect(driver.probe().hourSessionMinutesLeft).toBe(37);
  }, 30_000);

  it('replays the captured Continue screen after a turn in expire mode', async () => {
    const { driver, dir } = harness('expire', { freebuffModel: 'opus-test' });
    await driver.runTask(dir, 'then expire');
    const deadline = Date.now() + 5_000;
    while (!driver.screenText().includes(CONTINUE_PROMPT) && Date.now() < deadline) await sleep(100);
    const verdict = classifyScreen(driver.screenText());
    expect(verdict.continueScreen).toBe(true);
    expect(verdict.freebucksBalance).toBe(20);
    expect(verdict.ready).toBe(false);
  }, 30_000);

  it('renders env-controlled picker entries and Freebucks balance on the replayed picker', async () => {
    const { driver, dir } = harness('park-clear', { freebuffModel: 'opus-test' }, undefined, {
      stubEnv: {
        FREEBUFF_STUB_PICKER: JSON.stringify([{ name: 'GLM 5.3 Flash', price: 0 }, { name: 'DeepSeek V4.1 Flash', price: 5 }]),
        FREEBUFF_STUB_FREEBUCKS: '3/25',
      },
      keepAlive: true,
    });
    await driver.runTask(dir, 'hello driver');
    await driver.park();
    await driver.stop();
    const verdict = classifyScreen(driver.screenText());
    expect(verdict.entries).toEqual([{ name: 'GLM 5.3 Flash', price: 0 }, { name: 'DeepSeek V4.1 Flash', price: 5 }]);
    expect(verdict.freebucksBalance).toBe(3);
    expect(verdict.freebucksDaily).toBe(25);
  }, 30_000);
});
