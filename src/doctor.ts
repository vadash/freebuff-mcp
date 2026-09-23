import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHATS_DIRNAME,
  CONNECTING,
  FULL_RESPONSE_KEY,
  LOG_FILENAME,
  LOGIN_REQUIRED,
  MANICODE_DIRNAME,
  MSG_KEY,
  PICKER_TITLE,
  PROJECTS_DIRNAME,
  READY_PROMPT,
  SHOULD_END_TURN_KEY,
  TURN_END_MSG,
} from './protocol/markers.ts';
import { flattenScreen } from './protocol/screen.ts';

export interface DoctorOptions {
  markers?: Record<string, string>;
  fixtureDir?: string;
}

export interface DoctorReport {
  ok: boolean;
  failures: string[];
}

const allMarkers = () => ({
  READY_PROMPT,
  CONNECTING,
  PICKER_TITLE,
  TURN_END_MSG,
  LOGIN_REQUIRED,
  FULL_RESPONSE_KEY,
  SHOULD_END_TURN_KEY,
  MSG_KEY,
  MANICODE_DIRNAME,
  PROJECTS_DIRNAME,
  CHATS_DIRNAME,
  LOG_FILENAME,
});

const FIXTURE_FOR_MARKER: Record<string, string> = {
  READY_PROMPT: 'screen/ready.ansi',
  CONNECTING: 'screen/connecting.ansi',
  PICKER_TITLE: 'screen/picker-expanded.ansi',
  LOGIN_REQUIRED: 'screen/login-required.ansi',
  TURN_END_MSG: 'chat/full-turn.jsonl',
  FULL_RESPONSE_KEY: 'chat/full-turn.jsonl',
  SHOULD_END_TURN_KEY: 'chat/full-turn.jsonl',
  MSG_KEY: 'chat/full-turn.jsonl',
};

const defaultFixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');

export const runDoctor = (options: DoctorOptions = {}): DoctorReport => {
  const fixtureDir = options.fixtureDir ?? defaultFixtureDir;
  const values = { ...allMarkers(), ...options.markers };
  let signatures: Record<string, string>;
  try {
    signatures = JSON.parse(readFileSync(join(fixtureDir, 'protocol-signatures.json'), 'utf8')) as Record<string, string>;
  } catch {
    return { ok: false, failures: ['protocol-signatures.json: missing or unreadable committed signatures'] };
  }
  const failures: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const expected = signatures[name];
    if (expected === undefined) {
      failures.push(`${name}: no committed protocol signature`);
      continue;
    }
    if (expected !== createHash('sha256').update(value).digest('hex')) {
      failures.push(`${name}: marker value does not match the committed protocol signature`);
      continue;
    }
    const fixture = FIXTURE_FOR_MARKER[name];
    if (fixture === undefined) continue;
    let raw: string;
    try {
      raw = readFileSync(join(fixtureDir, fixture), 'utf8');
    } catch {
      failures.push(`${name}: pinned fixture ${fixture} is missing or unreadable`);
      continue;
    }
    const content = fixture.endsWith('.ansi') ? flattenScreen([raw]) : raw;
    if (!content.includes(value)) failures.push(`${name}: pinned fixture ${fixture} does not contain the marker`);
  }
  return { ok: failures.length === 0, failures };
};
