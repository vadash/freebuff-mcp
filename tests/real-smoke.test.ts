import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODELS } from '../src/config.ts';
import { requestPipe, sleep, waitForPipe } from '../src/ipc.ts';
import { detectTurnEnd, newestChatDir, projectKey, type ChatDirSnapshot } from '../src/protocol/chatStore.ts';
import { CHATS_DIRNAME, LOG_FILENAME, PROJECTS_DIRNAME } from '../src/protocol/markers.ts';
import { defaultDriverOptions } from '../src/supervisor.ts';
import { expectExit, makeDirs, pollStatus, startSupervisor, uniquePipe, type SupervisorProcess } from './helpers/harness.ts';

const gateOpen = process.env.FREEBUFF_REAL_SMOKE === '1';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const headSlug = DEFAULT_MODELS[0]!;
const trivialPrompt = 'Reply with exactly one word and nothing else: ping';
const runTimeoutMs = 480_000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const livePid = (configDir: string): number => {
  const ownerPath = join(configDir, 'freebuff-instance-owner.json');
  try {
    const raw: unknown = JSON.parse(readFileSync(ownerPath, 'utf8').trim());
    if (typeof raw === 'object' && raw !== null && 'pid' in raw && typeof raw.pid === 'number') return raw.pid;
  } catch {
    // fall through to the legacy lock
  }
  return Number.parseInt(readFileSync(join(configDir, 'freebuff.lock'), 'utf8').trim(), 10);
};

const chatStoreAnswer = (configDir: string, cwd: string): string => {
  const root = join(configDir, PROJECTS_DIRNAME, projectKey(cwd, resolve(cwd)), CHATS_DIRNAME);
  const snaps: ChatDirSnapshot[] = readdirSync(root).flatMap((dirName) => {
    try {
      const log = statSync(join(root, dirName, LOG_FILENAME));
      return [{ dirName, mtimeMs: log.mtimeMs, logBytes: log.size, logText: readFileSync(join(root, dirName, LOG_FILENAME), 'utf8') }];
    } catch {
      return [];
    }
  });
  const ordered = [...snaps].sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const snap of ordered) {
    const turn = detectTurnEnd([snap], { dirName: snap.dirName, logBytes: 0 });
    if (turn.answer !== null) return turn.answer;
  }
  throw new Error(`no chat log under ${root} holds a fullResponse yet`);
};

describe.skipIf(!gateOpen)('real freebuff smoke (set FREEBUFF_REAL_SMOKE=1 to run)', () => {
  let proc: SupervisorProcess | null = null;
  const pipeName = uniquePipe('real');
  const configDir = defaultDriverOptions().configDir;

  afterEach(async () => {
    if (proc) {
      await requestPipe(pipeName, { op: 'shutdown' }).catch(() => {});
      await expectExit(proc);
      proc = null;
    }
  });

  it('binds the repo, runs one trivial task matching the chat store, parks, and respawns after a driver kill', async () => {
    proc = startSupervisor({ pipeName, mode: 'happy', realDriver: true, ...makeDirs() });
    await waitForPipe(pipeName, 60_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: repoRoot })).ok).toBe(true);

    const done = await requestPipe<{ ok: boolean; answer?: string; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: repoRoot, prompt: trivialPrompt },
      runTimeoutMs,
    );
    expect(done.ok, done.error).toBe(true);
    expect(done.answer).toBe(chatStoreAnswer(configDir, repoRoot));

    const parked = await pollStatus(pipeName, { state: 'parked', queueDepth: 0 });
    expect(parked.activeModel, `live service rejected policy head ${headSlug}`).toBe(headSlug);

    const firstPid = livePid(configDir);
    process.kill(firstPid, 'SIGKILL');
    const goneDeadline = Date.now() + 10_000;
    while (pidAlive(firstPid) && Date.now() < goneDeadline) await sleep(100);
    expect(pidAlive(firstPid), `freebuff process ${firstPid} survived the kill`).toBe(false);

    const respawned = await requestPipe<{ ok: boolean; answer?: string; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: repoRoot, prompt: trivialPrompt },
      runTimeoutMs,
    );
    expect(respawned.ok, respawned.error).toBe(true);
    await pollStatus(pipeName, { state: 'parked', activeModel: headSlug, queueDepth: 0 });
    const secondPid = livePid(configDir);
    expect(secondPid).not.toBe(firstPid);
    expect(pidAlive(secondPid), `respawned freebuff process ${secondPid} is not alive`).toBe(true);
  }, 1_200_000);
});
