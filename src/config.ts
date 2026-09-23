import { readFileSync } from 'node:fs';

export const QUEUE_DEPTH = 4;
export const TASK_TIMEOUT_MS = 20 * 60_000;
export const READY_TIMEOUT_MS = 120_000;
export const ACK_TIMEOUT_MS = 20_000;
export const PASTE_THRESHOLD_BYTES = 64 * 1024;
export const STOP_GRACE_MS = 2_000;
export const FREEZE_THRESHOLD_MINUTES = 10;
export const MAX_TASK_RESPAWNS = 2;
export const PARK_IMMEDIATELY_AFTER_TASK = true;
export const SCREEN_ROWS = 48;
export const SCREEN_COLS = 160;
export const SUPERVISOR_PIPE = '\\\\.\\pipe\\freebuff-supervisor';

export const DEFAULT_MODELS = ['deepseek/deepseek-v4.1-flash', 'mimo/mimo-v2.5', 'z-ai/glm-5.3-flash'];

const MODEL_SLUG = /^\S+\/\S+$/;

export const resolveModelPolicy = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const file = env.FREEBUFF_MODELS_FILE;
  if (file === undefined || file === '') return [...DEFAULT_MODELS];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [...DEFAULT_MODELS];
  }
  for (const line of text.split(/\r?\n/)) {
    const slug = line.trim();
    if (slug !== '' && MODEL_SLUG.test(slug)) return [slug];
  }
  return [...DEFAULT_MODELS];
};
