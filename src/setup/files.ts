import fs from 'fs';
import path from 'path';
import { validateRlsRules } from '../core/rlsRules';
import { writeEnvFile } from './envfile';
import { validateIdpMetadata } from './saml';

/**
 * The config files the wizard edits besides the env file. Changes are staged in the browser
 * and written together with the env changes on save — validated first, all or nothing.
 */

export type ConfigFileId = 'app' | 'rateLimit' | 'rls' | 'samlIdp';

export const CONFIG_FILES: Record<ConfigFileId, { path: string; title: string }> = {
    app: { path: 'config/app.json', title: 'Services (ApiClient)' },
    rateLimit: { path: 'config/rate-limit.json', title: 'Rate limits' },
    rls: { path: 'config/rls.json', title: 'Row-level security variables' },
    samlIdp: { path: 'config/saml-idp-metadata.xml', title: 'SAML identity provider metadata' },
};

export function isConfigFileId(id: string): id is ConfigFileId {
    return Object.prototype.hasOwnProperty.call(CONFIG_FILES, id);
}

const AUTH_TYPES = ['basic', 'bearer', 'api-key', 'oauth2'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const stringMap = (v: unknown) => v === undefined || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string'));

/** config/app.json: the services ApiClient calls */
export function validateAppConfig(config: Record<string, any>): string[] {
    const problems: string[] = [];
    const services = config.services;
    if (services === undefined) return problems;
    if (!services || typeof services !== 'object' || Array.isArray(services)) return ['services must be an object'];
    for (const [name, s] of Object.entries(services as Record<string, any>)) {
        const at = `services.${name}`;
        if (!/^[A-Za-z][\w-]*$/.test(name)) problems.push(`${at}: names use letters, digits, _ and -`);
        if (!s || typeof s !== 'object' || Array.isArray(s)) { problems.push(`${at}: must be an object`); continue; }
        if (typeof s.hostname !== 'string' || !s.hostname.trim()) problems.push(`${at}.hostname: required`);
        else if (/[/\s]/.test(s.hostname) || /^https?:/i.test(s.hostname)) problems.push(`${at}.hostname: host name only (no scheme or path)`);
        if (s.path !== undefined && (typeof s.path !== 'string' || (s.path && !s.path.startsWith('/')))) problems.push(`${at}.path: starts with /`);
        if (s.port !== undefined && !(Number.isInteger(s.port) && s.port > 0 && s.port < 65536)) problems.push(`${at}.port: 1 – 65535`);
        if (s.secure !== undefined && typeof s.secure !== 'boolean') problems.push(`${at}.secure: true or false`);
        if (s.retry !== undefined && typeof s.retry !== 'boolean') problems.push(`${at}.retry: true or false`);
        if (!stringMap(s.headers)) problems.push(`${at}.headers: names to text values`);
        if (!stringMap(s.queries)) problems.push(`${at}.queries: names to text values`);
        const auth = s.authorization;
        if (auth !== undefined) {
            if (!auth || typeof auth !== 'object' || !AUTH_TYPES.includes(auth.type)) problems.push(`${at}.authorization.type: one of ${AUTH_TYPES.join(', ')}`);
            else {
                const need: Record<string, string[]> = { basic: ['username', 'password'], bearer: ['token'], 'api-key': ['key'], oauth2: ['hostname', 'token_path', 'client_id', 'client_secret'] };
                for (const field of need[auth.type]) if (typeof auth[field] !== 'string' || !auth[field]) problems.push(`${at}.authorization.${field}: required`);
            }
        }
        if (s.endpoints !== undefined) {
            if (!s.endpoints || typeof s.endpoints !== 'object' || Array.isArray(s.endpoints)) problems.push(`${at}.endpoints: must be an object`);
            else for (const [ep, e] of Object.entries(s.endpoints as Record<string, any>)) {
                const eat = `${at}.endpoints.${ep}`;
                if (!e || typeof e !== 'object') { problems.push(`${eat}: must be an object`); continue; }
                if (typeof e.path !== 'string' || !e.path.startsWith('/')) problems.push(`${eat}.path: starts with /`);
                if (e.method !== undefined && !METHODS.includes(String(e.method).toUpperCase())) problems.push(`${eat}.method: one of ${METHODS.join(', ')}`);
                if (e.retry !== undefined && typeof e.retry !== 'boolean') problems.push(`${eat}.retry: true or false`);
                if (!stringMap(e.headers)) problems.push(`${eat}.headers: names to text values`);
                if (!stringMap(e.queries)) problems.push(`${eat}.queries: names to text values`);
            }
        }
    }
    return problems;
}

/** config/rate-limit.json: path prefix → limit */
export function validateRateLimits(config: Record<string, any>): string[] {
    const problems: string[] = [];
    for (const [prefix, rule] of Object.entries(config)) {
        if (!prefix.startsWith('/')) problems.push(`${prefix}: paths start with /`);
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) { problems.push(`${prefix}: must be an object`); continue; }
        if (rule.maxRequests !== undefined && !(Number.isInteger(rule.maxRequests) && rule.maxRequests >= 0)) problems.push(`${prefix}.maxRequests: a whole number ≥ 0`);
        if (rule.windowMs !== undefined && !(Number.isInteger(rule.windowMs) && rule.windowMs > 0)) problems.push(`${prefix}.windowMs: milliseconds > 0`);
        if (rule.ignoreSuccessfulRequests !== undefined && typeof rule.ignoreSuccessfulRequests !== 'boolean') problems.push(`${prefix}.ignoreSuccessfulRequests: true or false`);
        const unknown = Object.keys(rule).filter((k) => !['maxRequests', 'windowMs', 'ignoreSuccessfulRequests'].includes(k));
        if (unknown.length) problems.push(`${prefix}: unknown setting(s) ${unknown.join(', ')}`);
    }
    return problems;
}

/** Problems with the content of a config file (JSON syntax, then its structure — the SAML metadata is XML) */
export function validateConfigFile(id: ConfigFileId, content: string): string[] {
    if (id === 'samlIdp') return validateIdpMetadata(content);
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (err) {
        return [`Invalid JSON: ${(err as Error).message}`];
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ['must be a JSON object'];
    switch (id) {
        case 'app': return validateAppConfig(parsed as Record<string, any>);
        case 'rateLimit': return validateRateLimits(parsed as Record<string, any>);
        case 'rls': return validateRlsRules(parsed);
        default: return [];
    }
}

export function readConfigText(root: string, id: ConfigFileId): string | null {
    try {
        return fs.readFileSync(path.join(root, CONFIG_FILES[id].path), 'utf8');
    } catch {
        return null;
    }
}

/** Write staged config files (already validated) — atomic, previous version as .bak */
export function writeConfigFiles(root: string, files: Partial<Record<ConfigFileId, string>>): string[] {
    const written: string[] = [];
    for (const [id, content] of Object.entries(files) as [ConfigFileId, string][]) {
        const file = path.join(root, CONFIG_FILES[id].path);
        writeEnvFile(file, content.endsWith('\n') ? content : `${content}\n`);
        fs.chmodSync(file, 0o644); // configuration, not a secret store — secrets stay in the env file
        written.push(CONFIG_FILES[id].path);
    }
    return written;
}
