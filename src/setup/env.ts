/**
 * Load the env file (ENV_FILE, default .env) into process.env — imported first by main.ts
 * and app.ts, before any module reads its configuration. The real environment wins over
 * the file, as with dotenv.
 */
import { loadEnvFile } from './envfile';

loadEnvFile();
