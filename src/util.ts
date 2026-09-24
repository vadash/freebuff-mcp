// Shared helpers; each behaviour has exactly one home (issue #10).
/// <reference lib="es2024" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_FILENAME } from './protocol/markers.ts';

export const sleep = (ms: number): Promise<void> => {
  const { promise, resolve: wake } = Promise.withResolvers<void>();
  setTimeout(wake, ms);
  return promise;
};

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const readSettings = (configDir: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(configDir, SETTINGS_FILENAME), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};
