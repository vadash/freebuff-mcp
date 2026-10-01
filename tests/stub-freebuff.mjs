// Protocol-faithful stub of the freebuff TUI for driver e2e tests. Deliberately
// a dependency-free .mjs: the marker strings and the projectKey hash below
// duplicate src/protocol/{markers,chatStore}.ts on purpose so the driver under
// test is the only side consuming the real modules. The Welcome screen and the
// session screen replay the real captured 0.1.0 fixtures verbatim
// (tests/fixtures/screen/), with the captured footer directory swapped for the
// stub's own cwd (FREEBUFF_STUB_CWD renders a foreign one, for dir_mismatch) and
// the env-controlled numbers substituted: FREEBUFF_STUB_COUNTDOWN_MIN and
// FREEBUFF_STUB_FREEBUCKS. FREEBUFF_STUB_SESSION_ALIVE=1 boots into the session
// screen of an unexpired Hour session instead of the Welcome screen. There is no
// model choice (ADR-0004): the footer names the model, and the `stub(<model>):`
// answer echo reports it. FREEBUFF_STUB_TURN_LINES (issue #17) is a JSON array,
// one entry per Turn, of the lines that Turn prints to the Screen mid-Turn before
// it ends normally. FREEBUFF_STUB_INPUT_LOG (issue #18) names a JSON-lines file
// recording each spawn, each bracketed paste and each submitted input line, so
// tests see exactly what the driver sent. Mode `no-answer` ends the first Turn
// without a fullResponse. Issue #34: FREEBUFF_STUB_HELD_LOG_MS makes the stub buffer
// its chat-store writes the way a held CLI flush does — a number releases them after
// that many ms, the value `exit` holds them until the process exits, so neither the
// Ack nor the Turn end ever lands. FREEBUFF_STUB_HOLDING_MS boots into the
// holding banner screen for that many ms; the banner swallows Enters, so
// input typed into it accumulates and is flushed as one merged line when it clears
// (a `/new` merged with the following paste renders as the CLI's
// `Command not found: "…"` store line). Mid-Turn the stub shows the working Screen:
// the ready layout plus the elapsed ticker (`working · 1s · ■ Esc`). Mode `unknown`
// (issue #21) boots into a screen matching
// no known class and repaints it with a ticking Countdown; an accepted Enter flips
// it to the Welcome screen (the Fallback Enter lands in the input box); the first
// FREEBUFF_STUB_UNKNOWN_IGNORE_ENTER Enters are swallowed so tests can observe
// the driver's fallback cadence, and every Enter lands in the input log.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CONNECTING = 'Connecting';
const TURN_END_MSG = 'Main prompt finished';
const MSG_KEY = 'msg';
const SHOULD_END_TURN_KEY = 'shouldEndTurn';
const FULL_RESPONSE_KEY = 'fullResponse';
const LOGIN_REQUIRED = 'Not authenticated';
const MODEL_FOOTER_HINT = '/model to change';
const BALANCE_LINE = /(\d+)\/(\d+) Freebucks remaining/;
const COUNTDOWN_LINE = /(?:\d+h(?:\s+\d+m)?|\d+m)\s+left|\d+:\d\d\s+left/;

const PASTE_START = '200~';
const PASTE_END = '201~';

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));
const out = (s) => process.stdout.write(s);
const CLEAR = '\x1b[2J\x1b[H';

const args = process.argv.slice(2);
const cwd = args[args.indexOf('--cwd') + 1];
// Issue #30: renders a foreign directory in the screen's dir line, so tests see the
// strict banner parse fail dir_mismatch (`FREEBUFF_STUB_CWD`).
const stubDir = process.env.FREEBUFF_STUB_CWD ?? cwd;
const mode = process.env.FREEBUFF_STUB_MODE ?? 'happy';
const configDir = process.env.FREEBUFF_CONFIG_DIR;

