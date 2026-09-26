// Ready prompt vendored from Praket7/freebuff-mcp (MIT); the rest probed from the live TUI.
// Wording-bearing markers were captured from the real TUI (tests/fixtures/screen/README.md);
// `doctor` checks the ones the Model picker, ready, Continue, Session-in-use dialog, login
// gate and connecting screens render against the live Screen.
export const READY_PROMPT = 'Enter a coding task or / for commands';
export const CONNECTING = 'Connecting';
// Whole-word match, mirroring classifyScreen: `Connecting...` on the connecting Screen,
// never a ready Screen's unrelated text (issue #22).
export const CONNECTING_REGEX = new RegExp(`\\b${CONNECTING}\\b`, 'i');
export const PICKER_TITLE = 'Start coding for free';
// Picker hint row added by the 0.0.198 update (`H · History` above the bottom border;
// session-in-use.ansi shows it under the dialog). Checked by doctor on the Model picker.
export const HISTORY_HINT = 'H · History';
export const TURN_END_MSG = 'Main prompt finished';
export const LOGIN_REQUIRED = 'Not authenticated';
// Single-instance dialogs: the 2026-09 CLI (0.0.198+) says 'Session already in use';
// older builds said 'Only one freebuff instance is allowed at a time.'
export const SINGLE_INSTANCE_MARKERS = ['Session already in use', 'Only one freebuff instance is allowed'];
export const mentionsSingleInstance = (text: string): boolean =>
  SINGLE_INSTANCE_MARKERS.some((marker) => text.includes(marker));

// Continue screen after an Hour session expires (continue.ansi).
export const SESSION_ENDED = 'Session ended';
export const CONTINUE_PROMPT = 'Press Enter to continue in a new session';

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

// Keystrokes: down-arrow moves the picker cursor one row.
export const DOWN_ARROW = '\x1b[B';
// Bracketed paste (issue #18): text between these markers is inserted literally, so a
// newline in a prompt never submits it early; one Enter after PASTE_END submits it.
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

// Screen regexes over the flattened Screen text.
// Countdown on the ready status line: `7h 12m left`, `1h left`, `59m left`, `2:58 left` (ready.ansi).
export const COUNTDOWN_REGEX = /(?:(\d+)h(?:\s+(\d+)m)?|(\d+)m)\s+left|(\d+):(\d\d)\s+left/;
// Status line separator: `GLM 5.3 Flash · 58m left · 12.8K (1%)`; the model is the leading segment.
export const STATUS_SEPARATOR = '·';
// Price on a picker row: `5 Freebucks/hr` (picker-expanded.ansi).
export const PRICE_REGEX = /(\d+)\s+Freebucks\/hr/;
// Balance on the picker: `FREE · 25/25 Freebucks daily · resets in 19h 50m · 15 in wallet`
// (picker-expanded.ansi; 0.0.199 added the wallet suffix). An exhausted
// day shows `0/25` or `0/40`. There is no separate low-Freebucks literal: the
// low state is this left number falling below a model's price (fixture README).
export const FREEBUCKS_BALANCE_REGEX = /(\d+)\/(\d+)\s+Freebucks daily/;
// Remaining balance as the 0.0.193 Continue screen rendered it (`Session ended  ·  20 Freebucks left`);
// the 0.0.199 Continue screen no longer shows any balance. Kept for the Freeze key
// (such a line must never mask a freeze) and older-build tolerance.
export const FREEBUCKS_LEFT_REGEX = /(\d+)\s+Freebucks left/;
export const VERSION_BANNER_REGEX = /freebuff\s+v(\S+)/i;
