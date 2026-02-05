import { readdirSync } from 'fs';
import path from 'path';

const ROOT = process.env.ROOT || '';
const DEFAULT_STRINGS_PATH = ROOT ? path.join(ROOT, 'strings') : './strings';

/**
 * Singleton LanguageDict class for efficient translation management.
 * All dictionaries are loaded once at initialization and cached in memory.
 */
export class LanguageDict {
    private static _dictionaries: Record<string, Record<string, string>> = {};
    private static _available: string[] = [];
    private static _dictionaryPath: string | null = null;
    private static _defaultLanguage: string = 'en-US';
    private static _initialized: boolean = false;

    /**
     * Initialize the LanguageDict system
     */
    static initialize(dictionaryPath: string = DEFAULT_STRINGS_PATH, defaultLanguage: string = 'en-US'): void {
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
                        const dictPath = path.join(dictionaryPath, fileName);
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        this._dictionaries[langCode] = require(dictPath);
                        this._available.push(langCode);
                    } catch (error) {
                        console.error(`Failed to load dictionary for ${langCode}:`, (error as Error).message);
                    }
                }
            }

            this._initialized = true;
        } catch (error) {
            console.error('Failed to initialize LanguageDict:', (error as Error).message);
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

        let translated: string | undefined = dictionary[key];

        if (translated === undefined) {
            return key;
        }

        // Handle nested translations ({{key}} syntax)
        translated = translated.replace(/{{\w+}}/g, (match: string) => {
            const nestedKey = match.slice(2, -2);
            return this.get(nestedKey, data, lang);
        });

        // Handle parameter interpolation ({key} syntax)
        if (data !== null && typeof data === 'object') {
            translated = translated.replace(/\{(\w+)\}/g, (match: string, paramKey: string) => {
                return data[paramKey] !== undefined ? String(data[paramKey]) : match;
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
