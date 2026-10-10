import { dayRange, startOfDay } from '../../src/orm/dates';

describe('calendar days', () => {
    it('reads the day from the string, in the given zone', () => {
        expect(dayRange('2024-01-15', 'Europe/Berlin')).toEqual({
            gte: new Date('2024-01-14T23:00:00.000Z'), lt: new Date('2024-01-15T23:00:00.000Z'),
        });
        expect(dayRange('2024-01-15', 'America/New_York')).toEqual({
            gte: new Date('2024-01-15T05:00:00.000Z'), lt: new Date('2024-01-16T05:00:00.000Z'),
        });
        expect(dayRange('2024-01-15', 'UTC')).toEqual({
            gte: new Date('2024-01-15T00:00:00.000Z'), lt: new Date('2024-01-16T00:00:00.000Z'),
        });
    });

    it('handles DST days (23 and 25 hours)', () => {
        const spring = dayRange('2024-03-31', 'Europe/Berlin')!;
        expect(spring.gte.toISOString()).toBe('2024-03-30T23:00:00.000Z');
        expect(spring.lt.toISOString()).toBe('2024-03-31T22:00:00.000Z');
        const autumn = dayRange('2024-10-27', 'Europe/Berlin')!;
        expect((autumn.lt.getTime() - autumn.gte.getTime()) / 3600_000).toBe(25);
    });

    it('rolls over month ends and rejects impossible dates', () => {
        expect(dayRange('2024-01-31', 'UTC')!.lt.toISOString()).toBe('2024-02-01T00:00:00.000Z');
        expect(dayRange('2024-02-30', 'UTC')).toBeNull();
        expect(dayRange('2024-1-5', 'UTC')).toBeNull();
        expect(dayRange('2024-01-15T10:00:00Z', 'UTC')).toBeNull();
    });

    it('uses the server timezone without a zone', () => {
        expect(startOfDay(2024, 1, 15, undefined).getTime()).toBe(new Date(2024, 0, 15).getTime());
    });
});

// ── Through the QueryBuilder (needs DMMF mocks) ──────────────────────────────
jest.mock('../../src/core/prisma', () => ({ rlsActive: () => false, prisma: {}, prismaTransaction: jest.fn(), getAcl: () => ({ model: {} }) }));
jest.mock('../../src/core/dmmf', () => ({
    getFields: jest.fn(() => ({
        createdAt: { name: 'createdAt', kind: 'scalar', type: 'DateTime', isRequired: true },
        birthday: { name: 'birthday', kind: 'scalar', type: 'DateTime', isRequired: false, nativeType: ['Date', []] },
    })),
    getScalarFields: jest.fn(() => ({})),
    getModel: jest.fn(() => ({ name: 'events', fields: [] })),
    getPrimaryKey: jest.fn(() => 'id'),
    buildRelationships: jest.fn(() => []),
    getRelations: jest.fn(() => []),
    isListRelation: jest.fn(() => false),
}));
import { QueryBuilder } from '../../src/orm/QueryBuilder';

