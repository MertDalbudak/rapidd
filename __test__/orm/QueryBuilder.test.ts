/**
 * Tests for the TypeScript QueryBuilder.
 * Validates filter parsing, include building, create/update transforms,
 * immutability, error handling, and omit logic.
 */

// Mock dependencies
jest.mock('../../src/core/prisma', () => ({
    prisma: {},
    prismaTransaction: jest.fn(),
    getAcl: () => ({
        model: {
            messages: {
                getAccessFilter: (user: any) => user?.role === 'admin' ? {} : { userId: user?.id },
                getOmitFields: (user: any) => user?.role === 'admin' ? [] : ['internal_notes'],
                canCreate: () => true,
            }
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
                ],
                primaryKey: null,
            },
            message_attachments: {
                name: 'message_attachments',
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'url', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'messageId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
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
            },
            users: {
                id: { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true },
                name: { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
                email: { name: 'email', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
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
        };
        return fields[name] || {};
    }),
    getPrimaryKey: jest.fn((name: string) => {
        if (name === 'company_member_invites') return ['email', 'companyId'];
        return 'id';
    }),
    getRelations: jest.fn(() => []),
    isListRelation: jest.fn((_parent: string, _rel: string) => false),
    getRelationInfo: jest.fn(),
    buildRelationships: jest.fn((name: string) => {
        if (name === 'messages') {
            return [
                { name: 'user', object: 'users', isList: false, field: 'userId', foreignKey: 'id' },
                { name: 'attachments', object: 'message_attachments', isList: true, field: 'messageId', foreignKey: 'id' },
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

        it('should handle negation prefix (!)', () => {
            const result: any = qb.filter('userId=!5');
            expect(result).toBeDefined();
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

        it('should use { is: null } for #NULL on list relation field', () => {
            const result: any = qb.filter('attachments=#NULL');
            expect(result.attachments).toEqual({ is: null });
        });

        it('should use { isNot: null } for not:#NULL on list relation field', () => {
            const result: any = qb.filter('attachments=not:#NULL');
            expect(result.attachments).toEqual({ isNot: null });
        });

        it('should skip empty filter value (no null filter applied)', () => {
            const result: any = qb.filter('content=');
            expect(result.content).toBeUndefined();
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

        it('should handle Prisma P2002 duplicate error', () => {
            const err = {
                code: 'P2002',
                meta: { target: 'email', modelName: 'users' },
            };
            const result = QueryBuilder.errorHandler(err, { email: 'test@test.com' });
            expect(result.status_code).toBe(409);
            expect(result.message).toContain('Duplicate');
            expect(result.message).toContain('email');
        });

        it('should handle Prisma P2025 not found error', () => {
            const err = { code: 'P2025' };
            const result = QueryBuilder.errorHandler(err);
            expect(result.status_code).toBe(404);
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
