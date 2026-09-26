// Protocol-faithful stub of the freebuff TUI for driver e2e tests. Deliberately
// a dependency-free .mjs: the marker strings and the projectKey hash below
// duplicate src/protocol/{markers,chatStore}.ts on purpose so the driver under
// test is the only side consuming the real modules. The Model picker and the
// Continue screen replay the real captured fixtures verbatim
// (tests/fixtures/screen/README.md); FREEBUFF_STUB_COUNTDOWN_MIN,
// FREEBUFF_STUB_FREEBUCKS and FREEBUFF_STUB_PICKER override the numbers the
// protocol reads; FREEBUFF_STUB_SESSION_ALIVE=1 boots into the ready screen of
// an unexpired Hour session instead of the picker. The displayed model is
// keyboard-driven (issue #13): picker cursor keystrokes pick the entry whose
// name the ready status line and the `stub(<model>):` answer echo report.
// FREEBUFF_STUB_TURN_LINES (issue #17) is a JSON array, one entry per Turn, of the
// lines that Turn prints to the Screen mid-Turn before it ends normally.
// FREEBUFF_STUB_INPUT_LOG (issue #18) names a JSON-lines file recording each spawn,
// each bracketed paste and each submitted input line, so tests see exactly what the
// driver sent. Mode `no-answer` ends the first Turn without a fullResponse. Mode
// `unknown` (issue #21) boots into a screen matching no known class and repaints it
// with a ticking Countdown, for the driver's screen-dump tests. Enter flips it to the
// ready screen on the fixture-cursor model (issue #23, the accepted picker cost); the
// first FREEBUFF_STUB_UNKNOWN_IGNORE_ENTER Enters are swallowed so tests can observe
// the driver's fallback cadence, and every Enter lands in the input log.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const READY_PROMPT = 'Enter a coding task or / for commands';
const CONNECTING = 'Connecting';
const PICKER_TITLE = 'Start coding for free';
const TURN_END_MSG = 'Main prompt finished';
const MSG_KEY = 'msg';
const SHOULD_END_TURN_KEY = 'shouldEndTurn';
const FULL_RESPONSE_KEY = 'fullResponse';
const LOGIN_REQUIRED = 'Not authenticated';
const BALANCE_LINE = /FREE · \d+\/\d+ Freebucks daily/;

const PASTE_START = '200~';
const PASTE_END = '201~';

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));
const out = (s) => process.stdout.write(s);
const CLEAR = '\x1b[2J\x1b[H';

const args = process.argv.slice(2);
const cwd = args[args.indexOf('--cwd') + 1];
const mode = process.env.FREEBUFF_STUB_MODE ?? 'happy';
const configDir = process.env.FREEBUFF_CONFIG_DIR;
const version = process.env.FREEBUFF_STUB_VERSION ?? '0.0.186';

// Env controls (issue #11): Countdown minutes, Freebucks balance, picker entries and prices.
let countdownMin = Number(process.env.FREEBUFF_STUB_COUNTDOWN_MIN ?? 432);
const sessionAlive = process.env.FREEBUFF_STUB_SESSION_ALIVE === '1';
// Issue #30: renders the ready status line without its Countdown segment, so tests see
// the parse fallbacks for unknown time left (`FREEBUFF_STUB_NO_COUNTDOWN=1`).
const noCountdown = process.env.FREEBUFF_STUB_NO_COUNTDOWN === '1';
const pickerOverride = process.env.FREEBUFF_STUB_PICKER ? JSON.parse(process.env.FREEBUFF_STUB_PICKER) : null;
const turnLines = process.env.FREEBUFF_STUB_TURN_LINES ? JSON.parse(process.env.FREEBUFF_STUB_TURN_LINES) : [];
let turnCounter = 0;
const inputLog = process.env.FREEBUFF_STUB_INPUT_LOG ?? null;
const logInput = (entry) => {
  if (inputLog !== null) appendFileSync(inputLog, JSON.stringify(entry) + '\n');
};

const bannerLine = `freebuff v${version}`;

const fixture = (name) => readFileSync(new URL(`./fixtures/screen/0.0.199/${name}`, import.meta.url), 'utf8');
// Default balance numbers come from the captured fixture, so a capture refresh
// cannot desync the stub's replayed picker from the harness's expected tail.
const fixtureBalance = (BALANCE_LINE.exec(fixture('picker-expanded.ansi'))?.[0].match(/\d+\/\d+/) ?? ['20/25'])[0];
const [balanceLeft, balanceDaily] = (process.env.FREEBUFF_STUB_FREEBUCKS ?? fixtureBalance).split('/').map(Number);
// Fixtures store the flattened screen with \n; the ConPTY on the other side of the
// driver needs \r\n, exactly like the real TUI's output.
const crlf = (text) => text.replace(/\n/g, '\r\n');

