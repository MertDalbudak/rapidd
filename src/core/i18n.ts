import { readdirSync } from 'fs';
import path from 'path';
import { Logger } from '../utils/Logger';

const ROOT = process.env.ROOT || '';
// Resolved to an absolute path — require() would treat a bare relative path as a package name
const DEFAULT_STRINGS_PATH = process.env.STRINGS_PATH || path.resolve(ROOT || process.cwd(), 'locales');
/** Language used when a request has none (DEFAULT_LANGUAGE, e.g. de_DE) */
const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || 'en_US';

/**
 * Singleton LanguageDict class for efficient translation management.
 * All dictionaries are loaded once at initialization and cached in memory.
 */
const RE_NESTED = /{{\w+}}/g;
const RE_PARAMS = /\{(\w+)\}/g;

export class LanguageDict {
    private static _dictionaries: Record<string, Record<string, string>> = {};
    private static _available: string[] = [];
    private static _dictionaryPath: string | null = null;
    private static _defaultLanguage: string = DEFAULT_LANGUAGE;
    private static _initialized: boolean = false;

    /**
     * Initialize the LanguageDict system
     */
    static initialize(dictionaryPath: string = DEFAULT_STRINGS_PATH, defaultLanguage: string = DEFAULT_LANGUAGE): void {
        if (this._initialized && this._dictionaryPath === dictionaryPath) {
            return;
        }

        this._dictionaryPath = dictionaryPath;
        this._defaultLanguage = defaultLanguage;
        this._dictionaries = {};
        this._available = [];

        try {
            const files = readdirSync(dictionaryPath);

            for (const fileName of files) {
                if (path.extname(fileName) === '.json') {
                    const langCode = path.parse(fileName).name;
                    try {
                        // Resolve to absolute so relative dictionary paths work regardless of cwd
                        const dictPath = path.resolve(dictionaryPath, fileName);
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        this._dictionaries[langCode] = require(dictPath);
                        this._available.push(langCode);
                    } catch (error) {
                        Logger.error(error as Error, { langCode });
                    }
                }
            }

            this._initialized = true;
        } catch (error) {
            Logger.error(error as Error);
            this._dictionaries = {};
            this._available = [];
        }
    }

    /**
     * Get a translated string with optional parameter interpolation
     */
    static get(key: string, data: Record<string, unknown> | null = null, language: string | null = null): string {
        if (!this._initialized) {
            this.initialize();
        }

        const lang = language || this._defaultLanguage;
        const dictionary = this._dictionaries[lang] || this._dictionaries[this._defaultLanguage] || {};

        // Per-key fallback: a partially translated locale falls back to the default
        // language for missing keys instead of leaking the raw key to clients
        let translated: string | undefined = dictionary[key] ?? this._dictionaries[this._defaultLanguage]?.[key];

        if (translated === undefined) {
            if (process.env.NODE_ENV !== 'production') {
                Logger.warn(`Missing i18n key: '${key}' (language: ${lang})`);
            }
            return key;
        }

        // Handle nested translations ({{key}} syntax)
        translated = translated.replace(RE_NESTED, (match: string) => {
            const nestedKey = match.slice(2, -2);
            return this.get(nestedKey, data, lang);
        });

        // Handle parameter interpolation ({key} syntax)
        if (data !== null && typeof data === 'object') {
            translated = translated.replace(RE_PARAMS, (match: string, paramKey: string) => {
                const value = data[paramKey];
                if (value === undefined) return match;
                if (Array.isArray(value)) return value.join(', ');
                // Objects would render as "[object Object]" — show their JSON instead
                if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                    try { return JSON.stringify(value); } catch { return match; }
                }
                return String(value);
            });
        }

        return translated;
    }

    /**
     * Get all available language codes
     */
    static getAvailableLanguages(): string[] {
        if (!this._initialized) {
            this.initialize();
        }
        return [...this._available];
    }

    /**
     * Get the entire dictionary for a specific language
     */
    static getDictionary(language: string): Record<string, string> {
        if (!this._initialized) {
            this.initialize();
        }
        return this._dictionaries[language] || this._dictionaries[this._defaultLanguage] || {};
    }

    /**
     * Check if a language is available
     */
    static hasLanguage(language: string): boolean {
        if (!this._initialized) {
            this.initialize();
        }
        return this._available.includes(language);
    }

    /** The language used when none is requested (DEFAULT_LANGUAGE, default en_US) */
    static get defaultLanguage(): string {
        return this._defaultLanguage;
    }

    /**
     * Reload dictionaries from disk
     */
    static reload(): void {
        this._initialized = false;
        this.initialize(this._dictionaryPath || DEFAULT_STRINGS_PATH, this._defaultLanguage);
    }

    // Instance-based API for backward compatibility
    private language: string;

    constructor(language: string) {
        if (!LanguageDict._initialized) {
            LanguageDict.initialize();
        }
        this.language = language;
    }

    get(key: string, data: Record<string, unknown> | null = null): string {
        return LanguageDict.get(key, data, this.language);
    }

    getDictionary(): Record<string, string> {
        return LanguageDict.getDictionary(this.language);
    }
}
