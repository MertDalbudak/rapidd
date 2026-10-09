/**
 * Tests for the TypeScript QueryBuilder.
 * Validates filter parsing, include building, create/update transforms,
 * immutability, error handling, and omit logic.
 */

// Mock dependencies
jest.mock('../../src/core/prisma', () => ({
    rlsActive: () => false,
    prisma: {},
    prismaTransaction: jest.fn(),
    getAcl: () => ({
        model: {
            messages: {
                getAccessFilter: (user: any) => user?.role === 'admin' ? {} : { userId: user?.id },
                getOmitFields: (user: any) => user?.role === 'admin' ? [] : ['internal_notes'],
                getWritableFields: (user: any) => user?.role === 'restricted' ? ['content'] : null,
                canCreate: () => true,
            },
            secret_docs: {
                getAccessFilter: () => false,
            },
            message_attachments: {
                // role-gated nested create target — used to test the system-user bypass on nested creates
                canCreate: (user: any) => user?.role === 'admin',
            },
        },
    }),
}));

jest.mock('../../src/core/dmmf', () => ({
    getModel: jest.fn((name: string) => {
        const models: Record<string, any> = {
            messages: {
                name: 'messages',
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'content', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'userId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'createdAt', kind: 'scalar', type: 'DateTime', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'internal_notes', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: false },
                    { name: 'user', kind: 'object', type: 'users', isList: false, isRequired: false, isId: false, isUnique: false, relationFromFields: ['userId'], relationToFields: ['id'], relationName: 'MessagesToUsers' },
                    { name: 'attachments', kind: 'object', type: 'message_attachments', isList: true, isRequired: false, isId: false, isUnique: false, relationFromFields: [], relationToFields: [], relationName: 'MessagesToAttachments' },
                ],
                primaryKey: null,
            },
            users: {
                name: 'users',
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'email', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: true },
                    // 1:n — parent side has relationFromFields: [] (FK lives on messages.userId)
                    { name: 'messages', kind: 'object', type: 'messages', isList: true, isRequired: false, isId: false, isUnique: false, relationFromFields: [], relationToFields: [], relationName: 'MessagesToUsers' },
                ],
                primaryKey: null,
            },
            message_attachments: {
                name: 'message_attachments',
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'url', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'messageId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'message', kind: 'object', type: 'messages', isList: false, isRequired: false, isId: false, isUnique: false, relationFromFields: ['messageId'], relationToFields: ['id'], relationName: 'MessagesToAttachments' },
                ],
                primaryKey: null,
            },
        };
        return models[name] || null;
    }),
    getFields: jest.fn((name: string) => {
        const fields: Record<string, any> = {
            messages: {
                id: { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true },
                content: { name: 'content', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
                userId: { name: 'userId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false },
                createdAt: { name: 'createdAt', kind: 'scalar', type: 'DateTime', isList: false, isRequired: true, isId: false },
                internal_notes: { name: 'internal_notes', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false },
                user: { name: 'user', kind: 'object', type: 'users', isList: false, isRequired: false, isId: false, relationFromFields: ['userId'], relationToFields: ['id'], relationName: 'MessagesToUsers' },
                attachments: { name: 'attachments', kind: 'object', type: 'message_attachments', isList: true, isRequired: false, isId: false, relationFromFields: [], relationToFields: [], relationName: 'MessagesToAttachments' },
                secret: { name: 'secret', kind: 'object', type: 'secret_docs', isList: false, isRequired: false, isId: false, relationFromFields: ['secretId'], relationToFields: ['id'], relationName: 'MessagesToSecretDocs' },
            },
            secret_docs: {
                id: { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true },
                data: { name: 'data', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
            },
            users: {
                id: { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true },
                name: { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
                email: { name: 'email', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
                messages: { name: 'messages', kind: 'object', type: 'messages', isList: true, isRequired: false, isId: false, relationFromFields: [], relationToFields: [], relationName: 'MessagesToUsers' },
            },
            message_attachments: {
                id: { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true },
                url: { name: 'url', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
                messageId: { name: 'messageId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false },
                message: { name: 'message', kind: 'object', type: 'messages', isList: false, isRequired: false, isId: false, relationFromFields: ['messageId'], relationToFields: ['id'], relationName: 'MessagesToAttachments' },
            },
        };
        return fields[name] || {};
    }),
    getScalarFields: jest.fn((name: string) => {
        const fields: Record<string, any> = {
            messages: {
                id: { name: 'id', kind: 'scalar', type: 'Int' },
                content: { name: 'content', kind: 'scalar', type: 'String' },
                userId: { name: 'userId', kind: 'scalar', type: 'Int' },
                createdAt: { name: 'createdAt', kind: 'scalar', type: 'DateTime' },
                internal_notes: { name: 'internal_notes', kind: 'scalar', type: 'String' },
            },
            users: {
                id: { name: 'id', kind: 'scalar', type: 'Int' },
                name: { name: 'name', kind: 'scalar', type: 'String' },
                email: { name: 'email', kind: 'scalar', type: 'String' },
            },
            message_attachments: {
                id: { name: 'id', kind: 'scalar', type: 'Int' },
                url: { name: 'url', kind: 'scalar', type: 'String' },
                messageId: { name: 'messageId', kind: 'scalar', type: 'Int' },
            },
        };
        return fields[name] || {};
    }),
    getPrimaryKey: jest.fn((name: string) => {
        if (name === 'company_member_invites') return ['email', 'companyId'];
        return 'id';
    }),
    getRelations: jest.fn(() => []),
    isListRelation: jest.fn((parent: string, rel: string) => {
        // Match real DMMF: return true for 1:n parent-side relations
        const listRelations: Record<string, string[]> = {
            messages: ['attachments'],
            users: ['messages'],
        };
        return listRelations[parent]?.includes(rel) ?? false;
    }),
    getRelationInfo: jest.fn(),
    buildRelationships: jest.fn((name: string) => {
        if (name === 'messages') {
            return [
                // n:1 — child side: field is the FK column on this model
                { name: 'user', object: 'users', isList: false, field: 'userId', foreignKey: 'id' },
                // 1:n — parent side: field is undefined (FK lives on message_attachments.messageId)
                { name: 'attachments', object: 'message_attachments', isList: true, field: undefined, foreignKey: 'id' },
                // n:1 to a model whose ACL denies access entirely
                { name: 'secret', object: 'secret_docs', isList: false, field: 'secretId', foreignKey: 'id' },
            ];
        }
        if (name === 'users') {
            return [
                // 1:n — parent side: field is undefined (FK lives on messages.userId)
                { name: 'messages', object: 'messages', isList: true, field: undefined, foreignKey: 'id' },
            ];
        }
        if (name === 'message_attachments') {
            return [
                // n:1 — child side: field is the FK column on this model
                { name: 'message', object: 'messages', isList: false, field: 'messageId', foreignKey: 'id' },
            ];
        }
        return [];
    }),
}));

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

describe('QueryBuilder (TypeScript)', () => {
    let qb: QueryBuilder;

    beforeEach(() => {
        qb = new QueryBuilder('messages');
    });

    describe('constructor', () => {
        it('should create instance with model name', () => {
            expect(qb).toBeInstanceOf(QueryBuilder);
        });
    });

    describe('select()', () => {
        it('should return all scalar fields for null/undefined input', () => {
            // When no fields specified, select returns all scalar fields
            const result = qb.select(null);
            expect(result).toBeDefined();
            expect(Object.keys(result).length).toBeGreaterThan(0);
            expect(result.id).toBe(true);
            expect(result.content).toBe(true);
        });

        it('should build select from string array', () => {
            const result = qb.select(['id', 'content']);
            expect(result).toEqual({ id: true, content: true });
        });
    });

    describe('filter()', () => {
        it('should return empty object for empty input', () => {
            expect(qb.filter('')).toEqual({});
        });

        it('should 400 (not 500 crash) on numeric between: with a single value', () => {
            expect(() => qb.filter('userId=between:40')).toThrow('between_requires_two_values');
        });

        it('should accept numeric between: with two values', () => {
            const r: any = qb.filter('userId=between:40;60');
            expect(r.userId).toEqual({ gte: 40, lte: 60 });
        });

        it('system user bypasses read-side omit (getRelatedOmit returns {})', () => {
            // internal_notes is omitted for non-admins; a system user should see it (full ACL bypass)
            expect(qb.getRelatedOmit('messages', createSystemUser())).toEqual({});
            expect(qb.getRelatedOmit('messages', { id: 1, role: 'user' })).toEqual({ internal_notes: true });
        });

        it('system user bypasses canCreate on NESTED relation creates', () => {
            // message_attachments.canCreate is admin-only; system user must not be blocked
            expect(() => qb.create({ content: 'x', attachments: [{ url: 'a' }] }, createSystemUser())).not.toThrow();
        });

        it('non-admin is still blocked by canCreate on nested creates', () => {
            expect(() => qb.create({ content: 'x', attachments: [{ url: 'a' }] }, { id: 1, role: 'user' }))
                .toThrow('no_permission_to_create');
        });

        it('should parse simple key-value filters', () => {
            const result: any = qb.filter('userId=5');
            expect(result).toBeDefined();
            expect(result.userId).toBeDefined();
        });

        it('should handle numeric operators', () => {
            const result: any = qb.filter('userId=gt:5');
            expect(result).toBeDefined();
            expect(result.userId).toBeDefined();
            expect(result.userId.gt).toBe(5);
        });

        it('should handle null string values', () => {
            const result: any = qb.filter('internal_notes=null');
            expect(result).toBeDefined();
            // The filter parses "null" as a string equals check
            expect(result.internal_notes).toBeDefined();
        });

        it('should handle not: negation on numeric fields', () => {
            const result: any = qb.filter('userId=not:5');
            expect(result.userId).toEqual({ not: { equals: 5 } });
        });

        it('should reject non-numeric values on numeric fields', () => {
            expect(() => qb.filter('userId=!5')).toThrow();
            expect(() => qb.filter('userId=abc')).toThrow();
        });

        it('should handle wildcard string filters', () => {
            const result: any = qb.filter('content=*hello*');
            expect(result).toBeDefined();
            expect(result.content).toBeDefined();
        });

        it('should handle array values', () => {
            const result: any = qb.filter('userId=[1,2,3]');
            expect(result).toBeDefined();
            expect(result.userId).toBeDefined();
        });

        it('should handle date range filters', () => {
            // between uses semicolons as separator
            const result: any = qb.filter('createdAt=between:2024-01-01;2024-12-31');
            expect(result).toBeDefined();
            expect(result.createdAt).toBeDefined();
        });

        it('should handle #NULL on nullable scalar field', () => {
            const result: any = qb.filter('internal_notes=#NULL');
            expect(result.internal_notes).toEqual({ equals: null });
        });

        it('should handle not:#NULL on nullable scalar field', () => {
            const result: any = qb.filter('internal_notes=not:#NULL');
            expect(result.internal_notes).toEqual({ not: { equals: null } });
        });

        it('should throw for #NULL on non-nullable scalar field', () => {
            expect(() => qb.filter('content=#NULL')).toThrow();
        });

        it('should skip not:#NULL on non-nullable scalar field', () => {
            const result: any = qb.filter('content=not:#NULL');
            expect(result.content).toBeUndefined();
        });

        it('should use { is: null } for #NULL on relation field', () => {
            const result: any = qb.filter('user=#NULL');
            expect(result.user).toEqual({ is: null });
        });

        it('should use { isNot: null } for not:#NULL on relation field', () => {
            const result: any = qb.filter('user=not:#NULL');
            expect(result.user).toEqual({ isNot: null });
        });

        it('should use { none: {} } for #NULL on list relation field', () => {
            // List relations can't be null — "no related rows" is { none: {} } in Prisma
            const result: any = qb.filter('attachments=#NULL');
            expect(result.attachments).toEqual({ none: {} });
        });

        it('should use { some: {} } for not:#NULL on list relation field', () => {
            const result: any = qb.filter('attachments=not:#NULL');
            expect(result.attachments).toEqual({ some: {} });
        });

        it('should skip empty filter value on a top-level scalar (legacy optional param)', () => {
            const result: any = qb.filter('content=');
            expect(result.content).toBeUndefined();
        });

        it('should still skip empty scalar alongside real conditions', () => {
            const result: any = qb.filter('content=,userId=5');
            expect(result.content).toBeUndefined();
            expect(result.userId).toEqual({ equals: 5 });
        });

        it('should reject an empty value on a relation path (would leave a dangling some:{})', () => {
            expect(() => qb.filter('attachments.url=')).toThrow('empty_filter_value');
        });

        // ── 1:n relation filtering (some wrapper) ──────────────
        it('should wrap 1:n list relation filter with { some: {} } (parent side, field=undefined)', () => {
            const result: any = qb.filter('attachments.url=%test%');
            expect(result.attachments).toBeDefined();
            expect(result.attachments.some).toBeDefined();
            expect(result.attachments.some.url).toEqual({ contains: 'test' });
        });

        it('should wrap 1:n list relation filter with { some: {} } using isListRelation fallback', () => {
            // users→messages is isList:true with field:undefined — tests isListRelation mock
            const usersQb = new QueryBuilder('users');
            const result: any = usersQb.filter('messages.content=%hello%');
            expect(result.messages).toBeDefined();
            expect(result.messages.some).toBeDefined();
            expect(result.messages.some.content).toEqual({ contains: 'hello' });
        });

        it('should NOT wrap n:1 relation filter with some', () => {
            const result: any = qb.filter('user.name=John');
            expect(result.user).toBeDefined();
            expect(result.user.some).toBeUndefined();
            expect(result.user.name).toEqual({ equals: 'John' });
        });

        it('should handle not: operator inside 1:n relation filter', () => {
            const result: any = qb.filter('attachments.url=not:deleted');
            expect(result.attachments).toBeDefined();
            expect(result.attachments.some).toBeDefined();
            expect(result.attachments.some.url).toEqual({ not: { equals: 'deleted' } });
        });

        it('should handle numeric operator inside 1:n relation filter', () => {
            const usersQb = new QueryBuilder('users');
            const result: any = usersQb.filter('messages.userId=gt:5');
            expect(result.messages).toBeDefined();
            expect(result.messages.some).toBeDefined();
            expect(result.messages.some.userId).toEqual({ gt: 5 });
        });

        it('should combine multiple filters on the same 1:n relation into one some block', () => {
            const result: any = qb.filter('attachments.url=%test%,attachments.messageId=gt:10');
            expect(result.attachments).toBeDefined();
            expect(result.attachments.some).toBeDefined();
            expect(result.attachments.some.url).toEqual({ contains: 'test' });
            expect(result.attachments.some.messageId).toEqual({ gt: 10 });
        });

        // ── Type-aware filtering ────────────────────────────────
        it('should keep numeric-looking values as strings on String fields', () => {
            const result: any = qb.filter('content=12345');
            expect(result.content).toEqual({ equals: '12345' });
        });

        it('should keep boolean literals as strings on String fields', () => {
            const result: any = qb.filter('content=true');
            expect(result.content).toEqual({ equals: 'true' });
        });

        it('should keep date-looking values as strings on String fields', () => {
            const result: any = qb.filter('content=2024-01-01');
            expect(result.content).toEqual({ equals: '2024-01-01' });
        });

        it('should coerce array values to numbers on numeric fields', () => {
            const result: any = qb.filter('userId=[1,2,3]');
            expect(result.userId).toEqual({ in: [1, 2, 3] });
        });

        it('should reject non-numeric array values on numeric fields', () => {
            expect(() => qb.filter('userId=[1,abc]')).toThrow();
        });

        it('should keep array values as strings on String fields', () => {
            const result: any = qb.filter('content=[hello,world]');
            expect(result.content).toEqual({ in: ['hello', 'world'] });
        });

        it('should group wildcard arrays per field: (a OR b) AND (c OR d)', () => {
            const result: any = qb.filter('content=[%a%,%b%],internal_notes=[%c%,%d%]');
            expect(result.OR).toBeUndefined();
            expect(result.AND).toHaveLength(2);
            expect(result.AND[0]).toEqual({ OR: [{ content: { contains: 'a' } }, { content: { contains: 'b' } }] });
            expect(result.AND[1]).toEqual({ OR: [{ internal_notes: { contains: 'c' } }, { internal_notes: { contains: 'd' } }] });
        });

        it('should nest a single wildcard array as its own OR group', () => {
            const result: any = qb.filter('content=[%a%,%b%]');
            expect(result.AND).toEqual([{ OR: [{ content: { contains: 'a' } }, { content: { contains: 'b' } }] }]);
        });

        it('should combine a wildcard array group with plain field filters', () => {
            const result: any = qb.filter('content=[%a%,%b%],userId=5');
            expect(result.AND).toHaveLength(1);
            expect(result.userId).toEqual({ equals: 5 });
        });

        it('should not clobber NOT groups across fields (not:[..] on two fields)', () => {
            const result: any = qb.filter('content=not:[%a%],internal_notes=not:[%b%]', { id: 1, role: 'admin' });
            expect(result.NOT).toHaveLength(2);
            expect(result.NOT[0]).toEqual({ content: { contains: 'a' } });
            expect(result.NOT[1]).toEqual({ internal_notes: { contains: 'b' } });
        });

        // ── Boolean groups: OR(...) / AND(...) ──────────────────
        it('should parse a top-level OR group', () => {
            const result: any = qb.filter('OR(content=%a%,userId=5)');
            expect(result.OR).toHaveLength(2);
            expect(result.OR[0]).toEqual({ content: { contains: 'a' } });
            expect(result.OR[1]).toEqual({ userId: { equals: 5 } });
        });

        it('should accept lowercase and(...)/or(...)', () => {
            const result: any = qb.filter('and(content=%a%,userId=5)');
            expect(result.AND).toHaveLength(2);
        });

        it('should parse the nested example: OR(AND(OR(..),..),OR(..))', () => {
            const result: any = qb.filter(
                'OR(AND(OR(content=%max%,user.name=%Acme%),content=not:inactive),OR(userId=5,content=%erika%))'
            );
            expect(result.OR).toHaveLength(2);
            // OR[0] = AND( OR(content, user.name), content!=inactive )
            expect(result.OR[0].AND).toHaveLength(2);
            expect(result.OR[0].AND[0].OR[0]).toEqual({ content: { contains: 'max' } });
            expect(result.OR[0].AND[0].OR[1]).toEqual({ user: { name: { contains: 'Acme' } } });
            expect(result.OR[0].AND[1]).toEqual({ content: { not: { equals: 'inactive' } } });
            // OR[1] = OR(userId=5, content~erika)
            expect(result.OR[1].OR[0]).toEqual({ userId: { equals: 5 } });
            expect(result.OR[1].OR[1]).toEqual({ content: { contains: 'erika' } });
        });

        it('should keep array values intact inside groups (commas not split)', () => {
            const result: any = qb.filter('OR(userId=[1,2,3],content=%x%)');
            expect(result.OR[0]).toEqual({ userId: { in: [1, 2, 3] } });
        });

        it('should AND multiple top-level expressions when one is a group', () => {
            const result: any = qb.filter('content=%a%,OR(userId=1,userId=2)');
            expect(result.AND).toHaveLength(2);
            expect(result.AND[0]).toEqual({ content: { contains: 'a' } });
            expect(result.AND[1].OR).toHaveLength(2);
        });

        it('should enforce ACL omit inside boolean groups', () => {
            expect(() => qb.filter('OR(content=%a%,internal_notes=%x%)', { id: 7, role: 'user' }))
                .toThrow('field_not_filterable');
        });

        it('should reject an empty group', () => {
            expect(() => qb.filter('OR()')).toThrow('empty_filter_group');
        });

        it('should reject unbalanced parentheses', () => {
            expect(() => qb.filter('OR(content=%a%,AND(userId=1)')).toThrow('unbalanced_filter_group');
        });

        it('should reject groups nested beyond the depth cap', () => {
            let q = 'userId=1';
            for (let i = 0; i < 11; i++) q = `OR(${q})`;
            expect(() => qb.filter(q)).toThrow('filter_group_too_deep');
        });

        it('should not treat a field literally named similarly as a group', () => {
            // 'content=or(x)' is a leaf whose VALUE contains 'or(' — not a group
            const result: any = qb.filter('content=ORDER');
            expect(result.content).toEqual({ equals: 'ORDER' });
        });

        // ── Hardening: array/object injection + DoS guards ──────
        it('should reject object elements smuggled via JSON array syntax', () => {
            expect(() => qb.filter('userId=[{"gt":5}]')).toThrow();
        });

        it('should reject nested arrays in filter arrays', () => {
            expect(() => qb.filter('userId=[[1,2],[3]]')).toThrow();
        });

        it('should reject arrays larger than the configured cap', () => {
            const huge = '[' + Array.from({ length: 1001 }, (_, i) => i).join(',') + ']';
            expect(() => qb.filter(`userId=${huge}`)).toThrow('filter_array_too_large');
        });

        it('should reject too many filter conditions', () => {
            const many = Array.from({ length: 101 }, (_, i) => `userId=${i}`).join(',');
            expect(() => qb.filter(many)).toThrow('too_many_filter_conditions');
        });

        it('should reject relation paths deeper than the cap', () => {
            const deep = Array.from({ length: 11 }, () => 'user').join('.') + '.name';
            expect(() => qb.filter(`${deep}=x`)).toThrow('filter_path_too_deep');
        });

        it('should match the whole day for date-only values on DateTime fields', () => {
            const result: any = qb.filter('createdAt=2024-03-15');
            expect(result.createdAt.gte).toBeInstanceOf(Date);
            expect(result.createdAt.lt).toBeInstanceOf(Date);
            expect(result.createdAt.lt.getTime() - result.createdAt.gte.getTime()).toBe(24 * 60 * 60 * 1000);
        });

        it('should use exact equals for datetime values on DateTime fields', () => {
            const result: any = qb.filter('createdAt=2024-03-15T10:30:00');
            expect(result.createdAt.equals).toBeInstanceOf(Date);
        });

        it('should reject non-date values on DateTime fields', () => {
            expect(() => qb.filter('createdAt=hello')).toThrow();
        });

        it('should not crash on literal % characters in string values', () => {
            const result: any = qb.filter('content=50%done');
            expect(result.content).toEqual({ equals: '50%done' });
        });

        // ── Relation filtering by scalar value ─────────────────
        it('should rewrite a to-one relation filter to its FK column', () => {
            const result: any = qb.filter('user=5');
            expect(result.user).toBeUndefined();
            expect(result.userId).toEqual({ equals: 5 });
        });

        it('should reject direct scalar filters on list relations', () => {
            expect(() => qb.filter('attachments=5')).toThrow();
        });

        // ── Field validation ────────────────────────────────────
        it('should throw for unknown top-level filter fields', () => {
            expect(() => qb.filter('bogus=1')).toThrow();
        });

        it('should throw for unknown fields on nested relation paths', () => {
            expect(() => qb.filter('user.bogus=1')).toThrow();
        });
    });

    describe('take()', () => {
        it('should return the requested limit', () => {
            expect(qb.take(10)).toBe(10);
        });

        it('should cap at API_RESULT_LIMIT', () => {
            const result = qb.take(99999);
            expect(result).toBeLessThanOrEqual(QueryBuilder.API_RESULT_LIMIT);
        });

        it('should throw on invalid input', () => {
            expect(() => qb.take(0)).toThrow();
            expect(() => qb.take(-5)).toThrow();
        });
    });

    describe('sort()', () => {
        it('should create ascending sort', () => {
            const result = qb.sort('createdAt', 'asc');
            expect(result).toEqual({ createdAt: 'asc' });
        });

        it('should create descending sort', () => {
            const result = qb.sort('createdAt', 'desc');
            expect(result).toEqual({ createdAt: 'desc' });
        });

        it('should handle dot-notation for relation sorting', () => {
            const result = qb.sort('user.name', 'asc');
            expect(result).toEqual({ user: { name: 'asc' } });
        });

        it('should throw for non-existent sort fields', () => {
            expect(() => qb.sort('bogus', 'asc')).toThrow();
        });

        it('should throw for non-existent relations in sort paths', () => {
            expect(() => qb.sort('bogus.name', 'asc')).toThrow();
        });

        it('should throw for non-existent fields on the related model', () => {
            expect(() => qb.sort('user.bogus', 'asc')).toThrow();
        });

        it('should throw when sorting directly by a relation', () => {
            expect(() => qb.sort('user', 'asc')).toThrow();
        });

        it('should allow _count sorting on to-many relations', () => {
            const result = qb.sort('attachments._count', 'desc');
            expect(result).toEqual({ attachments: { _count: 'desc' } });
        });

        it('should throw when sorting a to-many relation by a scalar field', () => {
            expect(() => qb.sort('attachments.url', 'asc')).toThrow();
        });

        it('should throw for _count on non-list paths', () => {
            expect(() => qb.sort('_count', 'asc')).toThrow();
            expect(() => qb.sort('user._count', 'asc')).toThrow();
        });
    });

    describe('include()', () => {
        const testUser = { id: '1', role: 'user' };

        it('should return empty for empty input', () => {
            expect(qb.include('', testUser)).toEqual({});
        });

        it('should handle ALL keyword', () => {
            const result = qb.include('ALL', testUser);
            expect(result).toBeDefined();
            expect(typeof result).toBe('object');
        });

        it('should apply ACL access filter as where on optional to-one includes (non-admin)', () => {
            // message_attachments.message is an optional to-one whose target (messages) has an ACL filter.
            // Prisma supports where on optional to-one includes — the relation returns null when it doesn't match.
            const attachmentsQb = new QueryBuilder('message_attachments');
            const result: any = attachmentsQb.include('ALL', { id: 7, role: 'user' });
            expect(result.message).toBeDefined();
            expect(result.message.where).toEqual({ userId: 7 });
        });

        it('should not apply a where on optional to-one includes for admin (empty filter)', () => {
            const attachmentsQb = new QueryBuilder('message_attachments');
            const result: any = attachmentsQb.include('ALL', { id: 1, role: 'admin' });
            expect(result.message).toBeDefined();
            if (typeof result.message === 'object') {
                expect(result.message.where).toBeUndefined();
            }
        });

        it('should handle comma-separated relations', () => {
            const result = qb.include('user,attachments', testUser);
            expect(result).toBeDefined();
        });
    });

    describe('omit()', () => {
        it('should return omit fields for non-admin user', () => {
            const result = qb.omit({ id: '1', role: 'user' });
            expect(result).toBeDefined();
            if (result) {
                expect(result.internal_notes).toBe(true);
            }
        });

        it('should return undefined/empty for admin user', () => {
            const result = qb.omit({ id: '1', role: 'admin' });
            // Admin has no omit fields
            expect(!result || Object.keys(result).length === 0).toBe(true);
        });
    });

    describe('create() - immutability', () => {
        it('should not mutate the input data', () => {
            const input = { content: 'Hello', userId: 5 };
            const original = { ...input };
            qb.create(input);
            expect(input).toEqual(original);
        });

        it('should return a new object', () => {
            const input = { content: 'Hello', userId: 5 };
            const result = qb.create(input);
            expect(result).toBeDefined();
            expect(result).not.toBe(input);
        });
    });

    describe('update() - immutability', () => {
        it('should not mutate the input data', () => {
            const input = { content: 'Updated' };
            const original = { ...input };
            qb.update(1, input);
            expect(input).toEqual(original);
        });

        it('should return a new object', () => {
            const input = { content: 'Updated' };
            const result = qb.update(1, input);
            expect(result).toBeDefined();
            expect(result).not.toBe(input);
        });
    });

    describe('filter()/sort() - ACL omit enforcement', () => {
        const restricted = { id: 7, role: 'user' };   // messages ACL omits internal_notes
        const admin = { id: 1, role: 'admin' };

        it('should reject filtering on an ACL-omitted field', () => {
            expect(() => qb.filter('internal_notes=%secret%', restricted))
                .toThrow('field_not_filterable');
        });

        it('should allow the same filter for a role that sees the field', () => {
            const result: any = qb.filter('internal_notes=%secret%', admin);
            expect(result.internal_notes).toEqual({ contains: 'secret' });
        });

        it('should enforce omit on nested relation filter paths', () => {
            // message_attachments -> message (messages) — internal_notes hidden for non-admin
            const attachmentsQb = new QueryBuilder('message_attachments');
            expect(() => attachmentsQb.filter('message.internal_notes=x', restricted))
                .toThrow('field_not_filterable');
        });

        it('should not enforce when no user is provided (backward compatible)', () => {
            const result: any = qb.filter('internal_notes=x');
            expect(result.internal_notes).toBeDefined();
        });

        it('should bypass enforcement for the application role', () => {
            const result: any = qb.filter('internal_notes=x', createSystemUser());
            expect(result.internal_notes).toBeDefined();
        });

        it('should reject sorting by an ACL-omitted field', () => {
            expect(() => qb.sort('internal_notes', 'asc', restricted))
                .toThrow('field_not_filterable');
        });

        it('should allow sorting by the same field for admin', () => {
            expect(qb.sort('internal_notes', 'asc', admin)).toEqual({ internal_notes: 'asc' });
        });

        it('should enforce omit on nested sort paths', () => {
            const attachmentsQb = new QueryBuilder('message_attachments');
            expect(() => attachmentsQb.sort('message.internal_notes', 'asc', restricted))
                .toThrow('field_not_filterable');
        });
    });

    describe('buildFieldSelection() - deep ACL enforcement', () => {
        it('should drop ACL-omitted fields of a related model (depth 1)', () => {
            const attachmentsQb = new QueryBuilder('message_attachments');
            const result: any = attachmentsQb.buildFieldSelection('id,message.content,message.internal_notes', 'message', { id: 7, role: 'user' });
            expect(result.select.message.select.content).toBe(true);
            expect(result.select.message.select.internal_notes).toBeUndefined();
        });

        it('should apply the ACL where on an optional to-one relation in select mode', () => {
            const attachmentsQb = new QueryBuilder('message_attachments');
            const result: any = attachmentsQb.buildFieldSelection('id,message.content', 'message', { id: 7, role: 'user' });
            expect(result.select.message.where).toEqual({ userId: 7 });
        });

        it('should enforce ACL omit at depth 2 (fields path can no longer bypass it)', () => {
            const result: any = qb.buildFieldSelection(
                'id,attachments.message.content,attachments.message.internal_notes',
                'attachments',
                { id: 7, role: 'user' }
            );
            const messageSelect = result.select.attachments.select.message;
            expect(messageSelect.select.content).toBe(true);
            expect(messageSelect.select.internal_notes).toBeUndefined();
            // Access filter enforced at depth 2 as well (optional to-one)
            expect(messageSelect.where).toEqual({ userId: 7 });
        });

        it('should skip relations whose ACL denies access (getAccessFilter -> false)', () => {
            const result: any = qb.buildFieldSelection('id,secret.data', 'secret', { id: 7, role: 'user' });
            expect(result.select.id).toBe(true);
            expect(result.select.secret).toBeUndefined();
        });

        it('should reject using a known scalar as a relation path', () => {
            expect(() => qb.buildFieldSelection('id,user.name.x', 'user', { id: 1, role: 'admin' }))
                .toThrow();
        });

        it('should accept the object form of include ({ query })', () => {
            const result: any = qb.buildFieldSelection('id,user.name', { query: 'user' }, { id: 1, role: 'admin' });
            expect(result.select.user.select.name).toBe(true);
        });
    });

    describe('include list-relation row cap', () => {
        it('should cap included list relations with take', () => {
            const result: any = qb.include('ALL', { id: 1, role: 'admin' });
            expect(result.attachments.take).toBe(QueryBuilder.API_RESULT_LIMIT);
        });

        it('should not add take to to-one includes', () => {
            const result: any = qb.include('ALL', { id: 1, role: 'admin' });
            // user is a to-one relation without ACL content -> plain true
            expect(result.user).toBe(true);
        });

        it('should carry the take cap into select mode for list relations', () => {
            const result: any = qb.buildFieldSelection('id,attachments.url', 'attachments', { id: 1, role: 'admin' });
            expect(result.select.attachments.take).toBe(QueryBuilder.API_RESULT_LIMIT);
        });
    });

    describe('writable-fields whitelist (getWritableFields)', () => {
        it('should strip non-whitelisted fields on create()', () => {
            const result: any = qb.create({ content: 'hello', userId: 9 }, { id: 1, role: 'restricted' });
            expect(result.content).toBe('hello');
            expect(result.userId).toBeUndefined();
            expect(result.user).toBeUndefined();
        });

        it('should strip non-whitelisted fields on update()', () => {
            const result: any = qb.update(1, { content: 'hello', userId: 9 }, { id: 1, role: 'restricted' });
            expect(result.content).toBe('hello');
            expect(result.userId).toBeUndefined();
            expect(result.user).toBeUndefined();
        });

        it('should not strip anything when the whitelist is null (unrestricted role)', () => {
            const result: any = qb.update(1, { content: 'hello', userId: 9 }, { id: 1, role: 'user' });
            expect(result.content).toBe('hello');
            // userId is an FK — transformed into a relation connect, not stripped
            expect(result.user).toEqual({ connect: expect.objectContaining({ id: 9 }) });
        });

        it('should strip non-whitelisted fields from nested relation items but keep identifiers', () => {
            const usersQb = new QueryBuilder('users');
            const result: any = usersQb.update(1, { messages: [{ id: 5, content: 'hi', createdAt: '2024-01-01' }] }, { id: 7, role: 'restricted' });
            expect(result.messages.upsert).toHaveLength(1);
            // id kept (identifier), content kept (whitelisted), createdAt stripped
            expect(result.messages.upsert[0].create).toEqual({ id: 5, content: 'hi' });
        });

        it('should bypass the whitelist for the application role', () => {
            const result: any = qb.update(1, { content: 'x', createdAt: '2024-01-01' }, createSystemUser());
            expect(result.content).toBe('x');
            expect(result.createdAt).toBe('2024-01-01');
        });
    });

    describe('update() - ACL merge into unique where', () => {
        it('should nest ACL access filter under AND with the unique key at top level (connect)', () => {
            // Prisma WhereUniqueInput requires a unique field at the TOP level;
            // { AND: [{id}, filter] } is rejected, { id, AND: [filter] } is valid.
            const usersQb = new QueryBuilder('users');
            const result: any = usersQb.update(1, { messages: [{ id: 5 }] }, { id: 7, role: 'user' });
            expect(result.messages.connect).toEqual([{ id: 5, AND: [{ userId: 7 }] }]);
        });

        it('should not add AND when ACL filter is empty (admin)', () => {
            const usersQb = new QueryBuilder('users');
            const result: any = usersQb.update(1, { messages: [{ id: 5 }] }, { id: 1, role: 'admin' });
            expect(result.messages.connect).toEqual([{ id: 5 }]);
        });

        it('should build per-item upsert entries for PK+data items', () => {
            const usersQb = new QueryBuilder('users');
            const result: any = usersQb.update(1, { messages: [{ id: 5, content: 'hi' }] }, { id: 7, role: 'user' });
            expect(result.messages.upsert).toHaveLength(1);
            expect(result.messages.upsert[0].where).toEqual({ id: 5 });
            expect(result.messages.upsert[0].create).toEqual({ id: 5, content: 'hi' });
        });
    });

    describe('cleanFilter()', () => {
        it('should remove undefined values', () => {
            const result = qb.cleanFilter({ a: 1, b: undefined, c: 'test' });
            expect(result).toEqual({ a: 1, c: 'test' });
        });

        it('should preserve null values', () => {
            const result = qb.cleanFilter({ a: null });
            expect(result).toEqual({ a: null });
        });

        it('should remove empty AND/OR arrays', () => {
            const result = qb.cleanFilter({ AND: [] });
            expect(result).toBeNull();
        });

        it('should unwrap single-element AND/OR', () => {
            const result = qb.cleanFilter({ AND: [{ userId: 1 }] });
            expect(result).toEqual({ userId: 1 });
        });

        it('should return null for empty object', () => {
            const result = qb.cleanFilter({});
            expect(result).toBeNull();
        });

        it('should handle nested objects', () => {
            const result = qb.cleanFilter({
                AND: [
                    { userId: 1 },
                    { OR: [{ content: 'a' }] },
                ],
            });
            expect(result).toBeDefined();
        });
    });

    describe('errorHandler()', () => {
        it('should handle generic errors', () => {
            const result = QueryBuilder.errorHandler(new Error('test error'));
            expect(result.status_code).toBe(500);
        });

        it('should handle ErrorResponse instances', () => {
            const { ErrorResponse } = require('../../src/core/errors');
            const err = new ErrorResponse(404, 'not_found');
            const result = QueryBuilder.errorHandler(err);
            expect(result.status_code).toBe(404);
            expect(result.message).toBe('not_found');
        });

        it('should translate ErrorResponse keys with placeholder interpolation', () => {
            // Real locales load from ./locales — errorHandler must return the translated
            // message (with data interpolated), not the raw i18n key
            const { ErrorResponse } = require('../../src/core/errors');
            const err = new ErrorResponse(400, 'invalid_filter_field', { field: 'zip' });
            const result = QueryBuilder.errorHandler(err);
            expect(result.status_code).toBe(400);
            expect(result.message).toBe('Invalid filter field: zip');
        });

        it('should translate into the requested language', () => {
            const { ErrorResponse } = require('../../src/core/errors');
            const err = new ErrorResponse(403, 'no_permission');
            const english = QueryBuilder.errorHandler(err, {}, 'en_US');
            const german = QueryBuilder.errorHandler(err, {}, 'de_DE');
            expect(english.message).not.toBe('no_permission');
            expect(german.message).not.toBe('no_permission');
            expect(german.message).not.toBe(english.message);
        });

        it('should handle Prisma P2002 duplicate error', () => {
            const err = {
                code: 'P2002',
                meta: { target: 'email', modelName: 'users' },
            };
            const result = QueryBuilder.errorHandler(err, { email: 'test@test.com' });
            expect(result.status_code).toBe(409);
            expect(result.message).toMatch(/duplicate_entry|Duplicate entry/);
        });

        it('should handle Prisma P2025 not found error', () => {
            const err = { code: 'P2025' };
            const result = QueryBuilder.errorHandler(err);
            expect(result.status_code).toBe(404);
        });

        it('should handle PrismaClientValidationError and extract argument message', () => {
            const err = {
                name: 'PrismaClientValidationError',
                message: `\nInvalid \`prisma.findMany()\` invocation:\n\n→ 343     const rows = await prisma[this.name].findMany({\n            where: {\n              id: {\n                not: {\n                  equals: "test"\n                          ~~~~~~\n                }\n              }\n            }\n          })\n\nArgument \`equals\`: Invalid value provided. Expected Int or IntFieldRefInput, provided String.`,
            };
            const result = QueryBuilder.errorHandler(err);
            expect(result.status_code).toBe(400);
            expect(result.message).toMatch(/Argument `equals`: Invalid value provided/);
            // Must NOT contain file paths or stack traces
            expect(result.message).not.toContain('/Users/');
            expect(result.message).not.toContain('.ts:');
        });

        it('should handle PrismaClientValidationError without argument match', () => {
            const err = {
                name: 'PrismaClientValidationError',
                message: 'Some unknown validation error',
            };
            const result = QueryBuilder.errorHandler(err);
            expect(result.status_code).toBe(400);
        });

        it('should handle PrismaClientInitializationError', () => {
            const err = {
                name: 'PrismaClientInitializationError',
                message: 'Can\'t reach database server at `localhost:5432`',
            };
            const result = QueryBuilder.errorHandler(err);
            expect(result.status_code).toBe(500);
            expect(result.message).not.toContain('localhost:5432');
        });

        it('should handle PrismaClientRustPanicError', () => {
            const err = {
                name: 'PrismaClientRustPanicError',
                message: 'Internal engine panic',
            };
            const result = QueryBuilder.errorHandler(err);
            expect(result.status_code).toBe(500);
            expect(result.message).not.toContain('panic');
        });
    });

    describe('getPrimaryKey()', () => {
        it('should return simple primary key', () => {
            expect(qb.getPrimaryKey()).toBe('id');
        });

        it('should return composite primary key array', () => {
            const compositeQb = new QueryBuilder('company_member_invites');
            const pk = compositeQb.getPrimaryKey();
            expect(Array.isArray(pk)).toBe(true);
            expect(pk).toEqual(['email', 'companyId']);
        });
    });

    describe('API_RESULT_LIMIT', () => {
        it('should be a positive number', () => {
            expect(QueryBuilder.API_RESULT_LIMIT).toBeGreaterThan(0);
        });
    });
});