// Env controls (issue #11): Countdown minutes and Freebucks balance.
let countdownMin = Number(process.env.FREEBUFF_STUB_COUNTDOWN_MIN ?? 432);
const sessionAlive = process.env.FREEBUFF_STUB_SESSION_ALIVE === '1';
// Issue #30: renders the session usage line without its Countdown segment, so tests
// see the parse fallbacks for unknown time left (`FREEBUFF_STUB_NO_COUNTDOWN=1`).
const noCountdown = process.env.FREEBUFF_STUB_NO_COUNTDOWN === '1';
const turnLines = process.env.FREEBUFF_STUB_TURN_LINES ? JSON.parse(process.env.FREEBUFF_STUB_TURN_LINES) : [];
let turnCounter = 0;
// Issue #34: held chat-store flushes — a number delays every write, `exit` holds them
// until the process exits so the Ack and the Turn end never land.
const heldLogMs = process.env.FREEBUFF_STUB_HELD_LOG_MS ?? null;
const heldExit = [];
// Issue #34: the holding banner stays up this many ms after boot.
const holdingMs = Number(process.env.FREEBUFF_STUB_HOLDING_MS ?? 0);
const inputLog = process.env.FREEBUFF_STUB_INPUT_LOG ?? null;
const logInput = (entry) => {
  if (inputLog !== null) appendFileSync(inputLog, JSON.stringify(entry) + '\n');
};

const fixture = (name) => readFileSync(new URL(`./fixtures/screen/0.1.0/${name}`, import.meta.url), 'utf8');
// Default balance numbers come from the captured fixture, so a capture refresh cannot
// desync the stub's replayed screens from the harness's expected tail.
const fixtureBalance = (BALANCE_LINE.exec(fixture('welcome.ansi'))?.[0] ?? '25/25 Freebucks remaining').split(' ')[0];
const [balanceLeft, balanceDaily] = (process.env.FREEBUFF_STUB_FREEBUCKS ?? fixtureBalance).split('/').map(Number);
// Fixtures store the flattened screen with \n; the ConPTY on the other side of the
// driver needs \r\n, exactly like the real TUI's output.
const crlf = (text) => text.replace(/\n/g, '\r\n');

// Real Countdown wording: `7h 12m left`, `1h left`, `59m left`. Mode `drift` is the
// degraded screen mode (issue #31): the altered wording (`remaining`) misses the
// COUNTDOWN_REGEX Marker, so the session screen reads as degraded — `doctor` names
// the drifted Marker and the Supervisor's settle check records the Drift.
const LEFT = mode === 'drift' ? 'remaining' : 'left';
const countdownText = (min) => {
  const total = Math.max(0, Math.floor(min));
  if (total < 60) return `${total}m ${LEFT}`;
  const hours = Math.floor(total / 60);
  return total % 60 === 0 ? `${hours}h ${LEFT}` : `${hours}h ${total % 60}m ${LEFT}`;
};

// The captured screens with two substitutions: the footer directory segment becomes
// the stub's own cwd (the strict banner parse reads it), and the balance numbers
// become the env-controlled ones. The dir swap stays width-neutral — the Chat title
// tail absorbs the growth — because a footer past 160 cols wraps and scrolls the
// whole Screen up one row.
const swapFooterDir = (text) =>
  text
    .split('\n')
    .map((line) => {
      if (!line.includes(MODEL_FOOTER_HINT)) return line;
      const parts = line.split(' · ');
      if (parts.length < 2) return line;
      parts[1] = ` ${stubDir}`;
      let out = parts.join(' · ');
      const grow = out.length - line.length;
      if (grow > 0 && out.length > 160) {
        const last = parts.length - 1;
        parts[last] = parts[last].slice(0, Math.max(1, parts[last].length - grow));
        out = parts.join(' · ');
      }
      return out;
    })
    .join('\n');
const swapBalance = (text) => text.replace(BALANCE_LINE, `${balanceLeft}/${balanceDaily} Freebucks remaining`);

