// Only one Supervisor may serve a pipe name. On Windows several servers can
// listen on the same named pipe (multi-instance), so `listen()` alone cannot
// detect a duplicate; a pid lock file per pipe name enforces the singleton.
//
// The lock record carries the holder's code fingerprint (a hash of `src/`).
// A start whose fingerprint matches the holder's exits — the singleton guarantee.
// A start with a DIFFERENT fingerprint means the holder survived a code update
// (the Supervisor outlives MCP reloads): the fresh start replaces it — polite
// `shutdown` first, force-kill as the last resort. Without this, a reload keeps
// serving outdated logic behind the same pipe.
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { requestPipe } from './ipc.ts';
import { sleep } from './util.ts';

// A lock older than this is stale even if its pid is alive: a hard kill leaves
// the file behind, and the pid may have been reused by an unrelated process.
const STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const TAKEOVER_MAX_MS = 4_000;
const TAKEOVER_POLL_MS = 100;

export interface SupervisorLock {
  release(): void;
  // True when this start took the lock over from a holder running other code
  // (ADR-0005); the entry point then skips its duplicate-pipe guard.
  replaced: boolean;
}

export const lockPathFor = (pipeName: string): string =>
  join(tmpdir(), 'freebuff-supervisor-locks', createHash('sha1').update(pipeName).digest('hex') + '.lock');

interface LockHolder {
  pid: number;
  fingerprint: string;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readHolder = (path: string): LockHolder | null => {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    // Legacy records were a bare pid: a holder without a fingerprint predates code
    // identity, so its empty fingerprint always counts as "different code".
    const parsed: unknown = raw.startsWith('{') ? JSON.parse(raw) : { pid: Number(raw), fingerprint: '' };
    const pid = Number((parsed as LockHolder).pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, fingerprint: String((parsed as LockHolder).fingerprint ?? '') };
  } catch {
    return null;
  }
};

let fingerprintCache: string | null = null;

/** Content hash of the supervisor's own source tree: changes whenever the code does.
 *  `FREEBUFF_SUPERVISOR_FINGERPRINT` overrides it, for tests that need two code
 *  generations side by side. */
export const supervisorFingerprint = (): string => {
  if (process.env.FREEBUFF_SUPERVISOR_FINGERPRINT !== undefined) return process.env.FREEBUFF_SUPERVISOR_FINGERPRINT;
  if (fingerprintCache !== null) return fingerprintCache;
  const hash = createHash('sha1');
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.ts')) {
        hash.update(`${prefix}${entry.name}`);
        hash.update(readFileSync(join(dir, entry.name)));
      }
    }
  };
  walk(dirname(fileURLToPath(import.meta.url)), '');
  fingerprintCache = hash.digest('hex').slice(0, 16);
  return fingerprintCache;
};

// The holder runs different code: ask it to stop (its own shutdown stops the Instance
// cleanly and frees the Hour session bookkeeping), then insist if it will not.
const replaceHolder = async (pipeName: string, path: string, holder: LockHolder, fingerprint: string): Promise<SupervisorLock> => {
  await requestPipe(pipeName, { op: 'shutdown' }, SHUTDOWN_TIMEOUT_MS).catch(() => {});
  const deadline = Date.now() + TAKEOVER_MAX_MS;
  while (Date.now() < deadline) {
    const current = readHolder(path);
    if (current === null || current.pid !== holder.pid || !pidAlive(holder.pid)) break;
    await sleep(TAKEOVER_POLL_MS);
  }
  if (pidAlive(holder.pid)) {
    try {
      process.kill(holder.pid);
    } catch {
      // Already gone; the rm below finishes the takeover either way.
    }
  }
  rmSync(path, { force: true });
  return claim(path, fingerprint, true);
};

/** Write our record and start the heartbeat; the caller owns the pipe from here. */
const claim = (path: string, fingerprint: string, replaced: boolean): SupervisorLock => {
  const fd = openSync(path, 'wx');
  writeSync(fd, JSON.stringify({ pid: process.pid, fingerprint } satisfies LockHolder));
  closeSync(fd);
  const heartbeat = setInterval(() => {
    try {
      utimesSync(path, new Date(), new Date());
    } catch {
      // File gone (cleaned up elsewhere); release is a no-op anyway.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return {
    replaced,
    release: (): void => {
      clearInterval(heartbeat);
      rmSync(path, { force: true });
    },
  };
};

export const acquireSupervisorLock = async (pipeName: string, fingerprint = supervisorFingerprint()): Promise<SupervisorLock | null> => {
  const path = lockPathFor(pipeName);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 'wx' fails when the file exists, closing the check-then-create race.
      return claim(path, fingerprint, false);
    } catch {
      const holder = readHolder(path);
      const stale = holder !== null && Date.now() - statSync(path).mtimeMs > STALE_MS;
      // missing file, dead pid, or past STALE_MS: nothing is serving this pipe
      if (holder === null || !pidAlive(holder.pid) || stale) {
        rmSync(path, { force: true });
        continue;
      }
      if (holder.fingerprint === fingerprint) return null; // another live supervisor, same code
      if (holder.pid === process.pid) {
        rmSync(path, { force: true }); // our own leftover record with other code (tests); reclaim it
        continue;
      }
      return await replaceHolder(pipeName, path, holder, fingerprint); // stale code: replace it
    }
  }
  return null;
};
