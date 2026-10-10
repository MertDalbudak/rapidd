import type { DMMFField } from '../types';

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// PostgreSQL's accepted input forms: optional braces, a hyphen allowed after any group of four
const UUID = /^\{?[0-9a-f]{4}(-?[0-9a-f]{4}){7}\}?$/i;

/** `String @db.Uuid` — the database rejects anything that isn't a UUID */
function isUuidField(field: DMMFField): boolean {
    return Array.isArray(field.nativeType) && String(field.nativeType[0]).toLowerCase() === 'uuid';
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
            const date = value instanceof Date ? value : text ? new Date(text) : null;
            return date && !isNaN(date.getTime()) ? date : undefined;
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
