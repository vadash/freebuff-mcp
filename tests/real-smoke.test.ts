import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { requestPipe, waitForPipe } from '../src/ipc.ts';
import { sleep } from '../src/util.ts';
import { defaultDriverOptions } from '../src/driver.ts';
import {
  detectTurnEnd,
  hasLineSince,
  lineMentionsPrompt,
  newestChatDir,
  projectKey,
  type TurnBaseline,
} from '../src/protocol/chatStore.ts';
import { CHATS_DIRNAME, LOGIN_REQUIRED, PROJECTS_DIRNAME, READY_PROMPT, mentionsSingleInstance } from '../src/protocol/markers.ts';
import { workspaceDirFor } from '../src/workspace.ts';
import { captureFixturesDir, RealCli, realChatsRoot, snapshotChats } from './helpers/capture.ts';
import { expectExit, makeDirs, pollStatus, startSupervisor, uniquePipe, type SupervisorProcess } from './helpers/harness.ts';

const gateOpen = process.env.FREEBUFF_REAL_SMOKE === '1';
const captureRequested = process.env.FREEBUFF_CAPTURE === '1';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const captureCwd = join(repoRoot, '.probe', 'capture');
const captureRawDir = join(captureCwd, 'raw');
// Session expiry costs a real hour of wall clock. The mm:ss countdown shows only in
// the last 5 minutes (0.1.0 CLI: `<5min` branch of the formatter), so the wait must
// straddle the whole hour with margin on both sides.
const EXPIRY_WAIT_MS = 65 * 60_000;
const COUNTDOWN_LINE = /\d+(?:m|h) left|\d+:\d\d left/;
// ADR-0004: the model is whatever the live CLI remembers, never chosen by the
// supervisor; the smoke asserts only that the footer model is reported.
const trivialPrompt = 'Reply with exactly one word and nothing else: ping';
// Issue #18: a ~40 KB multi-line prompt, under the Big payload threshold, so it goes in
// as one bracketed paste; the Chat store must keep it intact (the 2026-09 CLI prefixes a
// `[Pasted Text]` label on bigger pastes, so the ack matches the prompt as tail).
const bigPrompt = [
  'The numbered lines below are filler. Do not read files or run tools.',
  ...Array.from({ length: 560 }, (_, i) => `${String(i + 1).padStart(4, '0')} filler line for the bracketed-paste smoke, ignore it entirely.`),
  'Reply with exactly one word and nothing else: pong',
].join('\n');
// A trivial Turn normally takes well under a minute; the pipe deadline only binds when
// the service is slow (the 2026-09-27 window needed >2 min for one word).
const runTimeoutMs = 300_000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const firstErrorLine = (error: unknown): string => (error instanceof Error ? error.message.split('\n')[0] : String(error));

// Resolves the single-instance dialog the real CLI raises after a killed instance
// (or a live second one). Takes over only when no provably live local holder exists —
// a live holder is a real second instance, which the capture must not steal.
const recoverStaleLockDialog = async (cli: RealCli, why: string): Promise<void> => {
  // 0.0.198+ writes no pid record; refuse only a provably live local holder.
  const ownerPath = join(defaultDriverOptions().configDir, 'freebuff-instance-owner.json');
  let lockPid: unknown = null;
  try {
    lockPid = JSON.parse(readFileSync(ownerPath, 'utf8').trim())?.pid;
  } catch {
    // no owner record: nothing to verify, but the dialog is up — take over
  }
  if (Number.isInteger(lockPid) && pidAlive(lockPid as number)) {
    throw new Error(`single-instance dialog at ${why} with a live lock holder (pid ${String(lockPid)}); refusing to take over`);
  }
  console.warn(`[capture] single-instance dialog (stale holder ${String(lockPid)}); taking over at ${why}`);
  cli.type('\r');
};

const chatStoreAnswer = (configDir: string, dir: string): string => {
  const root = join(configDir, PROJECTS_DIRNAME, projectKey(dir), CHATS_DIRNAME);
  const ordered = [...snapshotChats(root)].sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const snap of ordered) {
    const turn = detectTurnEnd([snap], { dirName: snap.dirName, logBytes: 0 });
    if (turn.answer !== null) return turn.answer;
  }
  throw new Error(`no chat log under ${root} holds a fullResponse yet`);
};

