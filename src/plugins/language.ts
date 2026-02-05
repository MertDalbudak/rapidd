import path from 'path';
import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

const ALLOWED_LANGUAGES: string[] = (() => {
    try {
        return require(path.join(process.cwd(), 'config', 'app.json')).languages || ['en-US'];
    } catch {
        return ['en-US'];
    }
})();

const SUPPORTED_LANGUAGES: string[] = (() => {
    try {
        const fs = require('fs');
        const path = require('path');
        const stringsPath = process.env.STRINGS_PATH || './strings';
        return fs.readdirSync(stringsPath).map((e: string) => path.parse(e).name);
    } catch {
        return ['en-US'];
    }
})();

/**
 * Parse Accept-Language header and return the best matching language
 */
function resolveLanguage(headerValue: string): string {
    const defaultLang = ALLOWED_LANGUAGES.find((allowed: string) =>
        SUPPORTED_LANGUAGES.find((avail: string) => avail.toLowerCase() === allowed.toLowerCase())
    ) || 'en-US';

    if (!headerValue || typeof headerValue !== 'string') return defaultLang;

    try {
        const languages = headerValue
            .toLowerCase()
            .split(',')
            .map((lang: string) => {
                const parts = lang.trim().split(';');
                const code = parts[0].trim();
                const quality = parts[1] ? parseFloat(parts[1].replace('q=', '')) : 1.0;
                return { code, quality };
            })
            .sort((a, b) => b.quality - a.quality);

        // Exact match
        for (const lang of languages) {
            const match = ALLOWED_LANGUAGES.find((a: string) => a.toLowerCase() === lang.code);
            if (match) return match;
        }

        // Language family match (e.g. "en-GB" → "en-US")
        for (const lang of languages) {
            const prefix = lang.code.split('-')[0];
            const match = ALLOWED_LANGUAGES.find((a: string) => a.toLowerCase().startsWith(prefix + '-'));
            if (match) return match;
        }
    } catch {
        /* fall through to default */
    }

    return defaultLang;
}

/**
 * Language resolution plugin.
 * Sets request.language based on cookie or Accept-Language header.
 */
const languagePlugin: FastifyPluginAsync = async (fastify) => {
    fastify.decorateRequest('language', 'en-US');

    fastify.addHook('onRequest', async (request) => {
        const cookieLang = (request as any).cookies?.['lang'];
        request.language = cookieLang || resolveLanguage(request.headers['accept-language'] || '');
    });
};

export default fp(languagePlugin, { name: 'rapidd-language' });
export { resolveLanguage, ALLOWED_LANGUAGES };