// ADR-0004: the Instance idles on the Welcome screen — first message starts the
// Hour session.
const welcomeBody = () => swapBalance(swapFooterDir(fixture('welcome.ansi').replace('\x1b[2J\x1b[H\n', '')));
const welcomeScreen = () => CLEAR + crlf(welcomeBody());

// The session screen: the same layout with `Session active` in the info box, the
// usage line carrying the Countdown, and the turn transcript above. The Countdown
// swap stays width-neutral — the slack comes out of the padding run before the
// End-session button on the same row — because a wider row wraps and scrolls the
// whole layout up one row (the real TUI overwrites the token in place).
const swapCountdown = (body) => {
  const at = body.search(COUNTDOWN_LINE);
  if (at === -1) return body;
  const want = noCountdown ? '' : countdownText(countdownMin);
  const token = COUNTDOWN_LINE.exec(body)[0];
  const button = body.indexOf('✕ End session', at);
  let runStart = button === -1 ? -1 : button;
  while (runStart > at && body[runStart - 1] === ' ') runStart -= 1;
  if (button === -1 || runStart === at) return body.slice(0, at) + want + body.slice(at + token.length);
  const delta = want.length - token.length;
  const keep = Math.max(1, button - runStart - delta);
  return body.slice(0, at) + want + body.slice(at + token.length, runStart) + ' '.repeat(keep) + body.slice(button);
};

// The session screen: the same layout with `Session active` in the info box, the
// usage line carrying the Countdown, and the turn transcript above.
const sessionBody = () => swapCountdown(swapBalance(swapFooterDir(fixture('ready.ansi').replace('\x1b[2J\x1b[H\n', ''))));
const readyScreen = () => CLEAR + crlf(sessionBody());

// Issue #34: one line inserted above the input box, where the real TUI renders the
// mid-Turn ticker and the holding banner.
const withLineAboveBox = (body, line) => {
  const lines = body.split('\n');
  // Appended after the input box rather than above it: the real TUI paints the line
  // above the box, but inserting mid-body shifts the box rows off the fixed screen
  // height and breaks the region geometry the signatures are tuned against. The
  // bottom-rows region still contains the line either way.
  const at = lines.findIndex((candidate) => candidate.startsWith('╭'));
  lines.splice(at === -1 ? lines.length : at, 0, line);
  return lines.join('\n');
};

// The mid-Turn working Screen: the session layout plus the real TUI's elapsed ticker
// (`working · 3s · ■ Esc`, negative/mid-turn-esc) above the input box — the second
// Ack signal (issue #34) when the CLI holds its chat-store flushes.
const workingScreen = () => CLEAR + crlf(withLineAboveBox(sessionBody(), ' working · 1s · ■ Esc'));

// The holding banner (issue #34): the boot screen plus the banner line above
// the input box, shown until the CLI rejoins. Enters typed into it are swallowed.
const HOLDING_BANNER_LINE = 'Freebuff session over; holding queued messages until rejoin';
const bannerScreen = () => CLEAR + crlf(withLineAboveBox(sessionAlive ? sessionBody() : welcomeBody(), ` ${HOLDING_BANNER_LINE}`));
const bootSettledScreen = () => (sessionAlive ? readyScreen() : welcomeScreen());

// 0.1.0 shows no Continue screen at plain expiry (the box just reverts to the Welcome
// wording); `Press Enter to continue` now belongs to the out-of-credits dialog, which
// this balance never reaches. The expire-mode tests replay the last generation's
// captured Continue fixture to keep the Enter-on-continue mechanism covered.
const continueScreen = () => CLEAR + crlf(fixture('../0.0.199/continue.ansi'));

// Degraded dialog frame (issue #31): the strong Session-in-use Marker present, the weak
// 'Take over' Marker removed, so recognition reads the dialog at level degraded and the
// settle loop must dump the frame even though the dialog branch never falls through to
// the ordinary dump site. The dialog wording is stable across CLI versions, so the
// 0.0.198 capture stays its source.
const driftDialogScreen = () =>
  CLEAR +
  crlf(
    fixture('../0.0.198/session-in-use.ansi')
      .split('\n')
      .filter((line) => !line.includes('Take over'))
      .join('\n'),
  );

