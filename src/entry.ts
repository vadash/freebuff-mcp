// Entry-point startup block shared by the supervisor daemon and the MCP server:
// the main-module check plus the supervisor env parsing.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SUPERVISOR_PIPE, TASK_TIMEOUT_MS } from './config.ts';
import { defaultDriverOptions } from './driver.ts';
import type { DriverOptions } from './driver.ts';

export const isMainModule = (moduleUrl: string): boolean =>
  process.argv[1] !== undefined && moduleUrl === pathToFileURL(resolve(process.argv[1])).href;

export interface MainOptions {
  pipeName: string;
  driverOptions: DriverOptions;
  taskTimeoutMs: number;
}

export const mainOptions = (): MainOptions => ({
  pipeName: process.env.FREEBUFF_SUPERVISOR_PIPE ?? SUPERVISOR_PIPE,
  driverOptions: process.env.FREEBUFF_DRIVER_JSON
    ? (JSON.parse(process.env.FREEBUFF_DRIVER_JSON) as DriverOptions)
    : defaultDriverOptions(),
  taskTimeoutMs: Number(process.env.FREEBUFF_TASK_TIMEOUT_MS) || TASK_TIMEOUT_MS,
});
