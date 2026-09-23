// Protocol-faithful stub of the freebuff TUI for driver e2e tests. Deliberately
// a dependency-free .mjs: the marker strings and the projectKey hash below
// duplicate src/protocol/{markers,chatStore}.ts on purpose so the driver under
// test is the only side consuming the real modules.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const READY_PROMPT = 'Enter a coding task or / for commands';
const CONNECTING = 'Connecting';
const PICKER_TITLE = 'Select a model';
const TURN_END_MSG = 'Main prompt finished';
const MSG_KEY = 'msg';
const SHOULD_END_TURN_KEY = 'shouldEndTurn';
const FULL_RESPONSE_KEY = 'fullResponse';

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));
const out = (s) => process.stdout.write(s);
const CLEAR = '\x1b[2J\x1b[H';

const args = process.argv.slice(2);
const cwd = args[args.indexOf('--cwd') + 1];
const mode = process.env.FREEBUFF_STUB_MODE ?? 'happy';
const configDir = process.env.FREEBUFF_CONFIG_DIR;
const version = process.env.FREEBUFF_STUB_VERSION ?? '0.0.186';

const LOGIN_REQUIRED = 'Login required';
const bannerLine = `freebuff v${version}`;
const trialLine = 'Trial: 432 min left';
const dailyLine = 'Daily Freebucks: 25/25';

const projectKey = `${basename(cwd)}--${createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 12)}`;

// The real TUI holds a pid lock for its lifetime and leaves it behind on a crash;
// the supervisor claims stale locks via pid liveness before spawning.
writeFileSync(join(configDir, 'freebuff.lock'), String(process.pid));

let settings = null;
try {
  settings = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
} catch {}
const model = typeof settings?.model === 'string' ? settings.model : 'none';

let phase = 'picker';
let pending = '';
let chatCounter = 0;
let newChatRequested = false;
let lastLogPath = null;

const chatsRoot = () => join(configDir, 'manicode', 'projects', projectKey, 'chats');

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
    out(CLEAR + bannerLine + '\r\n' + cwd + '\r\n' + PICKER_TITLE + '\r\n> large-model\r\n  small-model\r\n' + trialLine + '\r\n' + dailyLine + '\r\n');
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
        out(CLEAR + bannerLine + '\r\n' + cwd + '\r\n' + READY_PROMPT + '\r\n' + trialLine + '\r\n' + dailyLine + '\r\n');
      } else {
        const prompt = pending;
        pending = '';
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
out(CLEAR + bannerLine + '\r\n' + cwd + '\r\n');
await sleep(80);
if (mode === 'needs-login') {
  out(LOGIN_REQUIRED + '\r\n');
  for (;;) await sleep(1_000);
}
out(PICKER_TITLE + '\r\n');
if (model === 'none') {
  out('> large-model\r\n  small-model\r\n' + trialLine + '\r\n' + dailyLine + '\r\n');
} else {
  out(model + '\r\n');
  phase = 'ready';
  out(READY_PROMPT + '\r\n' + trialLine + '\r\n' + dailyLine + '\r\n');
}