// Issue #21: a frame matching no known class, with a ticking Countdown line so the
// driver's Freeze-key dedupe is exercised: repaints collapse to one dump file that
// still keeps the Countdown.
const UNKNOWN_TITLE = 'Quantum flux calibration panel';
const unknownScreen = () =>
  CLEAR + crlf([stubDir, '─'.repeat(60), `  ${UNKNOWN_TITLE}`, `  Sync window: ${countdownText(countdownMin)}`, '  Await further instructions.', '─'.repeat(60), ''].join('\n'));

// ADR-0004: no model choice — the footer names the model the CLI remembers, so the
// `stub(<model>):` answer echo reports the fixture's model.
const footerModelName = () => {
  const line = fixture('welcome.ansi').split('\n').find((candidate) => candidate.includes(MODEL_FOOTER_HINT)) ?? '';
  const bullet = line.indexOf('•');
  return ((bullet === -1 ? line : line.slice(0, bullet)).trim() || 'none');
};

const model = footerModelName();

const projectKey = basename(cwd);

// The real TUI holds a pid lock for its lifetime and leaves it behind on a crash;
// the supervisor claims stale locks via pid liveness before spawning.
writeFileSync(join(configDir, 'freebuff.lock'), String(process.pid));

// Opt-in: tests learn the pid of the process that spawned the Instance (the supervisor).
if (process.env.FREEBUFF_STUB_PARENT_PID_FILE) writeFileSync(process.env.FREEBUFF_STUB_PARENT_PID_FILE, String(process.ppid));
logInput({ event: 'spawn', pid: process.pid });

let phase = 'idle';
let pending = '';
// The Session-in-use dialog stands until an Enter (`Take over`) flips the stub to the
// Welcome screen, as the real dialog does.
let dialogStuck = mode === 'drift-dialog';
// Issue #23: the unknown screen stands until an accepted Enter flips the stub to the
// Welcome screen.
let unknownStuck = mode === 'unknown';
let unknownIgnore = Number(process.env.FREEBUFF_STUB_UNKNOWN_IGNORE_ENTER ?? 0);
let escapeState = 0;
let csi = '';
let pasting = false;
let pasted = '';
let chatCounter = 0;
let newChatRequested = false;
let lastLogPath = null;
let expireShown = false;

// Issue #34: every chat-store write of a Turn goes through here, so the held-flush
// behavior covers the Ack line, the Turn end and progress lines alike.
const storeWrite = (line) => {
  if (heldLogMs === null) {
    appendFileSync(lastLogPath, line);
  } else if (heldLogMs === 'exit') {
    heldExit.push([lastLogPath, line]);
  } else {
    const path = lastLogPath;
    setTimeout(() => appendFileSync(path, line), Number(heldLogMs));
  }
};
process.on('exit', () => {
  for (const [path, line] of heldExit) {
    try {
      appendFileSync(path, line);
    } catch {
      // The Workspace may already be gone at exit; the held lines are then unobservable.
    }
  }
});

// Issue #34: while the holding banner is up the TUI swallows Enters, so
// typed input accumulates in the input buffer and is flushed as ONE line when the
// banner clears — the merged-command incident.
let holding = false;
const endHolding = () => {
  if (pasting) {
    // Never split a bracketed paste mid-flight; retry just after it completes.
    setTimeout(endHolding, 50);
    return;
  }
  holding = false;
  out(bootSettledScreen());
  const merged = pending;
  pending = '';
  if (merged !== '') {
    logInput({ event: 'submit', text: merged });
    void submit(merged);
  }
};
const beginHolding = () => {
  holding = true;
  out(bannerScreen());
  setTimeout(endHolding, holdingMs);
};

const chatsRoot = () => join(configDir, 'projects', projectKey, 'chats');

const chatsExist = () => {
  try {
    return readdirSync(chatsRoot()).length > 0;
  } catch {
    return false;
  }
};

