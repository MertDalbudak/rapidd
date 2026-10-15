import type { DMMFField } from '../types';

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// PostgreSQL's accepted input forms: optional braces, a hyphen allowed after any group of four
const UUID = /^\{?[0-9a-f]{4}(-?[0-9a-f]{4}){7}\}?$/i;
// 2026-10-15, 2026-10-15T08:30, …:00.123Z, …+02:00 — groups: date, time, zone
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i;

/** `String @db.Uuid` — the database rejects anything that isn't a UUID */
function isUuidField(field: DMMFField): boolean {
    return Array.isArray(field.nativeType) && String(field.nativeType[0]).toLowerCase() === 'uuid';
}

/**
 * A key value as text that is the same however it was written — what the database returns and
 * what a client sends: dates as ISO text, numbers and decimals normalized, UUIDs lower case
 */
export function keyText(field: DMMFField | undefined, value: unknown): string {
    const parsed = parseScalar(field, value);
    if (parsed instanceof Date) return parsed.toISOString();
    if (field?.type === 'Decimal') return decimalText(String(parsed ?? value));
    if (field?.type === 'String' && isUuidField(field) && typeof parsed === 'string') return parsed.toLowerCase();
    return String(parsed ?? value);
}

/** '01.50' → '1.5', '-0.0' → '0' — plain decimal text without padding (other forms as they are) */
function decimalText(text: string): string {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
    if (!m) return text;
    const int = m[2].replace(/^0+(?=\d)/, '') || '0';
    const frac = (m[3] ?? '').replace(/0+$/, '');
    const sign = m[1] === '-' && (int !== '0' || frac) ? '-' : '';
    return sign + int + (frac ? '.' + frac : '');
}

/**
 * Parse a value — typically a string from a URL — as the scalar type of `field`.
 * Returns undefined when it doesn't fit: lenient parsing (parseInt('12abc') === 12) would
 * address a different record than the one asked for, and a malformed UUID would be a
 * database error instead of a client error. Types it doesn't know pass through.
 */
export function parseScalar(field: DMMFField | undefined, value: unknown): unknown {
    if (value === null || value === undefined || value === '') return undefined;
    const text = typeof value === 'string' ? value.trim() : null;

    if (field?.kind === 'enum') return typeof value === 'string' ? value : undefined;

    switch (field?.type) {
        case 'Int': {
            const n = typeof value === 'number' ? value : text !== null && INTEGER.test(text) ? Number(text) : NaN;
            return Number.isSafeInteger(n) ? n : undefined;
        }
        case 'BigInt':
            if (typeof value === 'bigint') return value;
            if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : undefined;
            return text !== null && INTEGER.test(text) ? BigInt(text) : undefined;
        case 'Float': {
            const n = typeof value === 'number' ? value : text !== null && DECIMAL.test(text) ? Number(text) : NaN;
            return Number.isFinite(n) ? n : undefined;
        }
        case 'Decimal':
            // Kept as a string — Prisma parses Decimal strings exactly, parseFloat would round
            if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
            return text !== null && DECIMAL.test(text) ? text : undefined;
        case 'Boolean':
            if (typeof value === 'boolean') return value;
            return text === 'true' ? true : text === 'false' ? false : undefined;
        case 'DateTime': {
            if (value instanceof Date) return isNaN(value.getTime()) ? undefined : value;
            // ISO 8601 only — Date would read "10" as 2001-10-01; without a zone: UTC, as stored
            const iso = text !== null ? ISO_DATETIME.exec(text) : null;
            if (!iso) return undefined;
            const date = new Date(iso[2] && !iso[3] ? `${text!.replace(' ', 'T')}Z` : text!.replace(' ', 'T'));
            return isNaN(date.getTime()) ? undefined : date;
        }
        case 'String': {
            const s = typeof value === 'string' ? value
                : typeof value === 'number' || typeof value === 'bigint' ? String(value) : undefined;
            return s !== undefined && isUuidField(field) && !UUID.test(s) ? undefined : s;
        }
        default:
            return value;
    }
}
