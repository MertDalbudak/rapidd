/**
 * Exhaustive tests for boolean filter groups: OR(...) / AND(...).
 *
 * Covers: construction, case-insensitivity, arbitrary nesting, every leaf operator
 * inside groups, relations (to-one / list / FK rewrite), top-level mixing, splitter
 * correctness with arrays/nested groups, ACL-omit enforcement, DoS caps, error/edge
 * cases, and legacy backward-compatibility.
 *
 * Uses a rich mock schema (students -> school, courses; typed scalar/enum/bool/date fields).
 */

const OMIT: Record<string, string[]> = {}; // per-role omit overrides, set per test if needed

jest.mock('../../src/core/prisma', () => ({
    prisma: {},
    prismaTransaction: jest.fn(),
    getAcl: () => ({
        model: {
            students: {
                // non-admin cannot see 'notes'
                getOmitFields: (user: any) => (user?.role === 'admin' ? [] : ['notes']),
            },
            schools: {
                getOmitFields: (user: any) => (user?.role === 'admin' ? [] : ['secret_code']),
            },
            courses: {
                getOmitFields: () => [],
            },
        },
    }),
}));

jest.mock('../../src/core/dmmf', () => {
    const fields: Record<string, any> = {
        students: {
            id: { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true },
            name: { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: true },
            status: { name: 'status', kind: 'scalar', type: 'String', isList: false, isRequired: false },
            age: { name: 'age', kind: 'scalar', type: 'Int', isList: false, isRequired: false },
            gpa: { name: 'gpa', kind: 'scalar', type: 'Float', isList: false, isRequired: false },
            active: { name: 'active', kind: 'scalar', type: 'Boolean', isList: false, isRequired: false },
            enrolledAt: { name: 'enrolledAt', kind: 'scalar', type: 'DateTime', isList: false, isRequired: false },
            grade: { name: 'grade', kind: 'enum', type: 'Grade', isList: false, isRequired: false },
            notes: { name: 'notes', kind: 'scalar', type: 'String', isList: false, isRequired: false },
            schoolId: { name: 'schoolId', kind: 'scalar', type: 'Int', isList: false, isRequired: false },
            school: { name: 'school', kind: 'object', type: 'schools', isList: false, isRequired: false, relationFromFields: ['schoolId'], relationToFields: ['id'] },
            courses: { name: 'courses', kind: 'object', type: 'courses', isList: true, isRequired: false, relationFromFields: [], relationToFields: [] },
        },
        schools: {
            id: { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true },
            name: { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: true },
            city: { name: 'city', kind: 'scalar', type: 'String', isList: false, isRequired: false },
            secret_code: { name: 'secret_code', kind: 'scalar', type: 'String', isList: false, isRequired: false },
        },
        courses: {
            id: { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true },
            title: { name: 'title', kind: 'scalar', type: 'String', isList: false, isRequired: true },
        },
    };
    return {
        getFields: (m: string) => fields[m] || {},
        getScalarFields: (m: string) => {
            const out: Record<string, any> = {};
            for (const [k, v] of Object.entries(fields[m] || {})) if ((v as any).kind !== 'object') out[k] = v;
            return out;
        },
        getModel: (m: string) => (fields[m] ? { name: m, fields: Object.values(fields[m]) } : undefined),
        getPrimaryKey: () => 'id',
        getRelations: () => [],
        isListRelation: (parent: string, rel: string) => parent === 'students' && rel === 'courses',
        buildRelationships: (m: string) => {
            if (m === 'students') {
                return [
                    { name: 'school', object: 'schools', isList: false, field: 'schoolId', foreignKey: 'id' },
                    { name: 'courses', object: 'courses', isList: true, field: undefined, foreignKey: 'id' },
                ];
            }
            return [];
        },
    };
});

jest.mock('../../src/core/errors', () => {
    class MockErrorResponse extends Error {
        status_code: number;
        data: any;
        constructor(status_code: number, message: string, data: any = null) {
            super(message);
            this.status_code = status_code;
            this.data = data;
        }
    }
    return { ErrorResponse: MockErrorResponse };
});

import { QueryBuilder } from '../../src/orm/QueryBuilder';
import { createSystemUser } from '../../src/core/user';

