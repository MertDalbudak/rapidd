const { readdirSync } = require('fs');
const path = require('path');

const ROOT = process.env.ROOT;
const DEFAULT_STRINGS_PATH = ROOT ? path.join(ROOT, 'strings') : './strings';

/**
 * Singleton LanguageDict class for efficient translation management
 * All dictionaries are loaded once at initialization and cached in memory
 */
class LanguageDict {
    /**
     * Static storage for all loaded dictionaries
     * @private
     */
    static _dictionaries = {};
    static _available = [];
    static _dictionaryPath = null;
    static _defaultLanguage = 'en-US';
    static _initialized = false;

    /**
     * Initialize the LanguageDict system with dictionary path and default language
     * This is called automatically on first use, but can be called explicitly
     * @param {string} dictionaryPath - Path to the strings directory
     * @param {string} defaultLanguage - Default language code (e.g., 'en-US')
     */
    static initialize(dictionaryPath = DEFAULT_STRINGS_PATH, defaultLanguage = 'en-US') {
        if (this._initialized && this._dictionaryPath === dictionaryPath) {
            return; // Already initialized with same path
        }

        this._dictionaryPath = dictionaryPath;
        this._defaultLanguage = defaultLanguage;
        this._dictionaries = {};
        this._available = [];

        try {
            // Synchronously load all dictionaries at initialization
            const files = readdirSync(dictionaryPath);

            files.forEach(fileName => {
                if (path.extname(fileName) === '.json') {
                    const langCode = path.parse(fileName).name;
                    try {
                        const dictPath = path.join(dictionaryPath, fileName);
                        this._dictionaries[langCode] = require(dictPath);
                        this._available.push(langCode);
                    } catch (error) {
                        console.error(`Failed to load dictionary for ${langCode}:`, error.message);
                    }
                }
            });

            this._initialized = true;
        } catch (error) {
            console.error('Failed to initialize LanguageDict:', error.message);
            this._dictionaries = {};
            this._available = [];
        }
    }

    /**
     * Get a translated string with optional parameter interpolation
     * @param {string} key - Translation key
     * @param {Object|null} data - Optional data for parameter replacement
     * @param {string} language - Language code (defaults to initialized default)
     * @returns {string} Translated string or key if not found
     */
    static get(key, data = null, language = null) {
        // Ensure initialized
        if (!this._initialized) {
            this.initialize();
        }

        const lang = language || this._defaultLanguage;
        const dictionary = this._dictionaries[lang] || this._dictionaries[this._defaultLanguage] || {};

        let translated = dictionary[key];

        // Return key if translation not found
        if (translated === undefined) {
            return key;
        }

        // Handle nested translations ({{key}} syntax)
        translated = translated.replace(/{{\w+}}/g, (match) => {
            const nestedKey = match.slice(2, -2);
            return this.get(nestedKey, data, lang);
        });

        // Handle parameter interpolation ({key} syntax)
        if (data !== null && typeof data === 'object') {
            translated = translated.replace(/\{(\w+)\}/g, (match, paramKey) => {
                return data[paramKey] !== undefined ? data[paramKey] : match;
            });
        }

        return translated;
    }

    /**
     * Get all available language codes
     * @returns {string[]} Array of language codes
     */
    static getAvailableLanguages() {
        if (!this._initialized) {
            this.initialize();
        }
        return [...this._available];
    }

    /**
     * Get the entire dictionary for a specific language
     * @param {string} language - Language code
     * @returns {Object} Dictionary object
     */
    static getDictionary(language) {
        if (!this._initialized) {
            this.initialize();
        }
        return this._dictionaries[language] || this._dictionaries[this._defaultLanguage] || {};
    }

    /**
     * Check if a language is available
     * @param {string} language - Language code
     * @returns {boolean}
     */
    static hasLanguage(language) {
        if (!this._initialized) {
            this.initialize();
        }
        return this._available.includes(language);
    }

    /**
     * Reload dictionaries from disk (useful for development/hot-reload)
     */
    static reload() {
        this._initialized = false;
        this.initialize(this._dictionaryPath, this._defaultLanguage);
    }

    /**
     * Legacy instance-based API for backward compatibility
     * Creates a lightweight wrapper around static methods
     * @param {string} language - Language code
     */
    constructor(language) {
        if (!LanguageDict._initialized) {
            LanguageDict.initialize();
        }
        this.language = language;
    }

    /**
     * Instance method for getting translations
     * @param {string} key - Translation key
     * @param {Object|null} data - Optional data for parameter replacement
     * @returns {string} Translated string
     */
    get(key, data = null) {
        return LanguageDict.get(key, data, this.language);
    }

    /**
     * Get the dictionary for this instance's language
     * @returns {Object} Dictionary object
     */
    getDictionary() {
        return LanguageDict.getDictionary(this.language);
    }
}

/**
 * Factory function for backward compatibility with old API
 * @deprecated Use LanguageDict class directly instead
 * @param {string} dictionaryPath - Path to strings directory
 * @param {string} defaultLanguage - Default language code
 * @returns {typeof LanguageDict} LanguageDict class
 */
module.exports = function(dictionaryPath = DEFAULT_STRINGS_PATH, defaultLanguage = 'en-US') {
    LanguageDict.initialize(dictionaryPath, defaultLanguage);
    return LanguageDict;
};

// Also export the class directly for modern usage
module.exports.LanguageDict = LanguageDict;