const chatStoreHoldsPrompt = (configDir: string, dir: string, prompt: string): boolean =>
  snapshotChats(join(configDir, PROJECTS_DIRNAME, projectKey(dir), CHATS_DIRNAME)).some((snap) =>
    hasLineSince(snap, 0, (json) => lineMentionsPrompt(json, prompt)),
  );

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

  it('runs one trivial task against the repo matching the chat store, pastes a ~40 KB prompt intact, idles at ready, and respawns after a driver kill', async () => {
    proc = startSupervisor({ pipeName, mode: 'happy', realDriver: true, ...makeDirs() });
    await waitForPipe(pipeName, 30_000);
    // Chats are keyed by the workspace the Instance runs in, not the caller's repo.
    const chatDir = workspaceDirFor(pipeName);

    const done = await requestPipe<{ ok: boolean; answer?: string; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: repoRoot, prompt: trivialPrompt },
      runTimeoutMs,
    );
    expect(done.ok, done.error).toBe(true);
    expect(done.answer).toBe(chatStoreAnswer(configDir, chatDir));

    const ready = await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
    expect(ready.activeModel, 'the footer model was not reported at ready').toEqual(expect.any(String));

    const big = await requestPipe<{ ok: boolean; answer?: string; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: repoRoot, prompt: bigPrompt },
      runTimeoutMs,
    );
    expect(big.ok, big.error).toBe(true);
    expect(chatStoreHoldsPrompt(configDir, chatDir, bigPrompt), 'the Chat store does not hold the ~40 KB prompt intact').toBe(true);

    // The 2026-09 CLI no longer writes its pid to disk; the status op reports the pid
    // the supervisor's own PTY holds.
    const statusPid = async (): Promise<number> =>
      Number((await requestPipe<{ instancePid: number | null }>(pipeName, { op: 'status' })).instancePid);
    const firstPid = await statusPid();
    process.kill(firstPid, 'SIGKILL');
    const goneDeadline = Date.now() + 10_000;
    while (pidAlive(firstPid) && Date.now() < goneDeadline) await sleep(100);
    expect(pidAlive(firstPid), `freebuff process ${firstPid} survived the kill`).toBe(false);
    // The pty exit event lands after the OS-level death; respawning before the driver
    // observes it hands the new task the dying Instance.
    const observedDeadline = Date.now() + 10_000;
    while ((await statusPid()) === firstPid && Date.now() < observedDeadline) await sleep(100);

    // Above the supervisor's own 120 s task deadline, so a watchdog verdict is
    // delivered as a reply instead of racing the pipe timeout.
    const respawned = await requestPipe<{ ok: boolean; answer?: string; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: repoRoot, prompt: trivialPrompt },
      150_000,
    );
    expect(respawned.ok, respawned.error).toBe(true);
    await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
    const secondPid = await statusPid();
    expect(secondPid).not.toBe(firstPid);
    expect(pidAlive(secondPid), `respawned freebuff process ${secondPid} is not alive`).toBe(true);
  }, 600_000);

  it.skipIf(!captureRequested)('captures the real protocol screens as fixtures (set FREEBUFF_CAPTURE=1)', async () => {
    mkdirSync(captureCwd, { recursive: true });
    const cli = new RealCli(captureCwd);
    cli.startUnknownWatch(join(captureCwd, 'unknown'));
    const save = (name: string): string => cli.saveFixture(screenFixturesDir, captureRawDir, name);
    const chatsRoot = realChatsRoot(captureCwd);
    const newestBaseline = (): TurnBaseline => {
      const newest = newestChatDir(snapshotChats(chatsRoot));
      return newest ? { dirName: newest.dirName, logBytes: newest.logBytes } : { dirName: '', logBytes: 0 };
    };
    const ackReceived = (baseline: TurnBaseline, prompt: string): boolean =>
      snapshotChats(chatsRoot).some((snap) =>
        hasLineSince(snap, snap.dirName === baseline.dirName ? baseline.logBytes : 0, (json) => lineMentionsPrompt(json, prompt)),
      );
    // Submits one prompt and waits for its Turn to finish, using the chat store exactly
    // like the driver; retypes once if the TUI swallowed the first submission.
    const runTurn = async (prompt: string): Promise<void> => {
      const baseline = newestBaseline();
      cli.type(prompt);
      await sleep(150);
      cli.type('\r');
      const ackDeadline = Date.now() + 30_000;
      while (!ackReceived(baseline, prompt) && Date.now() < ackDeadline) await sleep(250);
      if (!ackReceived(baseline, prompt)) {
        cli.type(prompt);
        await sleep(150);
        cli.type('\r');
      }
      const deadline = Date.now() + 600_000;
      while (!detectTurnEnd(snapshotChats(chatsRoot), baseline).done) {
        if (Date.now() > deadline) throw new Error(`turn did not finish within 10 min: ${prompt}`);
        await sleep(1_000);
      }
    };

    // Issue #32: captures write into the running CLI version's own corpus folder,
    // resolved from the real profile's metadata — never a hardcoded version.
    const screenFixturesDir = captureFixturesDir(configDir);
    try {
      // Landing screens: the Welcome screen (no Hour session), a resumed ready box (Hour
      // session still ticking after a kill), the login gate, or the Session-in-use
      // dialog a stale claim raises.
      await cli.waitScreen(
        'welcome, resumed ready box, login gate, or Session-in-use dialog',
        (t) => t.includes(READY_PROMPT) || t.includes(LOGIN_REQUIRED) || mentionsSingleInstance(t),
        180_000,
      );
      if (cli.text().includes(LOGIN_REQUIRED)) throw new Error('freebuff is not logged in; log in and rerun the capture');
      if (mentionsSingleInstance(cli.text())) {
        await recoverStaleLockDialog(cli, 'spawn');
        await cli.waitScreen('welcome or resumed ready box', (t) => t.includes(READY_PROMPT), 120_000);
      }
      // The first message starts the Hour session, so the idle screen is the input box
      // without a Countdown. Name the fixture by which one showed.
      if (COUNTDOWN_LINE.test(cli.text())) {
        save('ready');
      } else {
        save('welcome');
      }

      // The first message starts the Hour session; capture the ready box with its
      // Countdown once the Turn ends.
      await runTurn(trivialPrompt);
      await cli.waitScreen('ready box with countdown', (t) => t.includes(READY_PROMPT) && COUNTDOWN_LINE.test(t) && !t.includes('working'), 60_000);
      save('ready');

      // No concurrent-second-spawn probe: from 0.1.0 a second spawn takes the Hour
      // session over silently (no Session-in-use dialog), so the probe only demolished
      // the session this run is waiting to see expire. The dialog fixtures stay from
      // the 0.0.193/0.0.198 corpora.

      // Error screen: an unknown slash command is a deterministic CLI-level error, unlike
      // a failing shell command, which the model tends to neutralize and render as success.
      const beforeError = cli.text();
      cli.type('/definitely-not-a-freebuff-command');
      await sleep(150);
      cli.type('\r');
      await cli.waitScreen('error rendering', (t) => t !== beforeError, 60_000);
      await sleep(3_000);
      await cli.flush();
      save('error');

      // The expiring countdown (mm:ss format, last 5 minutes of the hour) and the
      // post-expiry look cost a real hour.
      try {
        await cli.waitScreen('expiring countdown', (t) => /\d+:\d\d left/.test(t), EXPIRY_WAIT_MS);
        save('countdown-expiring');
      } catch (error) {
        console.warn(`[capture] countdown-expiring skipped: ${firstErrorLine(error)}`);
      }
      // 0.1.0 expiry with remaining balance: the Countdown vanishes and the box reverts
      // to `Your first message starts the session` — no credits dialog (that one is the
      // out-of-credits claim check), no `Session ended`. The post-expiry look must
      // recognize as the Welcome screen, because the Supervisor submits the next task
      // straight into it.
      await cli.waitScreen(
        'post-expiry welcome',
        (t) => t.includes('Your first message starts the session') && !COUNTDOWN_LINE.test(t),
        30 * 60_000,
      );
      save('welcome-expired');
    } finally {
      cli.kill();
    }
  }, 6_000_000);

});
