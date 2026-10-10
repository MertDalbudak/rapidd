import path from 'path';
import fs from 'fs';
import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { getAppConfig } from '../core/config';

const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || 'en_US';

const ALLOWED_LANGUAGES: string[] = Array.isArray(getAppConfig().languages) && getAppConfig().languages.length
    ? getAppConfig().languages
    : [DEFAULT_LANGUAGE];

const SUPPORTED_LANGUAGES: string[] = (() => {
    try {
        const stringsPath = process.env.STRINGS_PATH || './locales';
        return fs.readdirSync(stringsPath).map((e: string) => path.parse(e).name);
    } catch {
        return [DEFAULT_LANGUAGE];
    }
})();

const isUsable = (lang: string) =>
    ALLOWED_LANGUAGES.some((a) => a.toLowerCase() === lang.toLowerCase())
    && SUPPORTED_LANGUAGES.some((s) => s.toLowerCase() === lang.toLowerCase());

/** DEFAULT_LANGUAGE when allowed and available, else the first allowed language with a dictionary */
const DEFAULT_RESOLVED: string = (isUsable(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : undefined)
    || ALLOWED_LANGUAGES.find(isUsable)
    || DEFAULT_LANGUAGE;

/**
 * Match one language code against the allowed languages: exact match first
 * ("de-DE" / "de_DE" → de_DE), then by language family ("de", "de_AT" → de_DE).
 * Returns null for anything else — arbitrary client input never becomes request.language.
 */
function matchLanguage(code: string): string | null {
    if (!code || typeof code !== 'string' || code.length > 35) return null;
    const normalized = code.trim().toLowerCase().replace(/-/g, '_');
    const exact = ALLOWED_LANGUAGES.find((a) => a.toLowerCase() === normalized);
    if (exact) return exact;
    const prefix = normalized.split('_')[0];
    return ALLOWED_LANGUAGES.find((a) => a.toLowerCase().startsWith(prefix + '_')) ?? null;
}

/**
 * Parse Accept-Language header and return the best matching language
 */
function resolveLanguage(headerValue: string): string {
    if (!headerValue || typeof headerValue !== 'string') return DEFAULT_RESOLVED;

    try {
        const languages = headerValue
            .split(',')
            .map((lang: string) => {
                const parts = lang.trim().split(';');
                const quality = parts[1] ? parseFloat(parts[1].replace('q=', '')) : 1.0;
                return { code: parts[0].trim(), quality: Number.isNaN(quality) ? 0 : quality };
            })
            .sort((a, b) => b.quality - a.quality);

        // Exact matches across all preferences beat family matches
        for (const lang of languages) {
            const normalized = lang.code.toLowerCase().replace(/-/g, '_');
            const match = ALLOWED_LANGUAGES.find((a: string) => a.toLowerCase() === normalized);
            if (match) return match;
        }
        for (const lang of languages) {
            const match = matchLanguage(lang.code);
            if (match) return match;
        }
    } catch {
        /* fall through to default */
    }

    return DEFAULT_RESOLVED;
}

/**
 * Language resolution plugin.
 * Sets request.language from the `lang` cookie (when it names an allowed language) or the
 * Accept-Language header, falling back to DEFAULT_LANGUAGE.
 */
const languagePlugin: FastifyPluginAsync = async (fastify) => {
    fastify.decorateRequest('language', DEFAULT_RESOLVED);

    fastify.addHook('onRequest', async (request) => {
        const cookieLang = (request as any).cookies?.['lang'];
        request.language = (cookieLang && matchLanguage(cookieLang))
            || resolveLanguage(request.headers['accept-language'] || '');
    });
};

export default fp(languagePlugin, { name: 'rapidd-language' });
export { resolveLanguage, matchLanguage, ALLOWED_LANGUAGES };
