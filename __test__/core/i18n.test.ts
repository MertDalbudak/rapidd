import path from 'path';
import fs from 'fs';
import { LanguageDict } from '../../src/core/i18n';

// Create temp string files for testing
const TEMP_STRINGS = path.join(__dirname, '__temp_strings__');

beforeAll(() => {
    fs.mkdirSync(TEMP_STRINGS, { recursive: true });
    fs.writeFileSync(
        path.join(TEMP_STRINGS, 'en-US.json'),
        JSON.stringify({
            hello: 'Hello',
            hello_user: 'Hello {name}',
            greeting: '{{hello}}, welcome!',
            nested_param: '{{hello_user}}, welcome!',
            not_found: 'Resource not found',
            duplicate_entry: 'Duplicate entry for {modelName}',
        })
    );
    fs.writeFileSync(
        path.join(TEMP_STRINGS, 'de-DE.json'),
        JSON.stringify({
            hello: 'Hallo',
            hello_user: 'Hallo {name}',
            not_found: 'Ressource nicht gefunden',
        })
    );
});

afterAll(() => {
    fs.rmSync(TEMP_STRINGS, { recursive: true, force: true });
});

describe('LanguageDict', () => {
    beforeEach(() => {
        // Force re-initialization for each test
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (LanguageDict)['_initialized'] = false;
        LanguageDict.initialize(TEMP_STRINGS, 'en-US');
    });

    describe('initialize()', () => {
        it('should load dictionaries from directory', () => {
            const languages = LanguageDict.getAvailableLanguages();
            expect(languages).toContain('en-US');
            expect(languages).toContain('de-DE');
        });

        it('should not re-initialize with same path', () => {
            const spy = jest.spyOn(fs, 'readdirSync');
            LanguageDict.initialize(TEMP_STRINGS, 'en-US');
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });
    });

    describe('get()', () => {
        it('should return translated string', () => {
            expect(LanguageDict.get('hello')).toBe('Hello');
        });

        it('should return key when translation missing', () => {
            expect(LanguageDict.get('unknown_key')).toBe('unknown_key');
        });

        it('should interpolate parameters', () => {
            expect(LanguageDict.get('hello_user', { name: 'Alice' })).toBe('Hello Alice');
        });

        it('should handle nested translations ({{key}})', () => {
            expect(LanguageDict.get('greeting')).toBe('Hello, welcome!');
        });

        it('should handle nested translations with parameters', () => {
            expect(LanguageDict.get('nested_param', { name: 'Bob' })).toBe('Hello Bob, welcome!');
        });

        it('should use specified language', () => {
            expect(LanguageDict.get('hello', null, 'de-DE')).toBe('Hallo');
            expect(LanguageDict.get('not_found', null, 'de-DE')).toBe('Ressource nicht gefunden');
        });

        it('should fall back to default language', () => {
            expect(LanguageDict.get('duplicate_entry', { modelName: 'users' }, 'fr-FR'))
                .toBe('Duplicate entry for users');
        });

        it('should keep unresolved params as-is', () => {
            expect(LanguageDict.get('hello_user', { wrong_key: 'x' })).toBe('Hello {name}');
        });
    });

    describe('hasLanguage()', () => {
        it('should return true for loaded languages', () => {
            expect(LanguageDict.hasLanguage('en-US')).toBe(true);
            expect(LanguageDict.hasLanguage('de-DE')).toBe(true);
        });

        it('should return false for unloaded languages', () => {
            expect(LanguageDict.hasLanguage('ja-JP')).toBe(false);
        });
    });

    describe('getDictionary()', () => {
        it('should return full dictionary for a language', () => {
            const dict = LanguageDict.getDictionary('en-US');
            expect(dict.hello).toBe('Hello');
            expect(dict.not_found).toBe('Resource not found');
        });

        it('should fall back to default language for unknown', () => {
            const dict = LanguageDict.getDictionary('xx-XX');
            expect(dict.hello).toBe('Hello');
        });
    });

    describe('instance API', () => {
        it('should work with constructor-based API', () => {
            const dict = new LanguageDict('de-DE');
            expect(dict.get('hello')).toBe('Hallo');
            expect(dict.get('hello_user', { name: 'Max' })).toBe('Hallo Max');
        });
    });

    describe('reload()', () => {
        it('should reload dictionaries from disk', () => {
            LanguageDict.reload();
            expect(LanguageDict.get('hello')).toBe('Hello');
        });
    });
});
