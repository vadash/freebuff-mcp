// Ready prompt vendored from Praket7/freebuff-mcp (MIT); the rest probed from the live TUI.
// Picker/banner markers are provisional; the doctor check validates them against the real screen.
export const READY_PROMPT = 'Enter a coding task or / for commands';
export const CONNECTING = 'Connecting';
export const PICKER_TITLE = 'Start coding for free';
export const TURN_END_MSG = 'Main prompt finished';
export const LOGIN_REQUIRED = 'Not authenticated';
export const SINGLE_INSTANCE = 'Only one freebuff instance is allowed';

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
export const END_SESSION_COMMAND = '/end-session';

// Screen regexes over the flattened Screen text.
export const COUNTDOWN_REGEX = /(\d+)\s*min\s+left/i;
export const FREEBUCKS_DAILY_REGEX = /Daily\s+Freebucks:\s*(\S+)/i;
export const VERSION_BANNER_REGEX = /freebuff\s+v(\S+)/i;
