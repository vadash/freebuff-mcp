import { homedir } from 'node:os';
import { join } from 'node:path';

export const QUEUE_DEPTH = 4;
export const TASK_TIMEOUT_MS = 20 * 60_000;
export const READY_TIMEOUT_MS = 120_000;
export const ACK_TIMEOUT_MS = 20_000;
export const PASTE_THRESHOLD_BYTES = 64 * 1024;
export const STOP_GRACE_MS = 2_000;
export const STOP_TIMEOUT_MS = 5_000;
export const PICKER_REENTER_MS = 3_000;
// Issue #23: Enter fallback after this much continuously unrecognized Screen.
export const UNKNOWN_SCREEN_FALLBACK_MS = 10_000;
export const FREEZE_THRESHOLD_MINUTES = 3;
export const FREEZE_THRESHOLD_MS = FREEZE_THRESHOLD_MINUTES * 60_000;
export const FREEZE_POLL_MAX_MS = 1_000;
export const FREEZE_POLL_MIN_MS = 50;
export const ERROR_LOG_POLL_MS = 250;
export const FAILURE_SCREEN_LINES = 20;
export const SCREEN_ROWS = 48;
export const SCREEN_COLS = 160;
export const SUPERVISOR_PIPE = '\\\\.\\pipe\\freebuff-supervisor';
// Issue #17: error-looking Screen lines seen during a Turn, one JSON line per entry.
export const ERROR_LOG_PATH = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'freebuff-supervisor', 'errors.jsonl');

// Driver polling and typing cadence.
export const POLL_MS = 250;
export const TYPE_DELAY_MS = 150;
export const NEW_SETTLE_MS = 300;
export const STOP_POLL_MS = 50;

// Named-pipe transport and entry-point timings.
export const PIPE_PROBE_TIMEOUT_MS = 250;
export const PIPE_POLL_MS = 100;
export const PIPE_CONNECT_TIMEOUT_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const SHUTDOWN_EXIT_MS = 100;
export const STARTUP_PIPE_WAIT_MS = 1_000;

