import fs from 'fs';
import path from 'path';
import { Logger } from '../utils/Logger';

let _config: Record<string, any> | null = null;

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Replace `${NAME}` / `${NAME:-default}` in every string of a config value with the
 * environment variable — so secrets (API keys, client secrets) live in the environment
 * or a secret store instead of a committed JSON file. Unset variables without a default
 * become '' and are reported once.
 */
export function substituteEnv<T>(value: T, missing: Set<string> = new Set(), source: Record<string, string | undefined> = process.env): T {
    if (typeof value === 'string') {
        return value.replace(ENV_REF, (_match, name: string, fallback: string | undefined) => {
            const env = source[name];
            if (env !== undefined && env !== '') return env;
            if (fallback !== undefined) return fallback;
            missing.add(name);
            return '';
        }) as T;
    }
    if (Array.isArray(value)) return value.map((v) => substituteEnv(v, missing, source)) as T;
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value)) out[key] = substituteEnv(v, missing, source);
        return out as T;
    }
    return value;
}

/**
 * config/app.json (relative to the working directory), loaded once with ${ENV}
 * substitution applied. A missing file yields {}; a malformed one is reported.
 */
export function getAppConfig(): Record<string, any> {
    if (_config) return _config;

    const file = path.join(process.cwd(), 'config', 'app.json');
    let raw: Record<string, any> = {};
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err: any) {
        if (err?.code !== 'ENOENT') {
            Logger.error(`config/app.json could not be read: ${err?.message || err}`);
        }
    }

    const missing = new Set<string>();
    _config = substituteEnv(raw, missing);
    if (missing.size > 0) {
        Logger.warn(`config/app.json references unset environment variables: ${[...missing].join(', ')}`);
    }
    return _config!;
}

/** Forget the cached config (tests, hot reload) */
export function resetAppConfig(): void {
    _config = null;
}
