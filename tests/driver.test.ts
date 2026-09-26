import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FreebuffDriver } from '../src/driver.ts';
import { CONTINUE_PROMPT, COUNTDOWN_REGEX } from '../src/protocol/markers.ts';
import { classifyScreen } from '../src/protocol/screen.ts';
import { readStubInputs, type StubInput } from './helpers/harness.ts';
import { sleep } from '../src/util.ts';

const stub = fileURLToPath(new URL('./stub-freebuff.mjs', import.meta.url));

// Issue #18/#23: what the stub received, from FREEBUFF_STUB_INPUT_LOG.
const inputEvents = (logDir: string, event: StubInput['event']): StubInput[] =>
  readStubInputs(join(logDir, 'stub-input.jsonl')).filter((entry) => entry.event === event);

const harness = (
  mode: string,
  timeouts?: { readyMs?: number; ackMs?: number },
  opts: { stubEnv?: Record<string, string>; keepAlive?: boolean } = {},
) => {
  const configDir = mkdtempSync(join(tmpdir(), 'freebuff-config-'));
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
    configDir,
  };
};

describe('FreebuffDriver', () => {
  it('resolves with the exact scripted answer on the collapsed-picker happy path', async () => {
    const { driver, dir } = harness('happy');
    await expect(driver.runTask(dir, 'hello driver')).resolves.toBe('stub(GLM 5.3 Flash): hello driver');
  }, 30_000);

  it('retries the submit once, then rejects ack-missing without hanging', async () => {
    const { driver, dir } = harness('no-ack', { ackMs: 500 });
    const started = Date.now();
    await expect(driver.runTask(dir, 'hello driver')).rejects.toMatchObject({ reason: 'ack_missing' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('picks a model at the expanded picker and still completes', async () => {
    const { driver, dir } = harness('happy');
    await expect(driver.runTask(dir, 'pick me')).resolves.toBe('stub(GLM 5.3 Flash): pick me');
  }, 30_000);

  it('rejects process-exited when the agent dies mid-turn', async () => {
    const { driver, dir } = harness('kill-mid-turn');
    await expect(driver.runTask(dir, 'hello driver')).rejects.toMatchObject({ reason: 'process_exited' });
  }, 30_000);

  it('exposes needsLogin and rejects with needs_login when the TUI demands a login', async () => {
    const { driver, dir } = harness('needs-login');
    await expect(driver.runTask(dir, 'hello driver')).rejects.toMatchObject({ reason: 'needs_login' });
    expect(driver.needsLogin()).toBe(true);
  }, 30_000);

  it('idles at the replayed picker without pressing enter and probes the balance', async () => {
    const { driver, dir } = harness('happy', undefined, { keepAlive: true });
    expect(await driver.awaitIdle(dir)).toBe('picker');
    expect(driver.screenText()).toContain('25/25 Freebucks daily');
    const verdict = classifyScreen(driver.screenText());
    expect(verdict.entries).toEqual([{ name: 'GLM 5.3 Flash', price: 0 }]);
    expect(verdict.freebucksBalance).toBe(25);
    const probe = driver.probe();
    expect(probe.freebucksDaily).toBe(25);
    expect(probe.freebucksBalance).toBe(25);
    expect(probe.hourSessionMinutesLeft).toBeNull();
    await driver.stop();
  }, 30_000);

  it('exposes the Countdown minutes from the env-controlled stub status line', async () => {
    const { driver, dir } = harness('happy', undefined, { stubEnv: { FREEBUFF_STUB_COUNTDOWN_MIN: '37' } });
    await driver.runTask(dir, 'count me');
    expect(driver.probe().hourSessionMinutesLeft).toBe(37);
  }, 30_000);

  it('replays the captured Continue screen after a turn in expire mode', async () => {
    const { driver, dir } = harness('expire', undefined, { keepAlive: true });
    await driver.runTask(dir, 'then expire');
    const deadline = Date.now() + 5_000;
    while (!driver.screenText().includes(CONTINUE_PROMPT) && Date.now() < deadline) await sleep(100);
    const verdict = classifyScreen(driver.screenText());
    expect(verdict.continueScreen).toBe(true);
    expect(verdict.freebucksBalance).toBeNull();
    expect(verdict.ready).toBe(false);
    expect(await driver.awaitIdle(dir)).toBe('picker');
    expect(driver.screenText()).toContain(CONTINUE_PROMPT);
    await expect(driver.runTask(dir, 'after continue')).resolves.toBe('stub(GLM 5.3 Flash): after continue');
    expect(driver.screenText()).not.toContain(CONTINUE_PROMPT);
    await driver.stop();
  }, 30_000);

  it('renders env-controlled picker entries and Freebucks balance on the replayed picker', async () => {
    const { driver, dir } = harness('happy', undefined, {
      stubEnv: {
        FREEBUFF_STUB_PICKER: JSON.stringify([{ name: 'GLM 5.3 Flash', price: 0 }, { name: 'DeepSeek V4.1 Flash', price: 5 }]),
        FREEBUFF_STUB_FREEBUCKS: '3/25',
      },
      keepAlive: true,
    });
    expect(await driver.awaitIdle(dir)).toBe('picker');
    const verdict = classifyScreen(driver.screenText());
    expect(verdict.entries).toEqual([{ name: 'GLM 5.3 Flash', price: 0 }, { name: 'DeepSeek V4.1 Flash', price: 5 }]);
    expect(verdict.freebucksBalance).toBe(3);
    expect(verdict.freebucksDaily).toBe(25);
    await driver.stop();
  }, 30_000);

  // Issue #21: the settle loop dumps a screen matching no known class once per freeze
  // signature, in a folder named by the metadata file's version.
  it('dumps the unknown settle screen once per signature under the metadata version folder', async () => {
    const { driver, dir, configDir } = harness('unknown', { readyMs: 2_000 });
    writeFileSync(join(configDir, 'freebuff-metadata.json'), JSON.stringify({ version: '0.0.199' }));
    await expect(driver.runTask(dir, 'hello')).rejects.toMatchObject({ reason: 'ready_timeout' });
    const versionDir = join(configDir, 'screen-dumps', '0.0.199');
    const dumps = readdirSync(versionDir);
    expect(dumps).toHaveLength(1);
    expect(dumps[0]).toMatch(/^[0-9a-f]{64}\.ansi$/);
    const content = readFileSync(join(versionDir, dumps[0]!), 'utf8');
    expect(content).toContain('Quantum flux calibration panel');
    // The file keeps the Countdown lines the signature strips for comparison.
    expect(content).toMatch(COUNTDOWN_REGEX);
    // Second boot on the same screen: same signature, no new file.
    const again = new FreebuffDriver({
      executable: process.execPath,
      argsPrefix: [stub],
      configDir,
      timeouts: { readyMs: 2_000 },
      env: { FREEBUFF_STUB_MODE: 'unknown' },
    });
    await expect(again.runTask(dir, 'hello again')).rejects.toMatchObject({ reason: 'ready_timeout' });
    expect(readdirSync(versionDir)).toHaveLength(1);
    await again.stop();
  }, 30_000);

  it('dumps under "unknown" when the metadata file is unreadable', async () => {
    const { driver, dir, configDir } = harness('unknown', { readyMs: 2_000 });
    await expect(driver.runTask(dir, 'hello')).rejects.toMatchObject({ reason: 'ready_timeout' });
    expect(readdirSync(join(configDir, 'screen-dumps', 'unknown'))).toHaveLength(1);
  }, 30_000);

  // Issue #23: after ~10 s of continuously unrecognized Screen the fallback Enter flips
  // the stub to ready, and the Task completes instead of timing out; the dump is still
  // written exactly once and the fallback stops at the recognized ready screen.
  it('falls back to one Enter on a continuously unrecognized screen and completes the task', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'freebuff-input-'));
    const { driver, dir, configDir } = harness('unknown', { readyMs: 20_000 }, {
      stubEnv: { FREEBUFF_STUB_INPUT_LOG: join(logDir, 'stub-input.jsonl') },
    });
    writeFileSync(join(configDir, 'freebuff-metadata.json'), JSON.stringify({ version: '0.0.231' }));
    const started = Date.now();
    await expect(driver.runTask(dir, 'hello')).resolves.toBe('stub(GLM 5.3 Flash): hello');
    const elapsed = Date.now() - started;
    // The first fallback Enter lands after ~10 s of unknown Screen, not at the 3 s
    // throttle floor, and long before the 20 s ready deadline.
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(elapsed).toBeLessThan(20_000);
    // Exactly one Enter: the fallback stopped once the ready screen was recognized.
    expect(inputEvents(logDir, 'enter')).toHaveLength(1);
    expect(inputEvents(logDir, 'paste')).toHaveLength(1);
    const versionDir = join(configDir, 'screen-dumps', '0.0.231');
    const dumps = readdirSync(versionDir);
    expect(dumps).toHaveLength(1);
    expect(readFileSync(join(versionDir, dumps[0]!), 'utf8')).toContain('Quantum flux calibration panel');
  }, 45_000);

  // Issue #23: the fallback re-fires at most once per ~10 s window while the screen
  // stays unrecognized — the 3 s enter throttle is a floor, never the cadence.
  it('re-fires the fallback Enter only after another ~10 s of unrecognized screen', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'freebuff-input-'));
    const { driver, dir } = harness('unknown', { readyMs: 16_000 }, {
      stubEnv: {
        FREEBUFF_STUB_INPUT_LOG: join(logDir, 'stub-input.jsonl'),
        // Swallow the first fallback Enter so the cadence is observable.
        FREEBUFF_STUB_UNKNOWN_IGNORE_ENTER: '1',
      },
    });
    const started = Date.now();
    await expect(driver.runTask(dir, 'hello')).rejects.toMatchObject({ reason: 'ready_timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(15_000);
    // Exactly one Enter in the 16 s window: none before ~10 s, none on a 3 s cadence.
    expect(inputEvents(logDir, 'enter')).toHaveLength(1);
  }, 45_000);
});
