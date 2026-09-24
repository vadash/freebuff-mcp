// Ready prompt vendored from Praket7/freebuff-mcp (MIT); the rest probed from the live TUI.
// Wording-bearing markers are backed by a real captured fixture (tests/fixtures/screen/README.md).
export const READY_PROMPT = 'Enter a coding task or / for commands';
export const CONNECTING = 'Connecting';
export const PICKER_TITLE = 'Start coding for free';
export const TURN_END_MSG = 'Main prompt finished';
export const LOGIN_REQUIRED = 'Not authenticated';
export const SINGLE_INSTANCE = 'Only one freebuff instance is allowed';

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
export const SETTINGS_FILENAME = 'settings.json';

// Slash commands typed into the TUI input box.
export const NEW_COMMAND = '/new';

// Screen regexes over the flattened Screen text.
// Countdown on the ready status line: `7h 12m left`, `1h left`, `59m left`, `2:58 left` (ready.ansi).
export const COUNTDOWN_REGEX = /(?:(\d+)h(?:\s+(\d+)m)?|(\d+)m)\s+left|(\d+):(\d\d)\s+left/;
// Price on a picker row: `5 Freebucks/hr` (picker-expanded.ansi).
export const PRICE_REGEX = /(\d+)\s+Freebucks\/hr/;
// Balance on the picker: `FREE · 20/25 Freebucks daily · resets in 9h 12m`; an exhausted
// day shows `0/25` or `0/40`. There is no separate low-Freebucks literal in 0.0.193: the
// low state is this left number falling below a model's price (fixture README).
export const FREEBUCKS_BALANCE_REGEX = /(\d+)\/(\d+)\s+Freebucks daily/;
// Remaining balance on the Continue screen: `Session ended  ·  20 Freebucks left`.
export const FREEBUCKS_LEFT_REGEX = /(\d+)\s+Freebucks left/;
export const VERSION_BANNER_REGEX = /freebuff\s+v(\S+)/i;
