import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { requestPipe, waitForPipe } from '../src/ipc.ts';
import { acquireSupervisorLock, lockPathFor } from '../src/supervisorLock.ts';
import { expectExit, makeDirs, plainEnv, startSupervisor, supervisorEntry, uniquePipe } from './helpers/harness.ts';

const seed = (pipeName: string, pid: string): string => {
  const path = lockPathFor(pipeName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pid);
  return path;
};

describe('supervisor singleton lock', () => {
  it('is exclusive per pipe name and releasable', () => {
    const pipeName = uniquePipe('lock');
    const first = acquireSupervisorLock(pipeName);
    expect(first).not.toBeNull();
    expect(acquireSupervisorLock(pipeName)).toBeNull();
    first?.release();
    const again = acquireSupervisorLock(pipeName);
    expect(again).not.toBeNull();
    again?.release();
  });

  it('reclaims a stale lock whose pid is dead', () => {
    const pipeName = uniquePipe('lock-dead');
    seed(pipeName, '999999999'); // impossible on Windows (pid space ends far below)
    const lock = acquireSupervisorLock(pipeName);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it('reclaims a lock past its staleness window even with a live pid', () => {
    const pipeName = uniquePipe('lock-old');
    const path = seed(pipeName, String(process.pid));
    const stale = new Date(Date.now() - 60_000);
    utimesSync(path, stale, stale);
    const lock = acquireSupervisorLock(pipeName);
    expect(lock).not.toBeNull();
    lock?.release();
  });

  it('a duplicate supervisor process exits while the first keeps serving', async () => {
    const pipeName = uniquePipe('lock-dup');
    const dirs = makeDirs();
    const first = startSupervisor({ pipeName, mode: 'happy', ...dirs });
    await waitForPipe(pipeName, 10_000);
    const duplicate = spawn(process.execPath, ['--experimental-strip-types', supervisorEntry], {
      env: plainEnv({ pipeName, mode: 'happy', ...dirs }),
      stdio: 'ignore',
      windowsHide: true,
    });
    // Real child process: no deterministic clock can drive its exit, so the
    // vitest timeout is the bound and `once` awaits the actual signal.
    const [exitCode] = await once(duplicate, 'exit');
    expect(exitCode).toBe(0);
    expect(await requestPipe(pipeName, { op: 'status' })).toMatchObject({ ok: true, state: 'stopped' });
    await requestPipe(pipeName, { op: 'shutdown' }).catch(() => {});
    await expectExit(first);
  }, 30_000);
});