const submit = async (prompt) => {
  if (!prompt || mode === 'no-ack') return;
  if (prompt === '/end-session') {
    appendFileSync(join(configDir, 'end-session.log'), JSON.stringify({ [MSG_KEY]: 'end-session' }) + '\n');
    phase = 'idle';
    out(welcomeScreen());
    return;
  }
  if (prompt === '/new') {
    newChatRequested = true;
    return;
  }
  // Issue #34: a line that begins with /new but carries more is the holding banner's
  // merged flush; the real CLI renders it as its command-parse error and starts nothing
  // (error.ansi).
  if (prompt.startsWith('/new')) {
    const dir = join(chatsRoot(), `chat-${chatCounter++}`);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'log.jsonl'), JSON.stringify({ [MSG_KEY]: `Command not found: "${prompt}"` }) + '\n');
    return;
  }
  // The first message starts the Hour session: the screen flips to the working view.
  if (phase === 'idle') {
    phase = 'ready';
    out(workingScreen());
  }
  const dirName = newChatRequested ? `chat-new-${chatCounter++}` : `chat-${chatCounter++}`;
  newChatRequested = false;
  // Issue #16: only the first Turn misbehaves, so the next queued Task can complete.
  const crashThisTurn = mode === 'kill-mid-turn' && !chatsExist();
  const freezeThisTurn = mode === 'freeze' && !chatsExist();
  const chatterThisTurn = mode === 'chatty' && !chatsExist();
  const noAnswerThisTurn = mode === 'no-answer' && !chatsExist();
  const linesThisTurn = turnLines[turnCounter++] ?? [];
  const dir = join(chatsRoot(), dirName);
  mkdirSync(dir, { recursive: true });
  lastLogPath = join(dir, 'log.jsonl');
  const answer = `stub(${model}): ${prompt}`;
  await sleep(30 + Math.random() * 50);
  if (mode === 'slow') await sleep(Number(process.env.FREEBUFF_STUB_DELAY_MS ?? 5000));
  storeWrite(JSON.stringify({ [MSG_KEY]: prompt }) + '\n');
  if (crashThisTurn) {
    setTimeout(() => process.exit(9), 100);
    return;
  }
  // A freeze where only the Countdown keeps ticking on the Screen.
  if (freezeThisTurn) {
    for (;;) {
      await sleep(200);
      countdownMin = Math.max(1, countdownMin - 1);
      out(readyScreen());
    }
  }
  // A Turn that never ends but keeps writing to the Screen and the Chat store.
  if (chatterThisTurn) {
    for (let tick = 0; ; tick++) {
      await sleep(200);
      storeWrite(JSON.stringify({ [MSG_KEY]: `progress ${tick}` }) + '\n');
      out(`working ${tick}\r\n`);
    }
  }
  for (const line of linesThisTurn) out(`${line}\r\n`);
  await sleep(30 + Math.random() * 50);
  storeWrite(
    JSON.stringify({ type: 'end', role: 'agent', [SHOULD_END_TURN_KEY]: true, data: noAnswerThisTurn ? {} : { [FULL_RESPONSE_KEY]: answer } }) + '\n',
  );
  await sleep(30 + Math.random() * 50);
  storeWrite(JSON.stringify({ [MSG_KEY]: TURN_END_MSG }) + '\n');
  // The Turn is over: back to the ready input box. A held-flush CLI is mid-Turn on the
  // Screen too (issue #34), so the repaint waits for the same flush as the store lines.
  if (heldLogMs === null) out(readyScreen());
  else if (heldLogMs !== 'exit') setTimeout(() => out(readyScreen()), Number(heldLogMs));
  // Issue #11: the Hour session expiring shows the captured Continue screen; Enter
  // starts the next Hour session.
  if (mode === 'expire' && !expireShown) {
    expireShown = true;
    phase = 'continue';
    out(continueScreen());
  }
};

