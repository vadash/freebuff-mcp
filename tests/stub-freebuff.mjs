// Protocol-faithful stub of the freebuff TUI for driver e2e tests. Deliberately
// a dependency-free .mjs: the marker strings and the projectKey hash below
// duplicate src/protocol/{markers,chatStore}.ts on purpose so the driver under
// test is the only side consuming the real modules. The Model picker and the
// Continue screen replay the real captured fixtures verbatim
// (tests/fixtures/screen/README.md); FREEBUFF_STUB_COUNTDOWN_MIN,
// FREEBUFF_STUB_FREEBUCKS and FREEBUFF_STUB_PICKER override the numbers the
// protocol reads.
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

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));
const out = (s) => process.stdout.write(s);
const CLEAR = '\x1b[2J\x1b[H';

const args = process.argv.slice(2);
const cwd = args[args.indexOf('--cwd') + 1];
const mode = process.env.FREEBUFF_STUB_MODE ?? 'happy';
const configDir = process.env.FREEBUFF_CONFIG_DIR;
const version = process.env.FREEBUFF_STUB_VERSION ?? '0.0.186';

// Env controls (issue #11): Countdown minutes, Freebucks balance, picker entries and prices.
const countdownMin = Number(process.env.FREEBUFF_STUB_COUNTDOWN_MIN ?? 432);
const [balanceLeft, balanceDaily] = (process.env.FREEBUFF_STUB_FREEBUCKS ?? '20/25').split('/').map(Number);
const pickerOverride = process.env.FREEBUFF_STUB_PICKER ? JSON.parse(process.env.FREEBUFF_STUB_PICKER) : null;

const bannerLine = `freebuff v${version}`;

const fixture = (name) => readFileSync(new URL(`./fixtures/screen/${name}`, import.meta.url), 'utf8');
// Fixtures store the flattened screen with \n; the ConPTY on the other side of the
// driver needs \r\n, exactly like the real TUI's output.
const crlf = (text) => text.replace(/\n/g, '\r\n');

// Real Countdown wording: `7h 12m left`, `1h left`, `59m left`.
const countdownText = (min) => {
  const total = Math.max(0, Math.floor(min));
  if (total < 60) return `${total}m left`;
  const hours = Math.floor(total / 60);
  return total % 60 === 0 ? `${hours}h left` : `${hours}h ${total % 60}m left`;
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
        cell(`   ${i === 0 ? '›' : ' '} ${entry.name}    NEW`),
        priceRow(entry.price),
        bar('└', '┘'),
        '',
      ]),
      ...lines.slice(balance),
    ];
  }
  const body = rows.map((line) => line.replace(BALANCE_LINE, `FREE · ${balanceLeft}/${balanceDaily} Freebucks daily`));
  return CLEAR + crlf([bannerLine, cwd, ...body].join('\n'));
};

const continueScreen = () => CLEAR + crlf(fixture('continue.ansi'));

// Ready input box with the Hour-session status line, in the captured wording.
const readyScreen = () => {
  const status = ` ${model} · ${countdownText(countdownMin)} · 12.9K (3%)`;
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

let settings = null;
try {
  settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
} catch {}
const model = typeof settings?.freebuffModel === 'string' ? settings.freebuffModel : 'none';

let phase = 'picker';
let pending = '';
let chatCounter = 0;
let newChatRequested = false;
let lastLogPath = null;
let expireShown = false;

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
    if (lastLogPath) appendFileSync(lastLogPath, JSON.stringify({ [MSG_KEY]: 'end-session' }) + '\n');
    out(pickerScreen());
    phase = 'picker';
    if (mode === 'park-clear') {
      setTimeout(() => {
        out(CLEAR);
        process.exit(0);
      }, 1200);
    }
    return;
  }
  if (prompt === '/new') {
    newChatRequested = true;
    return;
  }
  const dirName = newChatRequested ? `chat-new-${chatCounter++}` : `chat-${chatCounter++}`;
  newChatRequested = false;
  const crashThisTurn = mode === 'kill-always' || (mode === 'kill-mid-turn' && !chatsExist());
  const freezeThisTurn = mode === 'freeze' && !chatsExist();
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
  if (freezeThisTurn) {
    for (;;) await sleep(1_000);
  }
  await sleep(30 + Math.random() * 50);
  appendFileSync(
    lastLogPath,
    JSON.stringify({ type: 'end', role: 'agent', [SHOULD_END_TURN_KEY]: true, data: { [FULL_RESPONSE_KEY]: answer } }) + '\n',
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
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  for (const char of chunk) {
    // ConPTY line input turns one written CR into CR LF; the real TUI reads raw
    // keys, so LF must not count as a second Enter.
    if (char === '\r') {
      if (phase === 'picker') {
        phase = 'ready';
        out(readyScreen());
      } else if (phase === 'continue') {
        // Enter on the Continue screen starts the next Hour session.
        phase = 'ready';
        out(readyScreen());
      } else {
        const prompt = pending;
        pending = '';
        void submit(prompt);
      }
    } else if (char === '\x1b' && phase === 'continue') {
      // Esc on the Continue screen reopens the Model picker.
      phase = 'picker';
      out(pickerScreen());
    } else if (char !== '\n') {
      pending += char;
    }
  }
});

await sleep(80);
out(CONNECTING + ' to agent...\r\n');
await sleep(80);
out(CLEAR + bannerLine + '\r\n' + cwd + '\r\n');
await sleep(80);
if (mode === 'needs-login') {
  out(LOGIN_REQUIRED + '\r\n');
  for (;;) await sleep(1_000);
}
if (model === 'none') {
  phase = 'picker';
  out(pickerScreen());
} else {
  phase = 'ready';
  out(readyScreen());
}