// Real Countdown wording: `7h 12m left`, `1h left`, `59m left`. Mode `drift` is the
// degraded screen mode (issue #31): the altered wording (`remaining`) misses the
// COUNTDOWN_REGEX Marker, so the ready screen reads as degraded — `doctor` names the
// drifted Marker and the Supervisor's settle check records the Drift.
const LEFT = mode === 'drift' ? 'remaining' : 'left';
const countdownText = (min) => {
  const total = Math.max(0, Math.floor(min));
  if (total < 60) return `${total}m ${LEFT}`;
  const hours = Math.floor(total / 60);
  return total % 60 === 0 ? `${hours}h ${LEFT}` : `${hours}h ${total % 60}m ${LEFT}`;
};

// The captured picker with the balance numbers substituted and, when
// FREEBUFF_STUB_PICKER is set, the captured rows replaced by the given entries
// (same row shape: a name line, then a `<n> Freebucks/hr` price line). The stub's
// banner + directory header stays on top, as in v1, so the version probe keeps
// seeing `freebuff v<version>` while parked here.
const pickerScreen = () => {
  const lines = fixture('picker-expanded.ansi').replace('\x1b[2J\x1b[H\n', '').split('\n');
  const title = lines.findIndex((line) => line.includes(PICKER_TITLE));
  const balance = lines.findIndex((line) => BALANCE_LINE.test(line));
  let rows = lines;
  if (pickerOverride !== null && title !== -1 && balance !== -1) {
    const width = 75;
    const bar = (left, right) => left + '─'.repeat(width) + right;
    const cell = (inner) => `│${inner.padEnd(width)}│`;
    const priceRow = (price) => {
      const text = `${price} Freebucks/hr`;
      return cell(' '.repeat(Math.floor((width - text.length) / 2)) + text);
    };
    rows = [
      ...lines.slice(0, title + 1),
      '',
      ...pickerOverride.flatMap((entry, i) => [
        bar('┌', '┐'),
        cell(`   ${i === selection ? '›' : ' '} ${entry.name}    NEW`),
        priceRow(entry.price),
        bar('└', '┘'),
        '',
      ]),
      ...lines.slice(balance),
    ];
  }
  // The 0.0.198-era synthetic hint row is gone: the captured fixture renders the
  // `H · History` row itself, and the stub replays it verbatim.
  const body = rows.map((line) => line.replace(BALANCE_LINE, `FREE · ${balanceLeft}/${balanceDaily} Freebucks daily`));
  return CLEAR + crlf([bannerLine, cwd, ...body].join('\n'));
};

const continueScreen = () => CLEAR + crlf(fixture('continue.ansi'));

// Issue #21: a frame matching no known class (no picker, ready, Continue, session-in-use,
// login or connecting marker), with a ticking Countdown line so the driver's Freeze-key
// dedupe is exercised: repaints collapse to one dump file that still keeps the Countdown.
const UNKNOWN_TITLE = 'Quantum flux calibration panel';
const unknownScreen = () =>
  CLEAR + crlf([bannerLine, cwd, '─'.repeat(60), `  ${UNKNOWN_TITLE}`, `  Sync window: ${countdownText(countdownMin)}`, '  Await further instructions.', '─'.repeat(60), ''].join('\n'));

// Ready input box with the Hour-session status line, in the captured wording.
const readyScreen = () => {
  const status = ` ${model}${noCountdown ? '' : ` · ${countdownText(countdownMin)}`} · 12.9K (3%)`;
  const endButton = '✕ End session';
  const statusLine = status + ' '.repeat(Math.max(1, 157 - status.length - endButton.length)) + endButton;
  return CLEAR + crlf(
    [
      bannerLine,
      cwd,
      statusLine,
      '╭' + '─'.repeat(94) + '╮',
      '│'.padEnd(95) + '│',
      '│  ▍' + READY_PROMPT.padEnd(91) + '│',
      '│'.padEnd(95) + '│',
      '╰' + '─'.repeat(94) + '╯',
      '',
    ].join('\n'),
  );
};

const projectKey = basename(cwd);

// The real TUI holds a pid lock for its lifetime and leaves it behind on a crash;
// the supervisor claims stale locks via pid liveness before spawning.
writeFileSync(join(configDir, 'freebuff.lock'), String(process.pid));

// Opt-in: tests learn the pid of the process that spawned the Instance (the supervisor).
if (process.env.FREEBUFF_STUB_PARENT_PID_FILE) writeFileSync(process.env.FREEBUFF_STUB_PARENT_PID_FILE, String(process.ppid));
logInput({ event: 'spawn', pid: process.pid });

// The displayed model is keyboard-driven: the picker cursor names it (issue #13), never
// settings.json. Without FREEBUFF_STUB_PICKER the replayed fixture keeps the real TUI's
// remembered-model cursor, and a pick lands on that row.
const fixtureCursorName = () => {
  const lines = fixture('picker-expanded.ansi').split('\n');
  const cursorLine = lines.find((line) => line.includes('›')) ?? '';
  return cursorLine.replace(/[│›]/g, ' ').trim().split(/\s{2,}/)[0] ?? 'none';
};

