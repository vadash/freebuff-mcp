// Streak keeper: once a day (scheduled 21:00 TRT = 18:00 UTC, freebuff resets
// its daily allowance at 21:00 UTC) run one tiny Task so the login streak
// stays alive. Skips when the chat store already shows activity in the
// current reset window.
import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { connect } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUPERVISOR_ENTRY = join(REPO, 'src', 'supervisor.ts');
const PIPE = '\\\\.\\pipe\\freebuff-supervisor';
const CHATS = process.env.FREEBUFF_KEEPER_CHATS ?? join(homedir(), '.config', 'manicode', 'projects', 'freebuff-mcp', 'chats');
const LOG = join(REPO, 'streak-keeper.log');
const SPAWN_WAIT_MS = 120_000;
const TURN_TIMEOUT_MS = 21 * 60_000;

// --- pure helpers (tested in tests/streak-keeper.test.mjs) ---

// Most recent 21:00 UTC instant — the start of the current allowance day.
export const lastReset = (now = new Date()) => {
  const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21);
  return new Date(reset > now.getTime() ? reset - 86_400_000 : reset);
};

export const pickFile = (files, dayKey) => {
  let hash = 0;
  for (const ch of dayKey) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return files[hash % files.length];
};

export const buildPrompt = (files, dayKey) => {
  const file = files.length > 0 ? pickFile(files, dayKey) : null;
  return file
    ? `In one sentence, what does ${file} do? Read only — do not edit anything.`
    : `What day is it today? Reply in one short sentence.`;
};

const dayKeyOf = (reset) => reset.toISOString().slice(0, 10);

// --- plumbing ---

const log = (message) => {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
};

const toast = (message) => {
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode('freebuff streak')) | Out-Null
$x.Item(1).AppendChild($t.CreateTextNode($env:KEEPER_MSG)) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('freebuff-streak').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
    env: { ...process.env, KEEPER_MSG: message },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = () =>
  new Promise((resolveProbe) => {
    const socket = connect(PIPE);
    const finish = (ok) => {
      socket.destroy();
      resolveProbe(ok);
    };
    const timer = setTimeout(() => finish(false), 1000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

const request = (message, timeoutMs) =>
  new Promise((resolveRequest, reject) => {
    const socket = connect(PIPE);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`pipe timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolveRequest(JSON.parse(buffer.slice(0, nl)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

// Returns true when this call spawned the daemon (only the spawner shuts it down).
const ensureSupervisor = async () => {
  if (await probe()) return false;
  // Same console-hiding trick as src/server.ts: `start /b` under a hidden cmd
  // lets the supervisor outlive this process.
  const command = `start "" /b "${process.execPath}" --experimental-strip-types "${SUPERVISOR_ENTRY}"`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.unref();
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(200);
  }
  throw new Error('spawned supervisor never opened the pipe');
};

const activeToday = () => {
  let entries;
  try {
    entries = readdirSync(CHATS);
  } catch {
    return false;
  }
  const since = lastReset().getTime();
  for (const entry of entries) {
    try {
      if (statSync(join(CHATS, entry)).mtimeMs > since) return true;
    } catch {
      // vanished between readdir and stat — not activity
    }
  }
  return false;
};

const listSrcFiles = () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) files.push(relative(REPO, path).replaceAll('\\', '/'));
    }
  };
  walk(join(REPO, 'src'));
  return files.sort();
};

const fail = (message) => {
  log(`FAIL ${message}`);
  toast(message);
  process.exit(1);
};

// --- main ---

const main = async () => {
  const spawned = await ensureSupervisor();
  if (spawned) log('spawned supervisor');
  try {
    const status = await request({ op: 'status' }, 30_000);
    if (!status?.ok) return fail(`status failed: ${JSON.stringify(status)}`);
    if (status.needsLogin) return fail('needs_login — run: freebuff login');
    if (status.state === 'busy') return log('SKIP a Turn is already running');
    if (activeToday()) return log('SKIP activity already in the current reset window');
    const bind = await request({ op: 'bind', dir: REPO }, 30_000);
    if (!bind?.ok) return fail(`bind failed: ${bind?.error ?? JSON.stringify(bind)}`);
    const prompt = buildPrompt(listSrcFiles(), dayKeyOf(lastReset()));
    log(`run: ${prompt}`);
    const answer = await request({ op: 'run_prompt', dir: REPO, prompt }, TURN_TIMEOUT_MS + 30_000);
    if (!answer?.ok || answer.kind !== 'answer') return fail(`turn failed: ${JSON.stringify(answer)}`);
    log(`OK answer: ${answer.answer.slice(0, 120).replaceAll(/\s+/g, ' ')}`);
  } finally {
    // KISS rule: never kill a supervisor the keeper did not start.
    if (spawned) await request({ op: 'shutdown' }, 10_000).catch(() => {});
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
