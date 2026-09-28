// Ready prompt vendored from Praket7/freebuff-mcp (MIT); the rest probed from the live TUI.
// Wording-bearing markers were captured from the real TUI (tests/fixtures/screen/);
// `doctor` checks the ones the Welcome screen, ready, Continue, Session-in-use dialog,
// login gate and connecting screens render against the live Screen.
export const READY_PROMPT = 'Enter a coding task or / for commands';
// The Welcome screen's info box (ADR-0004): the Instance idles here with no Hour
// session; the first submitted message starts the session.
export const WELCOME_BOX = 'Your first message starts the session';
export const CONNECTING = 'Connecting';
// Whole-word match, mirroring classifyScreen: `Connecting...` on the connecting Screen,
// never a ready Screen's unrelated text (issue #22).
export const CONNECTING_REGEX = new RegExp(`\\b${CONNECTING}\\b`, 'i');
export const TURN_END_MSG = 'Main prompt finished';
export const LOGIN_REQUIRED = 'Not authenticated';
// Single-instance dialogs: the 2026-09 CLI (0.0.198+) says 'Session already in use';
// older builds said 'Only one freebuff instance is allowed at a time.'
export const SINGLE_INSTANCE_MARKERS = ['Session already in use', 'Only one freebuff instance is allowed'];

// Continue screen after an Hour session expires (continue.ansi). 0.1.0 turned the
// dialog into a credits summary (`Remaining:`, `Credit spending:`); `Session ended`
// is gone and the prompt shrank, so the marker is the shared tail of both wordings.
export const CONTINUE_PROMPT = 'Press Enter to continue';

// Known error renderings seen during a Turn (error.ansi); logged, never acted on.
export const KNOWN_ERROR_STRINGS: readonly string[] = ['Command not found: '];

export const FULL_RESPONSE_KEY = 'fullResponse';
export const SHOULD_END_TURN_KEY = 'shouldEndTurn';
export const MSG_KEY = 'msg';

export const PROJECTS_DIRNAME = 'projects';
export const CHATS_DIRNAME = 'chats';
export const LOG_FILENAME = 'log.jsonl';

// On-disk records the CLI and this supervisor share.
export const INSTANCE_RECORD_FILENAME = 'freebuff-instance-owner.json';
export const LOCK_FILENAME = 'freebuff.lock';
export const METADATA_FILENAME = 'freebuff-metadata.json';

// Slash commands typed into the TUI input box.
export const NEW_COMMAND = '/new';

// Bracketed paste (issue #18): text between these markers is inserted literally, so a
// newline in a prompt never submits it early; one Enter after PASTE_END submits it.
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

// Screen regexes over the flattened Screen text.
// Countdown on the ready status line: `7h 12m left`, `1h left`, `59m left`, `2:58 left` (ready.ansi).
export const COUNTDOWN_REGEX = /(?:(\d+)h(?:\s+(\d+)m)?|(\d+)m)\s+left|(\d+):(\d\d)\s+left/;
// Status line separator: `1h left · 13.5K (1%)` (session usage line) and the bottom
// hint line (`← for history · ? for help`).
export const STATUS_SEPARATOR = '·';
// The footer status line (`DeepSeek V4.1 Flash • high · <dir> · /model to change ·
// Chat: New chat`, welcome.ansi/ready.ansi): the model is the segment before `•`, and
// the `/model to change` hint anchors the line — the bottom hint line also carries `·`,
// so position alone cannot find it.
export const FOOTER_SEPARATOR = '•';
export const MODEL_FOOTER_HINT = '/model to change';
// Balance on the Welcome screen: `25/25 Freebucks remaining` (the pre-0.0.20x picker
// rendered `25/25 Freebucks daily`; both wordings stay accepted for older corpora).
// Informative only: no decision gates on the balance since the Model picker died
// (ADR-0004).
export const FREEBUCKS_BALANCE_REGEX = /(\d+)\/(\d+)\s+Freebucks\s+(?:remaining|daily)/;
// Remaining balance as the 0.0.193 Continue screen rendered it (`Session ended  ·  20 Freebucks left`);
// the 0.0.199 Continue screen no longer shows any balance. Kept for the Freeze key
// (such a line must never mask a freeze) and older-build tolerance.
export const FREEBUCKS_LEFT_REGEX = /(\d+)\s+Freebucks left/;