let phase = 'picker';
let pending = '';
// Issue #23: the unknown screen stands until an accepted Enter flips the stub to ready.
let unknownStuck = mode === 'unknown';
let unknownIgnore = Number(process.env.FREEBUFF_STUB_UNKNOWN_IGNORE_ENTER ?? 0);
let selection = 0;
let model = 'none';
let escapeState = 0;
let csi = '';
let pasting = false;
let pasted = '';
let chatCounter = 0;
let newChatRequested = false;
let lastLogPath = null;
let expireShown = false;

// Enter at the picker — or at the unknown screen standing in for one (issue #23) —
// accepts the cursor's model and starts the Hour session.
const acceptEnter = () => {
  model = pickerOverride !== null ? (pickerOverride[selection]?.name ?? 'none') : fixtureCursorName();
  phase = 'ready';
  out(readyScreen());
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
    out(pickerScreen());
    phase = 'picker';
    return;
  }
  if (prompt === '/new') {
    newChatRequested = true;
    return;
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
  appendFileSync(lastLogPath, JSON.stringify({ [MSG_KEY]: prompt }) + '\n');
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
      appendFileSync(lastLogPath, JSON.stringify({ [MSG_KEY]: `progress ${tick}` }) + '\n');
      out(`working ${tick}\r\n`);
    }
  }
  for (const line of linesThisTurn) out(`${line}\r\n`);
  await sleep(30 + Math.random() * 50);
  appendFileSync(
    lastLogPath,
    JSON.stringify({ type: 'end', role: 'agent', [SHOULD_END_TURN_KEY]: true, data: noAnswerThisTurn ? {} : { [FULL_RESPONSE_KEY]: answer } }) + '\n',
  );
  await sleep(30 + Math.random() * 50);
  appendFileSync(lastLogPath, JSON.stringify({ [MSG_KEY]: TURN_END_MSG }) + '\n');
  // Issue #11: the Hour session expiring shows the captured Continue screen; Enter
  // starts the next Hour session (ready), Esc reopens the picker.
  if (mode === 'expire' && !expireShown) {
    expireShown = true;
    phase = 'continue';
    out(continueScreen());
  }
};

process.stdin.setEncoding('utf8');
// The real TUI reads raw keys; a cooked stdin lets the console host swallow the
// picker's arrow keys before this process ever sees them.
process.stdin.setRawMode(true);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    // Escape sequences (CSI): the down/up arrows at the picker, and the bracketed-paste
    // markers, between which every char is literal text (Enter included).
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
      } else if (pickerOverride !== null && phase === 'picker' && csi === '') {
        const last = pickerOverride.length - 1;
        if (char === 'A' && selection > 0) selection -= 1;
        if (char === 'B' && selection < last) selection += 1;
        out(pickerScreen());
      }
      continue;
    }
    if (char === '\x1b') {
      // Esc on the Continue screen reopens the Model picker.
      if (phase === 'continue' && !pasting) {
        phase = 'picker';
        out(pickerScreen());
      } else {
        escapeState = 1;
      }
    } else if (pasting) {
      pending += char;
      pasted += char;
    } else if (char === '\r') {
      // Raw mode delivers Enter as CR; a stray LF must not count as a second Enter.
      if (unknownStuck) {
        logInput({ event: 'enter' });
        if (unknownIgnore > 0) unknownIgnore -= 1;
        else {
          unknownStuck = false;
          acceptEnter();
        }
      } else if (phase === 'picker') {
        logInput({ event: 'enter' });
        acceptEnter();
      } else if (phase === 'continue') {
        // Enter on the Continue screen starts the next Hour session.
        logInput({ event: 'enter' });
        phase = 'ready';
        out(readyScreen());
      } else {
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
if (mode === 'unknown') {
  // No intermediate banner frame: the first stable screen is already the unknown one,
  // so a boot produces exactly one dump signature. Repaints tick the Countdown until
  // an accepted Enter flips the stub to ready (issue #23); that ready session is the
  // terminal state, so the normal boot below must not run for this mode.
  out(unknownScreen());
  while (unknownStuck) {
    await sleep(200);
    countdownMin = Math.max(1, countdownMin - 1);
    // Never repaint over the ready screen an Enter may just have produced.
    if (unknownStuck) out(unknownScreen());
  }
} else {
  out(CLEAR + bannerLine + '\r\n' + cwd + '\r\n');
  await sleep(80);
  if (mode === 'needs-login') {
    out(LOGIN_REQUIRED + '\r\n');
    for (;;) await sleep(1_000);
  }
  if (sessionAlive) {
    model = fixtureCursorName();
    phase = 'ready';
    out(readyScreen());
  } else {
    phase = 'picker';
    out(pickerScreen());
  }
}
