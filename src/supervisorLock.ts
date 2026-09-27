// Only one Supervisor may serve a pipe name. On Windows several servers can
// listen on the same named pipe (multi-instance), so `listen()` alone cannot
// detect a duplicate; a pid lock file per pipe name enforces the singleton.
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// A lock older than this is stale even if its pid is alive: a hard kill leaves
// the file behind, and the pid may have been reused by an unrelated process.
const STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;

export interface SupervisorLock {
  release(): void;
}

export const lockPathFor = (pipeName: string): string =>
  join(tmpdir(), 'freebuff-supervisor-locks', createHash('sha1').update(pipeName).digest('hex') + '.lock');

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const held = (path: string): boolean => {
  try {
    const pid = Number(readFileSync(path, 'utf8'));
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid) && Date.now() - statSync(path).mtimeMs <= STALE_MS;
  } catch {
    return false;
  }
};

export const acquireSupervisorLock = (pipeName: string): SupervisorLock | null => {
  const path = lockPathFor(pipeName);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 'wx' fails when the file exists, closing the check-then-create race.
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
    } catch {
      // held() is false for a missing file too; rmSync is a no-op then.
      if (held(path)) return null; // another live supervisor serves this pipe
      rmSync(path, { force: true }); // missing or stale: dead pid, or past STALE_MS
      continue;
    }
    const heartbeat = setInterval(() => {
      try {
        utimesSync(path, new Date(), new Date());
      } catch {
        // File gone (cleaned up elsewhere); release is a no-op anyway.
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();
    return {
      release: (): void => {
        clearInterval(heartbeat);
        rmSync(path, { force: true });
      },
    };
  }
  return null;
};