describe('QueryBuilder boolean groups — OR()/AND()', () => {
    let qb: QueryBuilder;
    const admin = { id: 1, role: 'admin' };
    const user = { id: 42, role: 'user' };
    const system = createSystemUser({ id: 'sys' });

    beforeEach(() => {
        qb = new QueryBuilder('students');
    });

    // ── A. Basic construction ────────────────────────────────
    describe('construction', () => {
        it('OR of two leaves', () => {
            const r: any = qb.filter('OR(name=%a%,age=gt:18)');
            expect(r).toEqual({ OR: [{ name: { contains: 'a' } }, { age: { gt: 18 } }] });
        });

        it('AND of two leaves', () => {
            const r: any = qb.filter('AND(name=%a%,age=gt:18)');
            expect(r).toEqual({ AND: [{ name: { contains: 'a' } }, { age: { gt: 18 } }] });
        });

        it('OR of three leaves', () => {
            const r: any = qb.filter('OR(name=a,name=b,name=c)');
            expect(r.OR).toHaveLength(3);
        });

        it('single-leaf group wraps in a one-element array', () => {
            const r: any = qb.filter('OR(name=a)');
            expect(r).toEqual({ OR: [{ name: { equals: 'a' } }] });
        });

        it('AND with many leaves', () => {
            const r: any = qb.filter('AND(name=a,age=gt:1,age=lt:100,status=active)');
            expect(r.AND).toHaveLength(4);
        });
    });

    // ── B. Case-insensitivity ────────────────────────────────
    describe('case-insensitivity', () => {
        it.each(['OR', 'or', 'Or', 'oR'])('accepts %s(...)', (op) => {
            const r: any = qb.filter(`${op}(name=a,name=b)`);
            expect(r.OR).toHaveLength(2);
        });

        it.each(['AND', 'and', 'And', 'aNd'])('accepts %s(...)', (op) => {
            const r: any = qb.filter(`${op}(name=a,name=b)`);
            expect(r.AND).toHaveLength(2);
        });

        it('mixed case across nesting', () => {
            const r: any = qb.filter('Or(And(name=a,age=gt:1),name=b)');
            expect(r.OR[0].AND).toHaveLength(2);
        });
    });

    // ── C. Nesting ───────────────────────────────────────────
    describe('nesting', () => {
        it('AND(OR(...), leaf)', () => {
            const r: any = qb.filter('AND(OR(name=a,name=b),age=gt:18)');
            expect(r.AND[0].OR).toHaveLength(2);
            expect(r.AND[1]).toEqual({ age: { gt: 18 } });
        });

        it('OR(AND(...), AND(...))', () => {
            const r: any = qb.filter('OR(AND(name=a,age=gt:1),AND(name=b,age=lt:9))');
            expect(r.OR[0].AND).toHaveLength(2);
            expect(r.OR[1].AND).toHaveLength(2);
        });

        it('the canonical 3-deep example (a OR b) AND … structure', () => {
            const r: any = qb.filter(
                'OR(AND(OR(name=%max%,school.name=%Realschule%),status=not:inactive),OR(status=active,name=%erika%))'
            );
            expect(r.OR).toHaveLength(2);
            expect(r.OR[0].AND[0].OR[0]).toEqual({ name: { contains: 'max' } });
            expect(r.OR[0].AND[0].OR[1]).toEqual({ school: { name: { contains: 'Realschule' } } });
            expect(r.OR[0].AND[1]).toEqual({ status: { not: { equals: 'inactive' } } });
            expect(r.OR[1].OR[0]).toEqual({ status: { equals: 'active' } });
            expect(r.OR[1].OR[1]).toEqual({ name: { contains: 'erika' } });
        });

        it('4-level nesting is accepted', () => {
            const r: any = qb.filter('AND(OR(AND(OR(name=a,name=b),name=c),name=d),name=e)');
            expect(r.AND[0].OR[0].AND[0].OR).toHaveLength(2);
        });
    });

    // ── D. Leaf operator coverage inside groups ──────────────
    describe('leaf operators inside groups', () => {
        it('wildcards: contains / startsWith / endsWith', () => {
            const r: any = qb.filter('OR(name=%mid%,name=pre%,name=%suf)');
            expect(r.OR[0]).toEqual({ name: { contains: 'mid' } });
            expect(r.OR[1]).toEqual({ name: { startsWith: 'pre' } });
            expect(r.OR[2]).toEqual({ name: { endsWith: 'suf' } });
        });

        it('numeric operators', () => {
            const r: any = qb.filter('OR(age=gt:1,age=gte:2,age=lt:3,age=lte:4,age=eq:5,age=ne:6,age=between:7;8)');
            expect(r.OR[0]).toEqual({ age: { gt: 1 } });
            expect(r.OR[5]).toEqual({ age: { not: 6 } });
            expect(r.OR[6]).toEqual({ age: { gte: 7, lte: 8 } });
        });

        it('date operators', () => {
            const r: any = qb.filter('AND(enrolledAt=after:2024-01-01,enrolledAt=before:2024-12-31)');
            expect(r.AND[0].enrolledAt.gt).toBeInstanceOf(Date);
            expect(r.AND[1].enrolledAt.lt).toBeInstanceOf(Date);
        });

        it('boolean literal', () => {
            const r: any = qb.filter('AND(active=true,name=a)');
            expect(r.AND[0]).toEqual({ active: { equals: true } });
        });

        it('enum exact match (no wildcard)', () => {
            const r: any = qb.filter('OR(grade=A,grade=B)');
            expect(r.OR[0]).toEqual({ grade: { equals: 'A' } });
        });

        it('#NULL / not:#NULL', () => {
            const r: any = qb.filter('OR(notes=#NULL,notes=not:#NULL)', admin);
            expect(r.OR[0]).toEqual({ notes: { equals: null } });
            expect(r.OR[1]).toEqual({ notes: { not: { equals: null } } });
        });

        it('negation variants: string / number / array / between', () => {
            const r: any = qb.filter('AND(name=not:x,age=not:5,status=not:[a,b],age=not:between:1;2)');
            expect(r.AND[0]).toEqual({ name: { not: { equals: 'x' } } });
            expect(r.AND[1]).toEqual({ age: { not: { equals: 5 } } });
            expect(r.AND[2]).toEqual({ status: { notIn: ['a', 'b'] } });
            expect(r.AND[3].NOT).toBeDefined();
        });

        it('array IN filter', () => {
            const r: any = qb.filter('OR(id=[1,2,3],name=x)');
            expect(r.OR[0]).toEqual({ id: { in: [1, 2, 3] } });
        });

        it('wildcard-array becomes its own nested OR group', () => {
            const r: any = qb.filter('OR(name=[%a%,%b%],age=gt:1)');
            expect(r.OR[0]).toEqual({ AND: [{ OR: [{ name: { contains: 'a' } }, { name: { contains: 'b' } }] }] });
        });
    });

    // ── E. Relations inside groups ───────────────────────────
    describe('relations inside groups', () => {
        it('to-one relation path', () => {
            const r: any = qb.filter('OR(school.name=%x%,name=y)');
            expect(r.OR[0]).toEqual({ school: { name: { contains: 'x' } } });
        });

        it('list relation path uses some', () => {
            const r: any = qb.filter('OR(courses.title=%math%,name=y)');
            expect(r.OR[0]).toEqual({ courses: { some: { title: { contains: 'math' } } } });
        });

        it('relation-by-scalar FK rewrite inside a group', () => {
            const r: any = qb.filter('OR(school=5,name=y)');
            expect(r.OR[0]).toEqual({ schoolId: { equals: 5 } });
        });

        it('to-one relation #NULL inside a group', () => {
            const r: any = qb.filter('OR(school=#NULL,name=y)');
            expect(r.OR[0]).toEqual({ school: { is: null } });
        });
    });

    // ── F. Top-level mixing ──────────────────────────────────
    describe('top-level mixing', () => {
        it('leaf , group => AND', () => {
            const r: any = qb.filter('name=%a%,OR(age=1,age=2)');
            expect(r.AND).toHaveLength(2);
            expect(r.AND[0]).toEqual({ name: { contains: 'a' } });
            expect(r.AND[1].OR).toHaveLength(2);
        });

        it('group , leaf => AND', () => {
            const r: any = qb.filter('OR(age=1,age=2),name=%a%');
            expect(r.AND[0].OR).toHaveLength(2);
            expect(r.AND[1]).toEqual({ name: { contains: 'a' } });
        });

        it('group , group => AND', () => {
            const r: any = qb.filter('OR(age=1,age=2),AND(name=a,name=b)');
            expect(r.AND[0].OR).toBeDefined();
            expect(r.AND[1].AND).toBeDefined();
        });

        it('whitespace tolerance around commas', () => {
            const r: any = qb.filter('OR( name=a , age=gt:1 )');
            expect(r.OR).toHaveLength(2);
        });

        it('whitespace between operator and paren', () => {
            const r: any = qb.filter('OR (name=a,name=b)');
            expect(r.OR).toHaveLength(2);
        });
    });

    // ── G. Splitter correctness ──────────────────────────────
    describe('splitter (commas inside arrays / nested groups)', () => {
        it('array commas are not treated as group separators', () => {
            const r: any = qb.filter('OR(id=[1,2,3,4],name=x)');
            expect(r.OR[0]).toEqual({ id: { in: [1, 2, 3, 4] } });
            expect(r.OR).toHaveLength(2);
        });

        it('nested-group commas are not split at the wrong level', () => {
            const r: any = qb.filter('AND(OR(name=1,age=2,status=3),name=x)');
            expect(r.AND[0].OR).toHaveLength(3);
            expect(r.AND).toHaveLength(2);
        });

        it('multiple arrays across leaves', () => {
            const r: any = qb.filter('OR(id=[1,2],age=[3,4])');
            expect(r.OR[0]).toEqual({ id: { in: [1, 2] } });
            expect(r.OR[1]).toEqual({ age: { in: [3, 4] } });
        });
    });

    // ── H. ACL omit enforcement inside groups ────────────────
    describe('ACL omit enforcement', () => {
        it('rejects an omitted field used as a group leaf (403)', () => {
            expect(() => qb.filter('OR(name=a,notes=%x%)', user)).toThrow('field_not_filterable');
        });

        it('rejects an omitted field deep inside nested groups (403)', () => {
            expect(() => qb.filter('AND(OR(name=a,AND(age=1,notes=%x%)),name=b)', user)).toThrow('field_not_filterable');
        });

        it('rejects an omitted field on a related model inside a group (403)', () => {
            expect(() => qb.filter('OR(name=a,school.secret_code=%x%)', user)).toThrow('field_not_filterable');
        });

        it('allows the same fields for admin', () => {
            const r: any = qb.filter('OR(name=a,notes=%x%)', admin);
            expect(r.OR[1]).toEqual({ notes: { contains: 'x' } });
        });

        it('application role bypasses omit enforcement', () => {
            const r: any = qb.filter('OR(name=a,notes=%x%)', system);
            expect(r.OR[1]).toEqual({ notes: { contains: 'x' } });
        });

        it('no user provided => no enforcement (internal callers)', () => {
            const r: any = qb.filter('OR(name=a,notes=%x%)');
            expect(r.OR[1]).toEqual({ notes: { contains: 'x' } });
        });
    });

    // ── I. Error / edge cases ────────────────────────────────
    describe('errors', () => {
        it('empty group', () => {
            expect(() => qb.filter('OR()')).toThrow('empty_filter_group');
        });

        it('empty nested group', () => {
            expect(() => qb.filter('AND(name=a,OR())')).toThrow('empty_filter_group');
        });

        it('unbalanced — missing close paren', () => {
            expect(() => qb.filter('OR(name=a,AND(age=1)')).toThrow('unbalanced_filter_group');
        });

        it('unbalanced — extra close paren', () => {
            expect(() => qb.filter('OR(name=a))')).toThrow('unbalanced_filter_group');
        });

        it('nesting beyond the depth cap (400)', () => {
            let q = 'name=x';
            for (let i = 0; i < 11; i++) q = `OR(${q})`;
            expect(() => qb.filter(q)).toThrow('filter_group_too_deep');
        });

        it('too many leaf conditions across the tree (400)', () => {
            const leaves = Array.from({ length: 101 }, (_, i) => `age=${i}`).join(',');
            expect(() => qb.filter(`OR(${leaves})`)).toThrow('too_many_filter_conditions');
        });

        it('leaf without = inside a group (400)', () => {
            expect(() => qb.filter('OR(name=a,justtext)')).toThrow('invalid_filter_condition');
        });

        it('empty value inside a group (400) — would collapse to match-all', () => {
            expect(() => qb.filter('OR(name=a,name=)')).toThrow('empty_filter_value');
        });

        it('empty value on a relation path inside a group (400)', () => {
            expect(() => qb.filter('OR(name=a,courses.title=)')).toThrow('empty_filter_value');
        });

        it('invalid field inside a group (400)', () => {
            expect(() => qb.filter('OR(name=a,bogus=1)')).toThrow('invalid_filter_field');
        });

        it('object injection via array inside a group (400)', () => {
            expect(() => qb.filter('OR(id=[{"gt":5}],name=a)')).toThrow();
        });

        it('oversized array inside a group (400)', () => {
            const huge = '[' + Array.from({ length: 1001 }, (_, i) => i).join(',') + ']';
            expect(() => qb.filter(`OR(id=${huge},name=a)`)).toThrow('filter_array_too_large');
        });
    });

    // ── J. False-positive avoidance ──────────────────────────
    describe('does not misread leaves as groups', () => {
        it('a value that looks like a keyword is a plain equals', () => {
            const r: any = qb.filter('status=ORDER');
            expect(r).toEqual({ status: { equals: 'ORDER' } });
        });

        it('a wildcard value containing parens stays a leaf', () => {
            const r: any = qb.filter('name=%a(b)c%');
            expect(r).toEqual({ name: { contains: 'a(b)c' } });
        });

        it('legacy comma list without groups keeps the flat shape', () => {
            const r: any = qb.filter('name=%a%,age=gt:18,status=active');
            expect(r).toEqual({
                name: { contains: 'a' },
                age: { gt: 18 },
                status: { equals: 'active' },
            });
            expect(r.AND).toBeUndefined();
            expect(r.OR).toBeUndefined();
        });

        it('legacy single condition unchanged', () => {
            const r: any = qb.filter('name=%a%');
            expect(r).toEqual({ name: { contains: 'a' } });
        });
    });
});
