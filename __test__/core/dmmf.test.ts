/**
 * Tests for the DMMF metadata provider.
 * Uses a mock DMMF structure to test all query functions.
 */

// Mock @prisma/internals before importing
jest.mock('@prisma/internals', () => ({
    getDMMF: jest.fn(),
}));

// Mock fs.readFileSync for schema loading
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    readFileSync: jest.fn(() => 'mock schema content'),
}));

import {
    loadDMMF,
    getDMMFSync,
    getModel,
    getFields,
    getScalarFields,
    getPrimaryKey,
    getRelations,
    isListRelation,
    getRelationInfo,
    findUserModel,
    findIdentifierFields,
    findPasswordField,
    buildRelationships,
} from '../../src/core/dmmf';

const mockDMMF = {
    datamodel: {
        models: [
            {
                name: 'User',
                primaryKey: null,
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'email', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: true },
                    { name: 'username', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: true },
                    { name: 'password', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'name', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: false },
                    { name: 'posts', kind: 'object', type: 'Post', isList: true, isRequired: false, isId: false, isUnique: false, relationFromFields: [], relationToFields: [] },
                ],
            },
            {
                name: 'Post',
                primaryKey: null,
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'title', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'content', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: false },
                    { name: 'authorId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'author', kind: 'object', type: 'User', isList: false, isRequired: true, isId: false, isUnique: false, relationFromFields: ['authorId'], relationToFields: ['id'], relationOnDelete: 'CASCADE' },
                    { name: 'comments', kind: 'object', type: 'Comment', isList: true, isRequired: false, isId: false, isUnique: false, relationFromFields: [], relationToFields: [] },
                ],
            },
            {
                name: 'Comment',
                primaryKey: null,
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'text', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'postId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'post', kind: 'object', type: 'Post', isList: false, isRequired: true, isId: false, isUnique: false, relationFromFields: ['postId'], relationToFields: ['id'] },
                ],
            },
            {
                name: 'CompositePK',
                primaryKey: { fields: ['tenantId', 'userId'] },
                fields: [
                    { name: 'tenantId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'userId', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: false, isUnique: false },
                    { name: 'data', kind: 'scalar', type: 'String', isList: false, isRequired: false, isId: false, isUnique: false },
                ],
            },
            {
                name: 'Account',
                primaryKey: null,
                fields: [
                    { name: 'id', kind: 'scalar', type: 'Int', isList: false, isRequired: true, isId: true, isUnique: true },
                    { name: 'hash', kind: 'scalar', type: 'String', isList: false, isRequired: true, isId: false, isUnique: false },
                ],
            },
        ],
    },
};

