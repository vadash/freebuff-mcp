import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { METADATA_FILENAME } from './markers.ts';
import { freezeKey } from './screen.ts';

// Issue #21: unknown settle-loop screens dumped under the config directory,
// one folder per CLI version, one file per Freeze key. Write-only.
const SCREEN_DUMPS_DIRNAME = 'screen-dumps';

// The installed CLI version from the metadata file, shared by the updatePending
// probe and the screen-dump folder name; null when unreadable.
export const metadataVersion = (configDir: string): string | null => {
  try {
    const meta = JSON.parse(readFileSync(join(configDir, METADATA_FILENAME), 'utf8')) as { version?: unknown };
    return typeof meta.version === 'string' ? meta.version : null;
  } catch {
    return null;
  }
};

// Issue #21: an unknown Screen frame is dumped once per Freeze key under the
// config directory, in a folder per installed CLI version. Countdown repaints dedupe
// to one file because the Freeze key strips the Countdown lines; the file keeps them.
// Write-only diagnostics: nothing reads dumps back, and a failed dump never fails
// the settle loop.
export const writeScreenDump = (configDir: string, text: string): void => {
  try {
    const version = metadataVersion(configDir) ?? 'unknown';
    const hash = createHash('sha256').update(freezeKey(text)).digest('hex');
    const dir = join(configDir, SCREEN_DUMPS_DIRNAME, version);
    const path = join(dir, `${hash}.ansi`);
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, text);
    }
  } catch {
    // Diagnostics only.
  }
};
