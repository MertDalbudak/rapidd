import os from 'os';
import path from 'path';

// Tests never read the developer's .env (src/setup/env loads ENV_FILE, else .env): a test that
// needs a setting sets it, so what passes here passes in CI, where there is no .env. Tests of
// env files point ENV_FILE at their own.
process.env.ENV_FILE = path.join(os.tmpdir(), 'rapidd-tests-read-no-env-file');
