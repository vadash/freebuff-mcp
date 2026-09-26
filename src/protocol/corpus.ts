import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #31: the fixture corpus ships one folder per CLI version
// (tests/fixtures/screen/0.0.193, 0.0.198, ...) beside the unversioned `negative/`
// and `synthetic/` sets. The Supervisor reads the version folder names to learn
// which versions the corpus covers: a drift signal never rises for a version the
// corpus already holds, because promoting a dump into its folder is the fix.
const CORPUS_DIR = join(fileURLToPath(new URL('../..', import.meta.url)), 'tests', 'fixtures', 'screen');

// Version folder names currently on file, read live so promoting a dump into the
// corpus clears the drift signal without a supervisor restart.
export const corpusVersions = (): string[] => {
  try {
    return readdirSync(CORPUS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    // A package installed without the corpus covers nothing.
    return [];
  }
};
