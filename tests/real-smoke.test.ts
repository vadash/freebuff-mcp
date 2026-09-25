import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import { CHATS_DIRNAME, LOGIN_REQUIRED, LOG_FILENAME, PROJECTS_DIRNAME, READY_PROMPT, mentionsSingleInstance } from '../src/protocol/markers.ts';
import { classifyScreen } from '../src/protocol/screen.ts';
import { flatDump, RealCli, realChatsRoot, snapshotChats } from './helpers/capture.ts';
import { expectExit, makeDirs, pollStatus, startSupervisor, uniquePipe, type SupervisorProcess } from './helpers/harness.ts';

const gateOpen = process.env.FREEBUFF_REAL_SMOKE === '1';
const captureRequested = process.env.FREEBUFF_CAPTURE === '1';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const screenFixturesDir = fileURLToPath(new URL('./fixtures/screen/', import.meta.url));
const captureCwd = join(repoRoot, '.probe', 'capture');
const captureRawDir = join(captureCwd, 'raw');
// Session expiry costs a real hour of wall clock; the expiring countdown shows earlier.
const EXPIRY_WAIT_MS = 55 * 60_000;
const COUNTDOWN_LINE = /\d+(?:m|h) left|\d+:\d\d left/;
// ADR-0001 #6: first affordable deepseek, else first glm. The 2026-09 service update
// shrank the picker to a single GLM 5.3 Flash row, so the rule lands on it.
const expectedModel = 'GLM 5.3 Flash';
const trivialPrompt = 'Reply with exactly one word and nothing else: ping';
// Issue #18: a ~40 KB multi-line prompt, under the Big payload threshold, so it goes in
// as one bracketed paste; the Chat store must keep it intact (the 2026-09 CLI prefixes a
// `[Pasted Text]` label on bigger pastes, so the ack matches the prompt as tail).
const bigPrompt = [
  'The numbered lines below are filler. Do not read files or run tools.',
  ...Array.from({ length: 560 }, (_, i) => `${String(i + 1).padStart(4, '0')} filler line for the bracketed-paste smoke, ignore it entirely.`),
  'Reply with exactly one word and nothing else: pong',
].join('\n');
const runTimeoutMs = 120_000;

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

  it('binds the repo, runs one trivial task matching the chat store, pastes a ~40 KB prompt intact, idles at ready, and respawns after a driver kill', async () => {
    proc = startSupervisor({ pipeName, mode: 'happy', realDriver: true, ...makeDirs() });
    await waitForPipe(pipeName, 30_000);
    expect((await requestPipe<{ ok: boolean }>(pipeName, { op: 'bind', dir: repoRoot })).ok).toBe(true);

    const done = await requestPipe<{ ok: boolean; answer?: string; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: repoRoot, prompt: trivialPrompt },
      runTimeoutMs,
    );
    expect(done.ok, done.error).toBe(true);
    expect(done.answer).toBe(chatStoreAnswer(configDir, repoRoot));

    const ready = await pollStatus(pipeName, { state: 'ready', queueDepth: 0 });
    expect(ready.activeModel, `live service picked a model other than ${expectedModel}`).toBe(expectedModel);

    const big = await requestPipe<{ ok: boolean; answer?: string; error?: string }>(
      pipeName,
      { op: 'run_prompt', dir: repoRoot, prompt: bigPrompt },
      runTimeoutMs,
    );
    expect(big.ok, big.error).toBe(true);
    expect(chatStoreHoldsPrompt(configDir, repoRoot, bigPrompt), 'the Chat store does not hold the ~40 KB prompt intact').toBe(true);

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
    await pollStatus(pipeName, { state: 'ready', activeModel: expectedModel, queueDepth: 0 });
    const secondPid = await statusPid();
    expect(secondPid).not.toBe(firstPid);
    expect(pidAlive(secondPid), `respawned freebuff process ${secondPid} is not alive`).toBe(true);
  }, 300_000);

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

    try {
      // A killed Instance's Hour session persists, so the CLI either lands on the picker
      // (no Hour session) or straight in the resumed ready box (Hour session still ticking).
      await cli.waitScreen(
        'picker or resumed ready box',
        (t) => classifyScreen(t).picker !== null || (t.includes(READY_PROMPT) && COUNTDOWN_LINE.test(t)) || t.includes(LOGIN_REQUIRED),
        180_000,
      );
      if (cli.text().includes(LOGIN_REQUIRED)) throw new Error('freebuff is not logged in; log in and rerun the capture');
      const resumed = classifyScreen(cli.text()).picker === null;

      if (!resumed) {
        const picker = cli.text();
        if (!/\d+ Freebucks\/hr/.test(picker) || !/\d+\/\d+ Freebucks daily/.test(picker)) {
          throw new Error(`picker is missing price/balance wording; last screen:\n${flatDump(picker)}`);
        }
        save('picker-expanded');

        // Ready box with the Countdown. Navigate to a zero-cost row before pressing Enter:
        // the cursor rests on the remembered model, which a previous manual session may
        // have left on the paid DeepSeek row. A paid pick aborts hard.
        const cursorRow = (text: string): string => text.split('\n').find((line) => line.includes('›')) ?? '';
        for (let presses = 0; presses < 5 && /deepseek/i.test(cursorRow(cli.text())); presses++) {
          cli.type('\x1b[A');
          await sleep(400);
        }
        const picked = cursorRow(cli.text());
        if (!/glm|mimo|solar/i.test(picked)) {
          throw new Error(`picker cursor on unexpected row ("${picked.trim()}"); refusing to spend Freebucks`);
        }
        cli.type('\r');
        const statusScreen = await cli.waitScreen('session status line', (t) => COUNTDOWN_LINE.test(t), 180_000);
        const modelLine = statusScreen.split('\n').find((line) => COUNTDOWN_LINE.test(line)) ?? '';
        if (/deepseek/i.test(modelLine)) {
          throw new Error(`picker cursor sat on a paid model ("${modelLine.trim()}"); refusing to spend Freebucks`);
        }
        await cli.waitScreen('ready input box', (t) => t.includes(READY_PROMPT), 120_000);
      }

      // Single-instance dialog: only an Instance holding an Hour session owns the lock,
      // so the second spawn must happen once the session runs, not at the picker.
      const second = new RealCli(captureCwd);
      try {
        await second.waitScreen('single-instance dialog', (t) => mentionsSingleInstance(t), 120_000);
        second.saveFixture(screenFixturesDir, captureRawDir, 'single-instance');
      } catch (error) {
        console.warn(`[capture] single-instance skipped: ${firstErrorLine(error)}`);
      } finally {
        second.kill();
      }

      await runTurn(trivialPrompt);
      await cli.waitScreen('ready box with countdown', (t) => t.includes(READY_PROMPT) && COUNTDOWN_LINE.test(t) && !t.includes('working'), 60_000);
      save('ready');

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

      // The expiring countdown (mm:ss format) and the Continue screen cost a real hour.
      try {
        await cli.waitScreen('expiring countdown', (t) => /\d+:\d\d left/.test(t), EXPIRY_WAIT_MS);
        save('countdown-expiring');
      } catch (error) {
        console.warn(`[capture] countdown-expiring skipped: ${firstErrorLine(error)}`);
      }
      await cli.waitScreen('continue screen', (t) => t.includes('Session ended') && t.includes('Press Enter to continue'), 20 * 60_000);
      save('continue');
    } finally {
      // Never press Enter on the Continue screen: that would start a fresh Hour session.
      cli.kill();
    }
  }, 5_400_000);

  // The low-Freebucks screen needs a naturally spent-down daily balance (0/25 or 0/40;
  // billing is anti-churn, so sessions ended early deduct nothing and draining
  // programmatically is impossible). This opt-in variant (FREEBUFF_LOW_CAPTURE=1) only
  // DETECTS: it reaches the picker and captures it only when the parsed balance cannot
  // cover the cheapest paid model; otherwise it warns and writes nothing. The maintainer
  // runs it on a spent-down day.
  it.skipIf(!captureRequested || process.env.FREEBUFF_LOW_CAPTURE !== '1')('captures the low-Freebucks screen (set FREEBUFF_LOW_CAPTURE=1)', async () => {
    mkdirSync(captureCwd, { recursive: true });
    const cli = new RealCli(captureCwd);
    cli.startUnknownWatch(join(captureCwd, 'unknown'));
    const DEEPSEEK_PRICE = 5;
    const balanceLeft = (text: string): number | null => {
      const match = /(\d+)\/\d+ Freebucks daily/.exec(text);
      return match === null ? null : Number(match[1]);
    };
    const navigateToDeepSeek = async (): Promise<boolean> => {
      for (let presses = 0; presses < 8 && !/›.*deepseek/i.test(cli.text()); presses++) {
        if (presses === 2) cli.type('v'); // expand a collapsed picker; harmless when expanded
        cli.type('\x1b[B');
        await sleep(500);
        await cli.flush();
      }
      return /›.*deepseek/i.test(cli.text());
    };
    const screenDump = (): string => flatDump(cli.text());
    const inReadyBox = (t: string): boolean => t.includes(READY_PROMPT) && COUNTDOWN_LINE.test(t);
    try {
      // Landing screens, in the wild: picker, login gate, Continue screen (spent session),
      // single-instance dialog (stale lock), or the resumed ready box of a session that is
      // still ticking (Take over after a killed instance resumes it). Leaves the CLI at
      // the picker, ending any live Hour session on the way via the End session button.
      const toPicker = async (): Promise<void> => {
        await cli.waitScreen(
          'picker, resumed session, dialog, or continue screen',
          (t) => classifyScreen(t).picker !== null || t.includes(LOGIN_REQUIRED) || t.includes('Press Enter to continue') || mentionsSingleInstance(t) || inReadyBox(t),
          180_000,
        );
        if (cli.text().includes(LOGIN_REQUIRED)) throw new Error('freebuff is not logged in; log in and rerun the capture');
        if (mentionsSingleInstance(cli.text())) {
          await recoverStaleLockDialog(cli, 'spawn');
          await toPicker();
        } else if (cli.text().includes('Press Enter to continue')) {
          cli.type('\x1b');
          await cli.waitScreen('model picker after Esc', (t) => classifyScreen(t).picker !== null, 30_000);
        } else if (inReadyBox(cli.text())) {
          if (!cli.clickText('End session')) throw new Error('live Hour session but no End session button on screen');
          await cli.waitScreen('model picker after End session', (t) => classifyScreen(t).picker !== null, 60_000);
        }
      };
      await toPicker();
      await sleep(1_000);
      await cli.flush();
      const balance = balanceLeft(cli.text());
      if (balance === null) throw new Error(`could not parse the Freebucks balance; last screen:\n${screenDump()}`);
      if (balance >= DEEPSEEK_PRICE) {
        console.warn(`[capture] balance is ${balance}/day, still covering the ${DEEPSEEK_PRICE}-Freebucks model — the low-Freebucks screen needs a spent-down day (0/25 or 0/40); nothing written`);
        return;
      }
      cli.saveFixture(screenFixturesDir, captureRawDir, 'low-freebucks');
      // The TUI may hide or disable the unaffordable row instead of refusing the pick;
      // try the pick only if the row is still there, and keep whatever renders.
      if (await navigateToDeepSeek()) {
        const beforePick = cli.text();
        cli.type('\r');
        try {
          await cli.waitScreen('low-freebucks refusal', (t) => t !== beforePick, 45_000);
          await sleep(2_000);
          await cli.flush();
        } catch (error) {
          console.warn(`[capture] refusal screen unchanged: ${firstErrorLine(error)}`);
        }
        cli.saveFixture(screenFixturesDir, captureRawDir, 'low-freebucks-refused');
      } else {
        console.warn('[capture] DeepSeek row not selectable at exhausted balance; the picker fixture documents the hiding');
      }
    } finally {
      cli.kill();
    }
  }, 600_000);
});
