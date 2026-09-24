import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { requestPipe } from '../../src/ipc.ts';
import { sleep } from '../../src/util.ts';

export const stubPath = fileURLToPath(new URL('../stub-freebuff.mjs', import.meta.url));
export const supervisorEntry = fileURLToPath(new URL('../../src/supervisor.ts', import.meta.url));
export const serverEntry = fileURLToPath(new URL('../../src/server.ts', import.meta.url));

export type SupervisorProcess = ChildProcess;

let pipeCounter = 0;
export const uniquePipe = (label: string): string => `\\\\.\\pipe\\freebuff-test-${label}-${process.pid}-${pipeCounter++}`;

export interface HarnessDirs {
  configDir: string;
  taskDir: string;
  otherDir: string;
}

export interface HarnessOptions extends HarnessDirs {
  pipeName: string;
  mode: string;
  realDriver?: boolean;
  delayMs?: number;
  taskTimeoutMs?: number;
  freezeMs?: number;
  settings?: { freebuffModel: string };
  modelsFile?: string;
  /** Extra stub environment (e.g. FREEBUFF_STUB_COUNTDOWN_MIN) merged into the driver JSON. */
  stubEnv?: Record<string, string>;
}

export const makeDirs = (settings?: { freebuffModel: string }): HarnessDirs => {
  const configDir = mkdtempSync(join(tmpdir(), 'freebuff-sup-config-'));
  if (settings) writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings));
  return {
    configDir,
    taskDir: mkdtempSync(join(tmpdir(), 'freebuff-sup-task-')),
    otherDir: mkdtempSync(join(tmpdir(), 'freebuff-sup-other-')),
  };
};

export const childEnv = (options: HarnessOptions): NodeJS.ProcessEnv => ({
  ...process.env,
  FREEBUFF_SUPERVISOR_PIPE: options.pipeName,
  FREEBUFF_TASK_TIMEOUT_MS: String(options.taskTimeoutMs ?? 20 * 60_000),
  ...(options.freezeMs === undefined ? {} : { FREEBUFF_FREEZE_THRESHOLD_MS: String(options.freezeMs) }),
  ...(options.realDriver
    ? {}
    : {
        FREEBUFF_DRIVER_JSON: JSON.stringify({
          executable: process.execPath,
          argsPrefix: [stubPath],
          configDir: options.configDir,
          env: {
            FREEBUFF_STUB_MODE: options.mode,
            ...(options.delayMs === undefined ? {} : { FREEBUFF_STUB_DELAY_MS: String(options.delayMs) }),
            ...(options.stubEnv ?? {}),
          },
        }),
      }),
  ...(options.modelsFile === undefined ? {} : { FREEBUFF_MODELS_FILE: options.modelsFile }),
});

export const plainEnv = (options: HarnessOptions): Record<string, string> =>
  Object.fromEntries(
    Object.entries(childEnv(options)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const startSupervisor = (options: HarnessOptions): ChildProcess => {
  const proc = spawn(process.execPath, ['--experimental-strip-types', supervisorEntry], {
    env: childEnv(options),
    stdio: 'inherit',
    detached: true,
  });
  proc.unref();
  return proc;
};

export const pollStatus = async (
  pipeName: string,
  wanted: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await requestPipe<Record<string, unknown>>(pipeName, { op: 'status' });
    const matched = Object.entries(wanted).every(([key, value]) => status[key] === value);
    if (matched) return status;
    if (Date.now() > deadline) {
      throw new Error(`status never matched ${JSON.stringify(wanted)}; last was ${JSON.stringify(status)}`);
    }
    await sleep(150);
  }
};

export const expectExit = async (proc: ChildProcess, timeoutMs = 5_000): Promise<void> => {
  if (proc.exitCode !== null) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  proc.once('exit', () => resolve());
  const timer = setTimeout(resolve, timeoutMs);
  await promise;
  clearTimeout(timer);
};

export const answerOf = (result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string => {
  expect(result.isError).toBeFalsy();
  return result.content[0]!.text ?? '';
};