process.stdin.setEncoding('utf8');
// The real TUI reads raw keys; a cooked stdin lets the console host swallow control
// keys before this process ever sees them.
process.stdin.setRawMode(true);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    // Escape sequences (CSI): the bracketed-paste markers, between which every char is
    // literal text (Enter included).
    if (escapeState === 1) {
      escapeState = char === '[' ? 2 : 0;
      csi = '';
      continue;
    }
    if (escapeState === 2) {
      const code = char.charCodeAt(0);
      if (code < 0x40 || code > 0x7e) {
        csi += char;
        continue;
      }
      escapeState = 0;
      const sequence = csi + char;
      if (sequence === PASTE_START) {
        pasting = true;
        pasted = '';
      } else if (sequence === PASTE_END) {
        pasting = false;
        logInput({ event: 'paste', text: pasted });
      }
      continue;
    }
    if (char === '\x1b') {
      // Esc on the Continue screen returns to the Welcome screen.
      if (phase === 'continue' && !pasting) {
        phase = 'idle';
        out(welcomeScreen());
      } else {
        escapeState = 1;
      }
    } else if (pasting) {
      pending += char;
      pasted += char;
    } else if (char === '\r') {
      // Raw mode delivers Enter as CR; a stray LF must not count as a second Enter.
      if (holding) {
        // Issue #34: the holding banner swallows Enters; chars stay buffered and
        // flush as one merged line when the banner clears.
        continue;
      } else if (dialogStuck) {
        logInput({ event: 'enter' });
        dialogStuck = false;
        phase = 'idle';
        out(welcomeScreen());
      } else if (unknownStuck) {
        logInput({ event: 'enter' });
        if (unknownIgnore > 0) unknownIgnore -= 1;
        else {
          unknownStuck = false;
          phase = 'idle';
          out(welcomeScreen());
        }
      } else if (phase === 'continue') {
        // Enter on the Continue screen starts the next Hour session.
        logInput({ event: 'enter' });
        phase = 'ready';
        out(readyScreen());
      } else {
        // Enter on the Welcome screen's empty input box starts nothing. Only
        // screen-changing Enters are logged; the submit Enter is not one.
        const prompt = pending;
        pending = '';
        logInput({ event: 'submit', text: prompt });
        void submit(prompt);
      }
    } else if (char !== '\n') {
      pending += char;
    }
  }
});

await sleep(80);
out(CONNECTING + ' to agent...\r\n');
await sleep(80);
if (mode === 'drift-dialog') {
  // Static degraded dialog: every settle frame has one Freeze key, so the dump
  // collapses to a single file; Enters never clear it, so the Task times out.
  out(driftDialogScreen());
  for (;;) await sleep(1_000);
}
if (mode === 'unknown') {
  // No intermediate banner frame: the first stable screen is already the unknown one,
  // so a boot produces exactly one dump signature. Repaints tick the Countdown until
  // an accepted Enter flips the stub to the Welcome screen (issue #23); that screen is
  // the terminal state, so the normal boot below must not run for this mode.
  out(unknownScreen());
  while (unknownStuck) {
    await sleep(200);
    countdownMin = Math.max(1, countdownMin - 1);
    // Never repaint over the Welcome screen an Enter may just have produced.
    if (unknownStuck) out(unknownScreen());
  }
} else {
  // The degraded session screen is the drift mode's first stable frame: an
  // intermediate banner-only frame matches no signature, and a settle poll catching it
  // under load would dump a second file (issue #31; same rule as the unknown mode
  // above).
  if (mode !== 'drift') {
    out(CLEAR + stubDir + '\r\n');
    await sleep(80);
  }
  if (mode === 'needs-login') {
    out(LOGIN_REQUIRED + '\r\n');
    for (;;) await sleep(1_000);
  }
  // Issue #34: the boot lands in the holding banner; it clears into the
  // settled screen and flushes whatever was typed into it as one merged line.
  if (holdingMs > 0) {
    beginHolding();
  } else if (sessionAlive) {
    phase = 'ready';
    out(readyScreen());
  } else {
    phase = 'idle';
    out(welcomeScreen());
  }
}
