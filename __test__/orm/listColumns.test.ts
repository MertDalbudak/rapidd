jest.mock('../../src/core/prisma', () => ({ rlsActive: () => false, prisma: {}, prismaTransaction: jest.fn(), getAcl: () => ({ model: {} }) }));
jest.mock('../../src/core/dmmf', () => ({
    getFields: jest.fn(() => ({
        tags: { name: 'tags', kind: 'scalar', type: 'String', isList: true, isRequired: true },
        sizes: { name: 'sizes', kind: 'scalar', type: 'Int', isList: true, isRequired: true },
    })),
    getScalarFields: jest.fn(() => ({})),
    getModel: jest.fn(() => ({ name: 'products', fields: [] })),
    getPrimaryKey: jest.fn(() => 'id'),
    buildRelationships: jest.fn(() => []),
    getRelations: jest.fn(() => []),
    isListRelation: jest.fn(() => false),
}));
import { QueryBuilder } from '../../src/orm/QueryBuilder';

describe('scalar list columns (PostgreSQL arrays)', () => {
    const qb = new QueryBuilder('products');

    it('test the elements: has, has any, negated', () => {
        expect(qb.filter('tags=sale')).toEqual({ tags: { has: 'sale' } });
        expect(qb.filter('tags=[sale,new]')).toEqual({ tags: { hasSome: ['sale', 'new'] } });
        expect(qb.filter('tags=not:sale')).toEqual({ NOT: [{ tags: { has: 'sale' } }] });
        expect(qb.filter('sizes=42')).toEqual({ sizes: { has: 42 } });
        expect(qb.filter('sizes=[40,42]')).toEqual({ sizes: { hasSome: [40, 42] } });
    });

    it('rejects values of the wrong type', () => {
        expect(() => qb.filter('sizes=large')).toThrow(expect.objectContaining({ status_code: 400 }));
    });

    it('validation errors do not report an operator as the field', () => {
        const err = Object.assign(new Error('...\n\nArgument `equals`: Invalid value provided. Expected String[], provided String.'), { name: 'PrismaClientValidationError' });
        const result = QueryBuilder.errorHandler(err);
        expect(result.status_code).toBe(400);
        expect(result.data).toBeUndefined();
    });
});
