import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FreebuffDriver } from '../src/driver.ts';

const stub = fileURLToPath(new URL('./stub-freebuff.mjs', import.meta.url));

const harness = (mode: string, settings?: { freebuffModel: string }, timeouts?: { readyMs?: number; ackMs?: number }) => {
  const configDir = mkdtempSync(join(tmpdir(), 'freebuff-config-'));
  if (settings) writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings));
  const cwd = mkdtempSync(join(tmpdir(), 'freebuff-task-'));
  return {
    driver: new FreebuffDriver({
      executable: process.execPath,
      argsPrefix: [stub],
      configDir,
      timeouts,
      env: { FREEBUFF_STUB_MODE: mode },
    }),
    cwd,
  };
};

describe('FreebuffDriver', () => {
  it('resolves with the exact scripted answer on the collapsed-picker happy path', async () => {
    const { driver, cwd } = harness('happy', { freebuffModel: 'opus-test' });
    await expect(driver.runTask(cwd, 'hello driver')).resolves.toBe('stub(opus-test): hello driver');
  }, 30_000);

  it('retries the submit once, then rejects ack-missing without hanging', async () => {
    const { driver, cwd } = harness('no-ack', { freebuffModel: 'opus-test' }, { ackMs: 500 });
    const started = Date.now();
    await expect(driver.runTask(cwd, 'hello driver')).rejects.toMatchObject({ reason: 'ack-missing' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('dismisses the expanded picker with a single ENTER and still completes', async () => {
    const { driver, cwd } = harness('happy');
    await expect(driver.runTask(cwd, 'pick me')).resolves.toBe('stub(none): pick me');
  }, 30_000);

  it('rejects process-exited when the agent dies mid-turn', async () => {
    const { driver, cwd } = harness('kill-mid-turn', { freebuffModel: 'opus-test' });
    await expect(driver.runTask(cwd, 'hello driver')).rejects.toMatchObject({ reason: 'process-exited' });
  }, 30_000);

  it('exposes needsLogin and rejects with needs_login when the TUI demands a login', async () => {
    const { driver, cwd } = harness('needs-login', { freebuffModel: 'opus-test' });
    await expect(driver.runTask(cwd, 'hello driver')).rejects.toMatchObject({ reason: 'needs_login' });
    expect(driver.needsLogin()).toBe(true);
  }, 30_000);

  it('serves probe text from the last painted screen after a teardown clear', async () => {
    const { driver, cwd } = harness('park-clear', { freebuffModel: 'opus-test' });
    await driver.runTask(cwd, 'hello driver');
    await driver.park();
    await driver.stop();
    expect(driver.screenText()).toContain('Trial: 432 min left');
  }, 30_000);
});
