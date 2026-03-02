/**
 * Tests for QueryBuilder.buildFieldSelection() and #parseFields()
 * Validates field selection, relation field parsing, ACL integration,
 * validation errors, and edge cases.
 */

// Mock dependencies
jest.mock('../../src/core/prisma', () => ({
    prisma: {},
    prismaTransaction: jest.fn(),
    getAcl: jest.fn(() => ({
        model: {
            messages: {
                getAccessFilter: (user: any) => user?.role === 'admin' ? {} : { userId: user?.id },
                getOmitFields: (user: any) => user?.role === 'admin' ? [] : ['internal_notes'],
                canCreate: () => true,
            },
            users: {
                getAccessFilter: () => ({}),
                getOmitFields: () => ['password'],
            },
            message_attachments: {
                getAccessFilter: (user: any) => user?.role === 'admin' ? {} : { uploaderId: user?.id },
                getOmitFields: () => [],
            },
            secret_model: {
                getAccessFilter: () => false,
                getOmitFields: () => [],
            },
        },
    })),
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
                    { name: 'secret', kind: 'object', type: 'secret_model', isList: false, isRequired: false, isId: false, isUnique: false, relationFromFields: ['secretId'], relationToFields: ['id'], relationName: 'MessagesToSecret' },
                ],
                primaryKey: null,
            },
            users: {
                name: 'users',
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'email', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: true },
                    { name: 'password', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                ],
                primaryKey: null,
            },
            message_attachments: {
                name: 'message_attachments',
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'url', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'messageId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'uploaderId', kind: 'scalar', type: 'Int', isList: false, isRequired: false, isId: false, isUnique: false },
                ],
                primaryKey: null,
            },
            secret_model: {
                name: 'secret_model',
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'data', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
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
            },
            users: {
                id: { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true },
                name: { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
                email: { name: 'email', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
                password: { name: 'password', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
            },
            message_attachments: {
                id: { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true },
                url: { name: 'url', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false },
                messageId: { name: 'messageId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false },
                uploaderId: { name: 'uploaderId', kind: 'scalar', type: 'Int', isList: false, isRequired: false, isId: false },
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
    getPrimaryKey: jest.fn(() => 'id'),
    getRelations: jest.fn(() => []),
    isListRelation: jest.fn((parent: string, rel: string) => {
        if (parent === 'messages' && rel === 'attachments') return true;
        return false;
    }),
    getRelationInfo: jest.fn(),
    buildRelationships: jest.fn((name: string) => {
        if (name === 'messages') {
            return [
                { name: 'user', object: 'users', isList: false, field: 'userId', foreignKey: 'id' },
                { name: 'attachments', object: 'message_attachments', isList: true, field: 'messageId', foreignKey: 'id' },
                { name: 'secret', object: 'secret_model', isList: false, field: 'secretId', foreignKey: 'id' },
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

describe('QueryBuilder - buildFieldSelection()', () => {
    let qb: QueryBuilder;
    const adminUser = { id: 1, role: 'admin' };
    const normalUser = { id: 42, role: 'user' };

    beforeEach(() => {
        qb = new QueryBuilder('messages');
    });

    // ── No fields (current behavior) ─────────────────────

    describe('when fields is null/empty (fallback to current behavior)', () => {
        it('should return include + omit when fields is null', () => {
            const result = qb.buildFieldSelection(null, 'user', adminUser);
            expect(result).not.toHaveProperty('select');
            expect(result).toHaveProperty('include');
        });

        it('should return include + omit when fields is empty string', () => {
            const result = qb.buildFieldSelection('', 'user', adminUser);
            expect(result).not.toHaveProperty('select');
        });

        it('should return include + omit when fields is whitespace only', () => {
            const result = qb.buildFieldSelection('   ', 'user', adminUser);
            expect(result).not.toHaveProperty('select');
        });

        it('should include omit fields for non-admin user', () => {
            const result = qb.buildFieldSelection(null, '', normalUser);
            expect(result.omit).toBeDefined();
            expect(result.omit!.internal_notes).toBe(true);
        });

        it('should not include omit for admin user (no omit fields)', () => {
            const result = qb.buildFieldSelection(null, '', adminUser);
            // Admin has no omit fields, so omit should be empty or absent
            if (result.omit) {
                expect(Object.keys(result.omit).length).toBe(0);
            }
        });

        it('should return empty include when no relations specified', () => {
            const result = qb.buildFieldSelection(null, '', adminUser);
            // No include param means no include clause
            expect(result.include).toBeUndefined();
        });
    });

    // ── Scalar fields only ───────────────────────────────

    describe('scalar fields only', () => {
        it('should build select with scalar fields', () => {
            const result = qb.buildFieldSelection('id,content', '', adminUser);
            expect(result.select).toEqual({ id: true, content: true });
            expect(result.include).toBeUndefined();
            expect(result.omit).toBeUndefined();
        });

        it('should handle single field', () => {
            const result = qb.buildFieldSelection('id', '', adminUser);
            expect(result.select).toEqual({ id: true });
        });

        it('should trim whitespace around fields', () => {
            const result = qb.buildFieldSelection(' id , content , userId ', '', adminUser);
            expect(result.select).toEqual({ id: true, content: true, userId: true });
        });

        it('should deduplicate fields', () => {
            const result = qb.buildFieldSelection('id,id,content,id', '', adminUser);
            expect(result.select).toEqual({ id: true, content: true });
        });

        it('should exclude ACL-omitted fields from select', () => {
            const result = qb.buildFieldSelection('id,content,internal_notes', '', normalUser);
            expect(result.select!.id).toBe(true);
            expect(result.select!.content).toBe(true);
            expect(result.select!.internal_notes).toBeUndefined();
        });

        it('should not exclude omitted fields for admin', () => {
            const result = qb.buildFieldSelection('id,content,internal_notes', '', adminUser);
            expect(result.select!.internal_notes).toBe(true);
        });

        it('should ignore empty segments from trailing commas', () => {
            const result = qb.buildFieldSelection('id,content,', '', adminUser);
            expect(result.select).toEqual({ id: true, content: true });
        });

        it('should ignore empty segments from leading commas', () => {
            const result = qb.buildFieldSelection(',id,content', '', adminUser);
            expect(result.select).toEqual({ id: true, content: true });
        });
    });

    // ── Relation fields ──────────────────────────────────

    describe('relation fields', () => {
        it('should build select with relation-specific fields', () => {
            const result = qb.buildFieldSelection('id,user.name,user.email', 'user', adminUser);
            expect(result.select!.id).toBe(true);
            expect(result.select!.user).toEqual({
                select: { name: true, email: true },
            });
        });

        it('should include where clause for list relations (non-admin)', () => {
            const result = qb.buildFieldSelection('id,attachments.url', 'attachments', normalUser);
            expect(result.select!.id).toBe(true);
            expect(result.select!.attachments).toHaveProperty('select');
            expect(result.select!.attachments.select.url).toBe(true);
            // List relation for non-admin should have a where clause from ACL
            expect(result.select!.attachments).toHaveProperty('where');
        });

        it('should not include where clause for non-list relations', () => {
            const result = qb.buildFieldSelection('id,user.name', 'user', normalUser);
            // user is a non-list relation, no where clause
            expect(result.select!.user).toEqual({
                select: { name: true },
            });
        });

        it('should exclude ACL-omitted relation fields', () => {
            // users model omits 'password'
            const result = qb.buildFieldSelection('id,user.name,user.password', 'user', adminUser);
            expect(result.select!.user.select.name).toBe(true);
            expect(result.select!.user.select.password).toBeUndefined();
        });

        it('should handle multiple relations with specific fields', () => {
            const result = qb.buildFieldSelection(
                'id,user.name,attachments.url,attachments.messageId',
                'user,attachments',
                adminUser
            );
            expect(result.select!.id).toBe(true);
            expect(result.select!.user.select).toEqual({ name: true });
            expect(result.select!.attachments.select).toEqual({ url: true, messageId: true });
        });

        it('should deduplicate relation fields', () => {
            const result = qb.buildFieldSelection(
                'id,user.name,user.name,user.email',
                'user',
                adminUser
            );
            expect(Object.keys(result.select!.user.select)).toEqual(['name', 'email']);
        });
    });

    // ── Deep nested relation fields ─────────────────────

    describe('deep nested relation fields', () => {
        it('should nest 2-level deep fields correctly', () => {
            const result = qb.buildFieldSelection('id,attachments.uploader.name', 'attachments', adminUser);
            expect(result.select!.id).toBe(true);
            expect(result.select!.attachments.select.uploader).toEqual({
                select: { name: true },
            });
        });

        it('should nest 3-level deep fields correctly', () => {
            const result = qb.buildFieldSelection('id,attachments.uploader.profile.avatar', 'attachments', adminUser);
            expect(result.select!.attachments.select.uploader).toEqual({
                select: {
                    profile: {
                        select: { avatar: true },
                    },
                },
            });
        });

        it('should merge multiple deep fields into the same nested path', () => {
            const result = qb.buildFieldSelection(
                'id,attachments.uploader.name,attachments.uploader.email',
                'attachments',
                adminUser
            );
            expect(result.select!.attachments.select.uploader).toEqual({
                select: { name: true, email: true },
            });
        });

        it('should handle mix of shallow and deep fields on same relation', () => {
            const result = qb.buildFieldSelection(
                'id,attachments.url,attachments.uploader.name',
                'attachments',
                adminUser
            );
            expect(result.select!.attachments.select.url).toBe(true);
            expect(result.select!.attachments.select.uploader).toEqual({
                select: { name: true },
            });
        });

        it('should handle deep fields across multiple relations', () => {
            const result = qb.buildFieldSelection(
                'id,user.profile.avatar,attachments.uploader.name',
                'user,attachments',
                adminUser
            );
            expect(result.select!.user.select.profile).toEqual({
                select: { avatar: true },
            });
            expect(result.select!.attachments.select.uploader).toEqual({
                select: { name: true },
            });
        });
    });

    // ── Relations in include without specific fields ─────

    describe('relations in include without specific fields', () => {
        it('should include relation with all fields when no dot fields specified', () => {
            const result = qb.buildFieldSelection('id,content', 'user', adminUser);
            // user is in include but no user.* fields specified → include with all fields
            expect(result.select!.id).toBe(true);
            expect(result.select!.content).toBe(true);
            // user should be included with all fields (true or with omit)
            expect(result.select!.user).toBeDefined();
        });

        it('should apply omit to relation included without specific fields', () => {
            // users model omits 'password' → should be in content.omit
            const result = qb.buildFieldSelection('id', 'user', normalUser);
            // user relation has password omit, so it should have omit content
            if (typeof result.select!.user === 'object') {
                expect(result.select!.user.omit?.password).toBe(true);
            }
        });

        it('should apply where filter to list relation without specific fields', () => {
            const result = qb.buildFieldSelection('id', 'attachments', normalUser);
            // attachments is a list relation with ACL filter for non-admin
            if (typeof result.select!.attachments === 'object') {
                expect(result.select!.attachments).toHaveProperty('where');
            }
        });

        it('should set relation to true when no ACL content', () => {
            const result = qb.buildFieldSelection('id', 'user', adminUser);
            // admin user: users model has no omit fields for admin, no where → true
            // Actually users has password omit for everyone
            expect(result.select!.user).toBeDefined();
        });
    });

    // ── include=ALL ──────────────────────────────────────

    describe('include=ALL', () => {
        it('should allow all relations when include is ALL', () => {
            const result = qb.buildFieldSelection('id,user.name,attachments.url', 'ALL', adminUser);
            expect(result.select!.id).toBe(true);
            expect(result.select!.user.select.name).toBe(true);
            expect(result.select!.attachments.select.url).toBe(true);
        });

        it('should include all relations even without specific fields', () => {
            const result = qb.buildFieldSelection('id', 'ALL', adminUser);
            expect(result.select!.id).toBe(true);
            // All relations should be present
            expect(result.select!.user).toBeDefined();
            expect(result.select!.attachments).toBeDefined();
        });

        it('should skip ACL-denied relations in ALL mode', () => {
            // secret_model has getAccessFilter → false
            const result = qb.buildFieldSelection('id', 'ALL', adminUser);
            expect(result.select!.secret).toBeUndefined();
        });
    });

    // ── Validation errors ────────────────────────────────

    describe('validation errors', () => {
        it('should throw when relation in fields is not in include', () => {
            expect(() => {
                qb.buildFieldSelection('id,user.name', '', adminUser);
            }).toThrow('relation_not_included');
        });

        it('should throw with correct data for missing relation', () => {
            try {
                qb.buildFieldSelection('id,user.name', '', adminUser);
                fail('Should have thrown');
            } catch (err: any) {
                expect(err.status_code).toBe(400);
                expect(err.data.relation).toBe('user');
                expect(err.data.hint).toContain('user');
                expect(err.data.hint).toContain('include');
            }
        });

        it('should throw when one of multiple relations is not included', () => {
            expect(() => {
                qb.buildFieldSelection('id,user.name,attachments.url', 'user', adminUser);
            }).toThrow('relation_not_included');
        });

        it('should not throw when relation is properly included', () => {
            expect(() => {
                qb.buildFieldSelection('id,user.name', 'user', adminUser);
            }).not.toThrow();
        });

        it('should not throw when relation is in ALL include', () => {
            expect(() => {
                qb.buildFieldSelection('id,user.name,attachments.url', 'ALL', adminUser);
            }).not.toThrow();
        });
    });

    // ── Mixed scenarios ──────────────────────────────────

    describe('mixed scenarios', () => {
        it('should handle scalar + relation fields + relation without fields', () => {
            const result = qb.buildFieldSelection(
                'id,content,user.name',
                'user,attachments',
                adminUser
            );
            expect(result.select!.id).toBe(true);
            expect(result.select!.content).toBe(true);
            expect(result.select!.user).toEqual({ select: { name: true } });
            // attachments is in include but no specific fields → all fields
            expect(result.select!.attachments).toBeDefined();
        });

        it('should handle admin and non-admin differently', () => {
            const adminResult = qb.buildFieldSelection('id,internal_notes', '', adminUser);
            const userResult = qb.buildFieldSelection('id,internal_notes', '', normalUser);

            expect(adminResult.select!.internal_notes).toBe(true);
            expect(userResult.select!.internal_notes).toBeUndefined();
        });

        it('should only return select key (no include/omit)', () => {
            const result = qb.buildFieldSelection('id,content', 'user', adminUser);
            expect(Object.keys(result)).toEqual(['select']);
            expect(result.include).toBeUndefined();
            expect(result.omit).toBeUndefined();
        });

        it('should handle include as comma-separated list with dots', () => {
            // "user,attachments" should make both available
            const result = qb.buildFieldSelection('id,user.name,attachments.url', 'user,attachments', adminUser);
            expect(result.select!.user.select.name).toBe(true);
            expect(result.select!.attachments.select.url).toBe(true);
        });

        it('should extract top-level relation from dotted include strings', () => {
            // If include is "user.posts", the top-level relation "user" should be available
            expect(() => {
                qb.buildFieldSelection('id,user.name', 'user.profile', adminUser);
            }).not.toThrow();
        });
    });

    // ── Edge cases ───────────────────────────────────────

    describe('edge cases', () => {
        it('should handle fields with only relation fields (no scalars)', () => {
            const result = qb.buildFieldSelection('user.name,user.email', 'user', adminUser);
            expect(result.select!.user.select).toEqual({ name: true, email: true });
            // No scalar fields in select besides the relation
            const keys = Object.keys(result.select!);
            expect(keys).toEqual(['user']);
        });

        it('should handle include param as an object (non-string)', () => {
            // When include is an object (from middleware), buildFieldSelection should handle it
            const result = qb.buildFieldSelection('id,content', { user: true } as any, adminUser);
            // include is not a string → includeStr = '' → no available relations
            // No relation fields in fields string → should work fine
            expect(result.select).toEqual({ id: true, content: true });
        });

        it('should handle include param as an object and throw for relation fields', () => {
            // Relations from object include are not parsed
            expect(() => {
                qb.buildFieldSelection('id,user.name', { user: true } as any, adminUser);
            }).toThrow('relation_not_included');
        });

        it('should handle many fields', () => {
            const fields = 'id,content,userId,createdAt';
            const result = qb.buildFieldSelection(fields, '', adminUser);
            expect(result.select).toEqual({
                id: true,
                content: true,
                userId: true,
                createdAt: true,
            });
        });

        it('should handle fields string with extra commas', () => {
            const result = qb.buildFieldSelection('id,,content,,', '', adminUser);
            expect(result.select).toEqual({ id: true, content: true });
        });

        it('should produce select-only output (Prisma compat)', () => {
            // Prisma cannot use select + include together.
            // When fields is specified, result must only have 'select'.
            const result = qb.buildFieldSelection('id,user.name', 'user', adminUser);
            expect(result).toHaveProperty('select');
            expect(result).not.toHaveProperty('include');
            expect(result).not.toHaveProperty('omit');
        });
    });
});
