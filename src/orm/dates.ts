/**
 * Calendar-day arithmetic for date filters.
 *
 * A date-only filter value (`on:2024-03-15`, `createdAt=2024-03-15`) means a calendar DAY.
 * Which instants that day covers depends on the timezone it is read in:
 * - API_TIMEZONE (IANA name, e.g. `Europe/Berlin`) when set — server-independent;
 * - otherwise the server's own timezone (historical behavior).
 *
 * The day is always taken from the string itself. Round-tripping through `new Date('2024-03-15')`
 * (which is UTC midnight) and reading local components back shifted every date-only filter by
 * one day on servers west of UTC.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The configured filter timezone, or undefined for the server's local timezone */
export function filterTimeZone(): string | undefined {
    return process.env.API_TIMEZONE || undefined;
}

/** Validate an IANA timezone name (throws RangeError for unknown zones) */
export function assertTimeZone(timeZone: string): void {
    new Intl.DateTimeFormat('en-US', { timeZone });
}

/** Offset of `timeZone` from UTC at the given instant, in ms (positive east of UTC) */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    const wallClockAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return wallClockAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant a calendar day begins in `timeZone` (or the server's timezone) */
export function startOfDay(year: number, month: number, day: number, timeZone: string | undefined = filterTimeZone()): Date {
    if (!timeZone) return new Date(year, month - 1, day);
    const guess = Date.UTC(year, month - 1, day);
    // Two passes settle the offset across DST transitions
    let instant = guess - zoneOffsetMs(guess, timeZone);
    instant = guess - zoneOffsetMs(instant, timeZone);
    return new Date(instant);
}

/**
 * The half-open range [start, end) of the calendar day named by a YYYY-MM-DD string.
 * Returns null for anything that is not a valid date-only value.
 */
export function dayRange(value: string, timeZone: string | undefined = filterTimeZone()): { gte: Date; lt: Date } | null {
    const match = DATE_ONLY.exec(value.trim());
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    // Reject impossible dates (2024-02-30) instead of letting Date roll them over
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return { gte: startOfDay(year, month, day, timeZone), lt: startOfDay(year, month, day + 1, timeZone) };
}