describe('date filters and timezones', () => {
    const saved = { TZ: process.env.TZ, API_TIMEZONE: process.env.API_TIMEZONE };
    afterEach(() => {
        process.env.TZ = saved.TZ;
        if (saved.API_TIMEZONE === undefined) delete process.env.API_TIMEZONE; else process.env.API_TIMEZONE = saved.API_TIMEZONE;
    });

    it('on: selects the day named in the string, in the server timezone', () => {
        delete process.env.API_TIMEZONE;
        const where = new QueryBuilder('events').filter('createdAt=on:2024-03-15') as any;
        // Local midnight of the 15th — whatever the process timezone is
        expect(where.createdAt.gte.getTime()).toBe(new Date(2024, 2, 15).getTime());
        expect(where.createdAt.lt.getTime()).toBe(new Date(2024, 2, 16).getTime());
    });

    it('server-local days are right west of UTC too (the old code returned the previous day)', () => {
        // jest sandboxes process.env, so TZ changes need a real process
        const { execFileSync } = require('child_process');
        const script = `require('tsx/cjs'); const { dayRange } = require(${JSON.stringify(require.resolve('../../src/orm/dates'))});
            const old = new Date('2024-03-15'); // what the previous implementation started from
            process.stdout.write(JSON.stringify({ fixed: dayRange('2024-03-15').gte.toISOString(), old: new Date(old.getFullYear(), old.getMonth(), old.getDate()).toISOString() }));`;
        const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/New_York', API_TIMEZONE: '' } }).toString());
        expect(out.fixed).toBe('2024-03-15T04:00:00.000Z'); // midnight Mar 15 in New York (EDT)
        expect(out.old).toBe('2024-03-14T04:00:00.000Z');   // the bug: midnight Mar 14
    });

    it('API_TIMEZONE makes date filters server-independent', () => {
        process.env.TZ = 'Asia/Tokyo';
        process.env.API_TIMEZONE = 'Europe/Berlin';
        const qb = new QueryBuilder('events');
        expect((qb.filter('createdAt=2024-01-15') as any).createdAt).toEqual({
            gte: new Date('2024-01-14T23:00:00.000Z'), lt: new Date('2024-01-15T23:00:00.000Z'),
        });
        // date-only operands anchor to the zone's midnight
        expect((qb.filter('createdAt=before:2024-01-15') as any).createdAt).toEqual({ lt: new Date('2024-01-14T23:00:00.000Z') });
        // a datetime selects the zone-local day that contains it
        expect((qb.filter('createdAt=on:2024-01-15T23:30:00Z') as any).createdAt.gte.toISOString()).toBe('2024-01-15T23:00:00.000Z');
    });

    it('keeps exact datetime comparisons untouched', () => {
        process.env.API_TIMEZONE = 'Europe/Berlin';
        expect((new QueryBuilder('events').filter('createdAt=after:2024-01-15T10:00:00Z') as any).createdAt)
            .toEqual({ gt: new Date('2024-01-15T10:00:00.000Z') });
    });
});

describe('DATE columns (@db.Date) hold calendar days — no timezone', () => {
    const saved = process.env.API_TIMEZONE;
    beforeEach(() => { process.env.API_TIMEZONE = 'Europe/Berlin'; });
    afterEach(() => { if (saved === undefined) delete process.env.API_TIMEZONE; else process.env.API_TIMEZONE = saved; });
    const utc = (iso: string) => new Date(iso + 'T00:00:00.000Z');

    it('filters: the day itself (UTC midnight, as Prisma stores DATE values)', () => {
        const qb = new QueryBuilder('events');
        expect((qb.filter('birthday=2015-01-04') as any).birthday).toEqual({ gte: utc('2015-01-04'), lt: utc('2015-01-05') });
        expect((qb.filter('birthday=on:2015-01-04') as any).birthday).toEqual({ gte: utc('2015-01-04'), lt: utc('2015-01-05') });
        expect((qb.filter('birthday=before:2015-01-04') as any).birthday).toEqual({ lt: utc('2015-01-04') });
        expect((qb.filter('birthday=between:2015-01-01;2015-01-31') as any).birthday).toEqual({ gte: utc('2015-01-01'), lte: utc('2015-01-31') });
        expect((qb.filter('birthday=not:between:2015-01-01;2015-01-31') as any).NOT[0].AND).toEqual([
            { birthday: { gte: utc('2015-01-01') } }, { birthday: { lte: utc('2015-01-31') } }]);
        // Timestamps keep the API timezone
        expect((qb.filter('createdAt=2015-01-04') as any).createdAt.gte.toISOString()).toBe('2015-01-03T23:00:00.000Z');
    });

    it('writes: a date-only value becomes that day (DATE) or its start in the API timezone (timestamp)', () => {
        const qb = new QueryBuilder('events');
        const created: any = qb.create({ birthday: '2015-01-04', createdAt: '2024-01-01' });
        expect(created.birthday).toEqual(utc('2015-01-04'));
        expect(created.createdAt.toISOString()).toBe('2023-12-31T23:00:00.000Z');
        const updated: any = qb.update(1, { birthday: '1990-12-31', createdAt: '2024-01-01T10:00:00.000Z' });
        expect(updated.birthday).toEqual(utc('1990-12-31'));
        expect(updated.createdAt).toBe('2024-01-01T10:00:00.000Z');
        // Not a date: left for Prisma to reject (400 with the field named)
        expect((qb.create({ birthday: '2015-02-30' }) as any).birthday).toBe('2015-02-30');
    });
});
