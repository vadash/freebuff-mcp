import { fork, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  /** Extra stub environment (e.g. FREEBUFF_STUB_COUNTDOWN_MIN) merged into the driver JSON. */
  stubEnv?: Record<string, string>;
}

export const makeDirs = (): HarnessDirs => ({
  configDir: mkdtempSync(join(tmpdir(), 'freebuff-sup-config-')),
  taskDir: mkdtempSync(join(tmpdir(), 'freebuff-sup-task-')),
  otherDir: mkdtempSync(join(tmpdir(), 'freebuff-sup-other-')),
});

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
});

export const plainEnv = (options: HarnessOptions): Record<string, string> =>
  Object.fromEntries(
    Object.entries(childEnv(options)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const startSupervisor = (options: HarnessOptions): ChildProcess => {
  // Not detached: a console-less supervisor makes Windows open a console window for
  // every console program it starts. Tests need no daemon; it shares this console.
  const proc = spawn(process.execPath, ['--experimental-strip-types', supervisorEntry], {
    env: childEnv(options),
    stdio: 'inherit',
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

// node-pty forks this agent on every pty.kill(): it attaches to a pid's console and
// lists the processes sharing it, and fails to attach when the pid has no console.
const consoleListAgent = createRequire(import.meta.url).resolve('node-pty/lib/conpty_console_list_agent');

/** The pids attached to `pid`'s console, or null when `pid` has no console at all. */
export const consoleProcessList = (pid: number): Promise<number[] | null> => {
  const { promise, resolve } = Promise.withResolvers<number[] | null>();
  const agent = fork(consoleListAgent, [String(pid)], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  agent.once('message', (message) => resolve((message as { consoleProcessList: number[] }).consoleProcessList));
  agent.once('disconnect', () => resolve(null));
  agent.once('error', () => resolve(null));
  return promise;
};

export const answerOf = (result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string => {
  expect(result.isError).toBeFalsy();
  return result.content[0]!.text ?? '';
};
