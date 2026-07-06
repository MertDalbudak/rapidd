/**
 * i18n coverage guard.
 *
 * Every message key the framework can emit MUST exist in every locale file —
 * a missing key degrades to sending the raw key to API clients at runtime with
 * no error, so regressions here are invisible without this test.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const LOCALES = path.join(ROOT, 'locales');

/** Keys emitted dynamically (computed at runtime, not extractable via regex) */
const DYNAMIC_KEYS = [
    'duplicate_entry',
    'duplicate_entry_no_value',
    'internal_server_error',
    'db_connection_failed',
    'data_validation_error',
];

/** Keys emitted by rapidd-build GENERATED code (routes of consuming apps) */
const GENERATED_CODE_KEYS = [
    'no_valid_session',
    'object_deleted_successfully',
];

function collectSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectSourceFiles(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

function extractUsedKeys(): Set<string> {
    const used = new Set<string>([...DYNAMIC_KEYS, ...GENERATED_CODE_KEYS]);
    const patterns = [
        /ErrorResponse\(\s*\d+\s*,\s*["']([a-z_0-9]+)["']/g,
        /LanguageDict\.get\(\s*["']([a-z_0-9]+)["']/g,
        /send(?:Error|Response)\(\s*\d+\s*,\s*["']([a-z_0-9]+)["']/g,
        // errorHandler assigns keys to a variable before translating
        /\bkey\s*=\s*["']([a-z_0-9]+)["']/g,
    ];
    for (const file of collectSourceFiles(SRC)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const pattern of patterns) {
            for (const match of text.matchAll(pattern)) {
                used.add(match[1]);
            }
        }
        // PRISMA_ERROR_MAP message values
        if (file.endsWith('QueryBuilder.ts')) {
            for (const match of text.matchAll(/message:\s*'([a-z_0-9]+)'/g)) {
                used.add(match[1]);
            }
        }
    }
    return used;
}

describe('i18n locale coverage', () => {
    const localeFiles = fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json'));
    const usedKeys = [...extractUsedKeys()].sort();
    const enKeys = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(LOCALES, 'en_US.json'), 'utf8'))));

    it('should find a plausible number of emitted keys', () => {
        expect(usedKeys.length).toBeGreaterThan(50);
    });

    it.each(localeFiles)('%s should define every emitted message key', (file) => {
        const dict = JSON.parse(fs.readFileSync(path.join(LOCALES, file), 'utf8'));
        const missing = usedKeys.filter((key) => !(key in dict));
        expect(missing).toEqual([]);
    });

    it.each(localeFiles)('%s should have the same key set as en_US (no parity drift)', (file) => {
        const dict = JSON.parse(fs.readFileSync(path.join(LOCALES, file), 'utf8'));
        const keys = new Set(Object.keys(dict));
        const missingFromLocale = [...enKeys].filter((k) => !keys.has(k)).sort();
        const extraInLocale = [...keys].filter((k) => !enKeys.has(k)).sort();
        expect({ missingFromLocale, extraInLocale }).toEqual({ missingFromLocale: [], extraInLocale: [] });
    });
});