describe('DMMF Module', () => {
    beforeAll(async () => {
        const { getDMMF } = require('@prisma/internals');
        (getDMMF as jest.Mock).mockResolvedValue(mockDMMF);
        await loadDMMF();
    });

    // ── getDMMFSync ────────────────────────────────────────

    describe('getDMMFSync()', () => {
        it('should return the cached DMMF', () => {
            const dmmf = getDMMFSync();
            expect(dmmf).not.toBeNull();
            expect(dmmf!.datamodel.models.length).toBe(5);
        });
    });

    // ── getModel ───────────────────────────────────────────

    describe('getModel()', () => {
        it('should find model by name', () => {
            const model = getModel('User');
            expect(model).toBeDefined();
            expect(model!.name).toBe('User');
        });

        it('should return undefined for unknown model', () => {
            expect(getModel('NonExistent')).toBeUndefined();
        });
    });

    // ── getFields ──────────────────────────────────────────

    describe('getFields()', () => {
        it('should return all fields including relations', () => {
            const fields = getFields('User');
            expect(fields).toHaveProperty('id');
            expect(fields).toHaveProperty('email');
            expect(fields).toHaveProperty('posts'); // relation
        });

        it('should return empty for unknown model', () => {
            expect(getFields('Unknown')).toEqual({});
        });
    });

    // ── getScalarFields ────────────────────────────────────

    describe('getScalarFields()', () => {
        it('should return only scalar fields', () => {
            const fields = getScalarFields('User');
            expect(fields).toHaveProperty('id');
            expect(fields).toHaveProperty('email');
            expect(fields).not.toHaveProperty('posts');
        });

        it('should return empty for unknown model', () => {
            expect(getScalarFields('Unknown')).toEqual({});
        });
    });

    // ── getPrimaryKey ──────────────────────────────────────

    describe('getPrimaryKey()', () => {
        it('should return simple PK field name', () => {
            expect(getPrimaryKey('User')).toBe('id');
        });

        it('should return composite PK as array', () => {
            expect(getPrimaryKey('CompositePK')).toEqual(['tenantId', 'userId']);
        });

        it('should default to "id" for unknown model', () => {
            expect(getPrimaryKey('Unknown')).toBe('id');
        });
    });

    // ── getRelations ───────────────────────────────────────

    describe('getRelations()', () => {
        it('should return relation fields', () => {
            const rels = getRelations('Post');
            expect(rels.length).toBe(2);
            expect(rels.map(r => r.name)).toContain('author');
            expect(rels.map(r => r.name)).toContain('comments');
        });

        it('should return empty for model without relations', () => {
            expect(getRelations('CompositePK')).toEqual([]);
        });

        it('should return empty for unknown model', () => {
            expect(getRelations('Unknown')).toEqual([]);
        });
    });

    // ── isListRelation ─────────────────────────────────────

    describe('isListRelation()', () => {
        it('should return true for list relations', () => {
            expect(isListRelation('User', 'posts')).toBe(true);
            expect(isListRelation('Post', 'comments')).toBe(true);
        });

        it('should return false for single relations', () => {
            expect(isListRelation('Post', 'author')).toBe(false);
        });

        it('should return false for scalar fields', () => {
            expect(isListRelation('User', 'email')).toBe(false);
        });

        it('should return false for unknown model/field', () => {
            expect(isListRelation('Unknown', 'field')).toBe(false);
        });
    });

    // ── getRelationInfo ────────────────────────────────────

    describe('getRelationInfo()', () => {
        it('should return relation info', () => {
            const info = getRelationInfo('Post', 'author');
            expect(info).not.toBeNull();
            expect(info!.name).toBe('author');
            expect(info!.targetModel).toBe('User');
            expect(info!.isList).toBe(false);
            expect(info!.fromFields).toEqual(['authorId']);
            expect(info!.toFields).toEqual(['id']);
            expect(info!.onDelete).toBe('CASCADE');
        });

        it('should return null for unknown relation', () => {
            expect(getRelationInfo('Post', 'nonexistent')).toBeNull();
        });

        it('should return null for unknown model', () => {
            expect(getRelationInfo('Unknown', 'field')).toBeNull();
        });

        it('should return null for scalar field', () => {
            expect(getRelationInfo('Post', 'title')).toBeNull();
        });
    });

    // ── findUserModel ──────────────────────────────────────

    describe('findUserModel()', () => {
        it('should find model named User', () => {
            const model = findUserModel();
            expect(model).not.toBeNull();
            expect(model!.name).toBe('User');
        });
    });

    // ── findIdentifierFields ───────────────────────────────

    describe('findIdentifierFields()', () => {
        it('should find unique string fields excluding password-like names', () => {
            const fields = findIdentifierFields('User');
            expect(fields).toContain('email');
            expect(fields).toContain('username');
            expect(fields).not.toContain('password');
            expect(fields).not.toContain('id');
        });

        it('should default to ["email"] for models without unique strings', () => {
            const fields = findIdentifierFields('Comment');
            expect(fields).toEqual(['email']);
        });
    });

    // ── findPasswordField ──────────────────────────────────

    describe('findPasswordField()', () => {
        it('should find "password" field', () => {
            expect(findPasswordField('User')).toBe('password');
        });

        it('should find "hash" field', () => {
            expect(findPasswordField('Account')).toBe('hash');
        });

        it('should return null when no password field exists', () => {
            expect(findPasswordField('Post')).toBeNull();
        });
    });

    // ── buildRelationships ─────────────────────────────────

    describe('buildRelationships()', () => {
        it('should build relationship configs', () => {
            const rels = buildRelationships('Post');
            expect(rels.length).toBe(2);

            const author = rels.find(r => r.name === 'author');
            expect(author).toBeDefined();
            expect(author!.object).toBe('User');
            expect(author!.isList).toBe(false);
            expect(author!.field).toBe('authorId');
            expect(author!.foreignKey).toBe('id');
        });

        it('should include nested relations', () => {
            const rels = buildRelationships('Post');
            const author = rels.find(r => r.name === 'author');
            expect(author!.relation).toBeDefined();
            expect(author!.relation!.length).toBeGreaterThan(0);
        });

        it('should handle models without relations', () => {
            expect(buildRelationships('CompositePK')).toEqual([]);
        });
    });
});
