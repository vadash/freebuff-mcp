// Patches node-pty's ConPTY console-list helper: it crashes with "AttachConsole failed"
// whenever the killed shell's pid has no console (already dead), dumping a stack into
// our stderr and stalling pty.kill() for its 5s fallback timeout. The patch makes the
// agent answer an empty process list instead, which windowsPtyAgent.kill() handles fine.
// Wired as a postinstall hook; idempotent.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MARKER = '/* patched by scripts/patch-node-pty.mjs */';

let agentPath;
try {
  agentPath = require.resolve('node-pty/lib/conpty_console_list_agent.js');
} catch {
  console.log('node-pty not installed; nothing to patch');
  process.exit(0);
}

const source = readFileSync(agentPath, 'utf8');
if (source.includes(MARKER)) {
  console.log('node-pty console-list agent already patched');
  process.exit(0);
}

const UNPATCHED = `var consoleProcessList = getConsoleProcessList(shellPid);
process.send({ consoleProcessList: consoleProcessList });`;
const PATCHED = `${MARKER}
var consoleProcessList;
try {
  consoleProcessList = getConsoleProcessList(shellPid);
} catch (err) {
  // The pid has no console (already dead): nothing extra for kill() to terminate.
  consoleProcessList = [];
}
process.send({ consoleProcessList: consoleProcessList });`;

if (!source.includes(UNPATCHED)) {
  console.error(`node-pty console-list agent does not match the expected source; not patching:\n${agentPath}`);
  process.exit(1);
}

writeFileSync(agentPath, source.replace(UNPATCHED, PATCHED));
console.log(`patched ${agentPath}`);
