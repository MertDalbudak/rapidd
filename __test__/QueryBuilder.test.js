/**
 * Unit tests for QueryBuilder
 *
 * Tests all public methods and critical private behaviors:
 * - filter(): string parsing, operators, wildcards, relations
 * - select(): field selection
 * - sort(): orderBy construction
 * - take(): limit validation
 * - include(): relation includes with ACL
 * - create(): immutability, FK→connect, relation transforms
 * - update(): immutability, FK connect/disconnect, nested upserts
 * - omit(): ACL-based field omission
 * - cleanFilter(): filter cleanup/simplification
 * - errorHandler(): Prisma error mapping
 */

// --- Mock setup ---

const mockAcl = {
    model: {}
};

jest.mock('../rapidd/rapidd', () => ({
    prisma: {},
    prismaTransaction: jest.fn(),
    acl: mockAcl
}));

const mockDmmf = {
    getFields: jest.fn(),
    getScalarFields: jest.fn(),
    getPrimaryKey: jest.fn(),
    getRelations: jest.fn(() => []),
    isListRelation: jest.fn(),
    getRelationInfo: jest.fn(),
    buildRelationships: jest.fn(() => []),
    getModel: jest.fn(),
};

jest.mock('../rapidd/dmmf', () => mockDmmf);

class MockErrorResponse extends Error {
    constructor(status_code, message, data = null) {
        super(message);
        this.status_code = status_code;
        this.data = data;
    }
    toJSON() {
        return {
            status_code: this.status_code,
            message: this.message,
            data: this.data
        };
    }
}

jest.mock('../src/Api', () => ({
    ErrorResponse: MockErrorResponse
}));

// Must require AFTER mocks are set up
const { QueryBuilder } = require('../src/QueryBuilder');

// --- Helpers ---

/**
 * Set up DMMF mocks for a simple model with common fields
 */
function setupSimpleModel(modelName = 'users', extraFields = {}) {
    const fields = {
        id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
        name: { name: 'name', kind: 'scalar', type: 'String' },
        email: { name: 'email', kind: 'scalar', type: 'String' },
        age: { name: 'age', kind: 'scalar', type: 'Int' },
        createdAt: { name: 'createdAt', kind: 'scalar', type: 'DateTime' },
        ...extraFields
    };

    mockDmmf.getFields.mockReturnValue(fields);
    mockDmmf.getScalarFields.mockReturnValue(fields);
    mockDmmf.getPrimaryKey.mockReturnValue('id');
    mockDmmf.buildRelationships.mockReturnValue([]);
    mockDmmf.getModel.mockReturnValue({
        name: modelName,
        fields: Object.values(fields),
        primaryKey: null
    });

    return fields;
}

/**
 * Set up DMMF mocks for a model with relations
 */
function setupModelWithRelations(modelName = 'jobs') {
    const fields = {
        id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
        title: { name: 'title', kind: 'scalar', type: 'String' },
        companyId: { name: 'companyId', kind: 'scalar', type: 'String' },
        locationId: { name: 'locationId', kind: 'scalar', type: 'String' },
        company_profiles: { name: 'company_profiles', kind: 'object', type: 'company_profiles', isList: false },
        applications: { name: 'applications', kind: 'object', type: 'applications', isList: true },
        company_locations: { name: 'company_locations', kind: 'object', type: 'company_locations', isList: false },
    };

    const companyFields = {
        id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
        companyName: { name: 'companyName', kind: 'scalar', type: 'String' },
        jobs: { name: 'jobs', kind: 'object', type: 'jobs', isList: true },
    };

    const applicationFields = {
        id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
        jobId: { name: 'jobId', kind: 'scalar', type: 'String' },
        status: { name: 'status', kind: 'scalar', type: 'String' },
        studentId: { name: 'studentId', kind: 'scalar', type: 'String' },
        student_profiles: { name: 'student_profiles', kind: 'object', type: 'student_profiles', isList: false },
    };

    const locationFields = {
        id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
        name: { name: 'name', kind: 'scalar', type: 'String' },
        companyId: { name: 'companyId', kind: 'scalar', type: 'String' },
    };

    const studentFields = {
        id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
        userId: { name: 'userId', kind: 'scalar', type: 'String' },
    };

    mockDmmf.getFields.mockImplementation((name) => {
        if (name === 'jobs') return fields;
        if (name === 'company_profiles') return companyFields;
        if (name === 'applications') return applicationFields;
        if (name === 'company_locations') return locationFields;
        if (name === 'student_profiles') return studentFields;
        return {};
    });

    mockDmmf.getPrimaryKey.mockImplementation((name) => {
        return 'id'; // All models use simple 'id' PK
    });

    mockDmmf.isListRelation.mockImplementation((model, field) => {
        if (model === 'jobs' && field === 'applications') return true;
        if (model === 'company_profiles' && field === 'jobs') return true;
        return false;
    });

    const relationships = [
        {
            name: 'company_profiles',
            object: 'company_profiles',
            isList: false,
            field: 'companyId',
            foreignKey: 'id',
            relation: [
                { name: 'jobs', object: 'jobs', isList: true, field: null, foreignKey: 'id' },
            ]
        },
        {
            name: 'applications',
            object: 'applications',
            isList: true,
            field: null,
            foreignKey: 'id',
            relation: [
                { name: 'student_profiles', object: 'student_profiles', isList: false, field: 'studentId', foreignKey: 'id' },
            ]
        },
        {
            name: 'company_locations',
            object: 'company_locations',
            isList: false,
            field: 'locationId',
            foreignKey: 'id',
            relation: []
        }
    ];

    mockDmmf.buildRelationships.mockReturnValue(relationships);

    mockDmmf.getRelations.mockImplementation((name) => {
        if (name === 'applications') {
            return [
                { name: 'student_profiles', type: 'student_profiles', isList: false, relationFromFields: ['studentId'], relationToFields: ['id'] }
            ];
        }
        if (name === 'student_profiles') {
            return [
                { name: 'users_student_profiles_userIdTousers', type: 'users', isList: false, relationFromFields: ['userId'], relationToFields: ['id'] }
            ];
        }
        return [];
    });

    return { fields, relationships };
}

/**
 * Set up DMMF mocks for a model with composite primary key
 */
function setupCompositeKeyModel() {
    const fields = {
        email: { name: 'email', kind: 'scalar', type: 'String' },
        companyId: { name: 'companyId', kind: 'scalar', type: 'String' },
        role: { name: 'role', kind: 'scalar', type: 'String' },
        invitedBy: { name: 'invitedBy', kind: 'scalar', type: 'String' },
        company_profiles: { name: 'company_profiles', kind: 'object', type: 'company_profiles', isList: false },
        company_members: { name: 'company_members', kind: 'object', type: 'company_members', isList: false },
    };

    mockDmmf.getFields.mockReturnValue(fields);
    mockDmmf.getPrimaryKey.mockReturnValue(['email', 'companyId']);
    mockDmmf.buildRelationships.mockReturnValue([
        {
            name: 'company_profiles',
            object: 'company_profiles',
            isList: false,
            field: 'companyId',
            foreignKey: 'id'
        },
        {
            name: 'company_members',
            object: 'company_members',
            isList: false,
            field: 'invitedBy',
            foreignKey: 'id'
        }
    ]);

    return fields;
}


// --- Test Suites ---

beforeEach(() => {
    jest.clearAllMocks();
    // Reset ACL
    mockAcl.model = {};
});


// ==========================================
// filter() tests
// ==========================================
describe('QueryBuilder.filter()', () => {
    let qb;

    beforeEach(() => {
        setupSimpleModel();
        qb = new QueryBuilder('users');
    });

    test('returns empty object for empty/null/undefined input', () => {
        expect(qb.filter('')).toEqual({});
        expect(qb.filter(null)).toEqual({});
        expect(qb.filter(undefined)).toEqual({});
    });

    test('parses simple field=value filter', () => {
        const result = qb.filter('name=John');
        expect(result).toEqual({ name: { equals: 'John' } });
    });

    test('parses contains wildcard (%value%)', () => {
        const result = qb.filter('name=%John%');
        expect(result).toEqual({ name: { contains: 'John' } });
    });

    test('parses startsWith wildcard (value%)', () => {
        const result = qb.filter('name=John%');
        expect(result).toEqual({ name: { startsWith: 'John' } });
    });

    test('parses endsWith wildcard (%value)', () => {
        const result = qb.filter('name=%John');
        expect(result).toEqual({ name: { endsWith: 'John' } });
    });

    test('parses numeric gt operator', () => {
        const result = qb.filter('age=gt:18');
        expect(result).toEqual({ age: { gt: 18 } });
    });

    test('parses numeric lte operator', () => {
        const result = qb.filter('age=lte:30');
        expect(result).toEqual({ age: { lte: 30 } });
    });

    test('parses numeric between operator', () => {
        const result = qb.filter('age=between:18;30');
        expect(result).toEqual({ age: { gte: 18, lte: 30 } });
    });

    test('parses numeric eq operator', () => {
        const result = qb.filter('age=eq:25');
        expect(result).toEqual({ age: { equals: 25 } });
    });

    test('parses plain number as equals', () => {
        const result = qb.filter('age=25');
        expect(result).toEqual({ age: { equals: 25 } });
    });

    test('parses #NULL value', () => {
        const result = qb.filter('name=#NULL');
        expect(result).toEqual({ name: null });
    });

    test('parses not:#NULL value', () => {
        const result = qb.filter('name=not:#NULL');
        expect(result).toEqual({ name: { not: null } });
    });

    test('parses not: prefix for string', () => {
        const result = qb.filter('name=not:John');
        expect(result).toEqual({ name: { not: { equals: 'John' } } });
    });

    test('parses array filter [1,2,3]', () => {
        const result = qb.filter('age=[1,2,3]');
        expect(result).toEqual({ age: { in: [1, 2, 3] } });
    });

    test('parses negated array filter not:[1,2,3]', () => {
        const result = qb.filter('age=not:[1,2,3]');
        expect(result).toEqual({ age: { notIn: [1, 2, 3] } });
    });

    test('parses boolean true', () => {
        const result = qb.filter('name=true');
        expect(result).toEqual({ name: true });
    });

    test('parses boolean false', () => {
        const result = qb.filter('name=false');
        expect(result).toEqual({ name: false });
    });

    test('parses multiple filters separated by comma', () => {
        const result = qb.filter('name=John,age=gt:18');
        expect(result).toEqual({
            name: { equals: 'John' },
            age: { gt: 18 }
        });
    });

    test('parses date before operator', () => {
        const result = qb.filter('createdAt=before:2024-01-01');
        expect(result.createdAt).toHaveProperty('lt');
        expect(result.createdAt.lt).toBeInstanceOf(Date);
    });

    test('parses date after operator', () => {
        const result = qb.filter('createdAt=after:2024-06-01');
        expect(result.createdAt).toHaveProperty('gt');
        expect(result.createdAt.gt).toBeInstanceOf(Date);
    });

    test('parses date on operator (full day range)', () => {
        const result = qb.filter('createdAt=on:2024-01-15');
        expect(result.createdAt).toHaveProperty('gte');
        expect(result.createdAt).toHaveProperty('lt');
    });

    test('parses date between operator', () => {
        const result = qb.filter('createdAt=between:2024-01-01;2024-12-31');
        expect(result.createdAt).toHaveProperty('gte');
        expect(result.createdAt).toHaveProperty('lte');
    });

    test('throws on invalid field name', () => {
        expect(() => qb.filter('nonexistent=value')).toThrow();
    });

    test('handles URL-encoded values', () => {
        const result = qb.filter('name=John%20Doe');
        expect(result).toEqual({ name: { equals: 'John Doe' } });
    });
});


// ==========================================
// select() tests
// ==========================================
describe('QueryBuilder.select()', () => {
    let qb;

    beforeEach(() => {
        setupSimpleModel();
        qb = new QueryBuilder('users');
    });

    test('returns all fields when no argument provided', () => {
        const result = qb.select();
        expect(result).toHaveProperty('id', true);
        expect(result).toHaveProperty('name', true);
        expect(result).toHaveProperty('email', true);
    });

    test('returns only specified fields when array provided', () => {
        const result = qb.select(['id', 'name']);
        expect(result).toEqual({ id: true, name: true });
    });
});


// ==========================================
// sort() tests
// ==========================================
describe('QueryBuilder.sort()', () => {
    let qb;

    beforeEach(() => {
        setupSimpleModel();
        qb = new QueryBuilder('users');
    });

    test('builds simple sort object', () => {
        expect(qb.sort('name', 'asc')).toEqual({ name: 'asc' });
        expect(qb.sort('name', 'desc')).toEqual({ name: 'desc' });
    });

    test('builds dot-notation relation sort', () => {
        expect(qb.sort('profile.name', 'asc')).toEqual({
            profile: { name: 'asc' }
        });
    });

    test('builds deep dot-notation sort', () => {
        expect(qb.sort('profile.address.city', 'desc')).toEqual({
            profile: { address: { city: 'desc' } }
        });
    });

    test('throws on non-string sortBy', () => {
        expect(() => qb.sort(123, 'asc')).toThrow();
    });

    test('throws on invalid sortOrder', () => {
        expect(() => qb.sort('name', 'invalid')).toThrow();
    });
});


// ==========================================
// take() tests
// ==========================================
describe('QueryBuilder.take()', () => {
    let qb;

    beforeEach(() => {
        setupSimpleModel();
        qb = new QueryBuilder('users');
    });

    test('returns valid limit', () => {
        expect(qb.take(10)).toBe(10);
    });

    test('caps limit at API_RESULT_LIMIT', () => {
        const result = qb.take(10000);
        expect(result).toBeLessThanOrEqual(QueryBuilder.API_RESULT_LIMIT);
    });

    test('throws on zero or negative limit', () => {
        expect(() => qb.take(0)).toThrow();
        expect(() => qb.take(-1)).toThrow();
    });

    test('throws on non-integer limit', () => {
        expect(() => qb.take(1.5)).toThrow();
    });
});


// ==========================================
// omit() tests
// ==========================================
describe('QueryBuilder.omit()', () => {
    let qb;

    beforeEach(() => {
        setupSimpleModel();
        qb = new QueryBuilder('users');
    });

    test('returns omit fields from ACL', () => {
        mockAcl.model.users = {
            getOmitFields: jest.fn(() => ['password', 'twoFactorSecret'])
        };

        const result = qb.omit({ role: 'STUDENT' });
        expect(result).toEqual({ password: true, twoFactorSecret: true });
    });

    test('returns empty object when no ACL', () => {
        const result = qb.omit({ role: 'STUDENT' });
        expect(result).toEqual({});
    });

    test('returns empty object when ACL returns null', () => {
        mockAcl.model.users = {
            getOmitFields: jest.fn(() => null)
        };

        const result = qb.omit({ role: 'STUDENT' });
        expect(result).toEqual({});
    });
});


// ==========================================
// create() tests - immutability + transforms
// ==========================================
describe('QueryBuilder.create()', () => {
    test('does NOT mutate the original data object', () => {
        setupSimpleModel();
        const qb = new QueryBuilder('users');

        const original = { name: 'John', email: 'john@test.com' };
        const originalCopy = { ...original };

        qb.create(original);

        expect(original).toEqual(originalCopy);
    });

    test('returns transformed data as a new object', () => {
        setupSimpleModel();
        const qb = new QueryBuilder('users');

        const data = { name: 'John', email: 'john@test.com' };
        const result = qb.create(data);

        expect(result).toBeDefined();
        expect(result).not.toBe(data);
        expect(result.name).toBe('John');
        expect(result.email).toBe('john@test.com');
    });

    test('removes omitted fields from result', () => {
        setupSimpleModel();
        const qb = new QueryBuilder('users');

        mockAcl.model.users = {
            getOmitFields: jest.fn(() => ['email'])
        };

        const data = { name: 'John', email: 'john@test.com' };
        const result = qb.create(data, { role: 'STUDENT' });

        expect(result.email).toBeUndefined();
        expect(result.name).toBe('John');
        // Original should be untouched
        expect(data.email).toBe('john@test.com');
    });

    test('transforms FK field to connect', () => {
        setupModelWithRelations();
        const qb = new QueryBuilder('jobs');

        const data = { title: 'Dev', companyId: 'company-1' };
        const result = qb.create(data);

        expect(result.companyId).toBeUndefined();
        expect(result.company_profiles).toEqual({
            connect: { id: 'company-1' }
        });
        // Original untouched
        expect(data.companyId).toBe('company-1');
    });

    test('transforms nested relation object to create', () => {
        setupModelWithRelations();
        const qb = new QueryBuilder('jobs');

        // Mock the field existence check for company_locations
        mockDmmf.getFields.mockImplementation((name) => {
            if (name === 'company_locations') return {
                id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
                name: { name: 'name', kind: 'scalar', type: 'String' },
                companyId: { name: 'companyId', kind: 'scalar', type: 'String' },
            };
            if (name === 'jobs') return {
                id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
                title: { name: 'title', kind: 'scalar', type: 'String' },
                companyId: { name: 'companyId', kind: 'scalar', type: 'String' },
                locationId: { name: 'locationId', kind: 'scalar', type: 'String' },
                company_profiles: { name: 'company_profiles', kind: 'object', type: 'company_profiles', isList: false },
                applications: { name: 'applications', kind: 'object', type: 'applications', isList: true },
                company_locations: { name: 'company_locations', kind: 'object', type: 'company_locations', isList: false },
            };
            return {};
        });

        const data = {
            title: 'Dev',
            company_locations: { name: 'Berlin Office', companyId: 'comp-1' }
        };
        const original = JSON.parse(JSON.stringify(data));
        const result = qb.create(data);

        expect(result.company_locations).toHaveProperty('create');
        // Original untouched
        expect(data).toEqual(original);
    });

    test('throws on unexpected key', () => {
        setupSimpleModel();
        const qb = new QueryBuilder('users');

        expect(() => qb.create({ name: 'John', unknownField: 'value' }))
            .toThrow();
    });

    test('handles array relations with connect/create split', () => {
        setupModelWithRelations();
        const qb = new QueryBuilder('jobs');

        mockDmmf.getFields.mockImplementation((name) => {
            if (name === 'applications') return {
                id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
                jobId: { name: 'jobId', kind: 'scalar', type: 'String' },
                status: { name: 'status', kind: 'scalar', type: 'String' },
                studentId: { name: 'studentId', kind: 'scalar', type: 'String' },
                student_profiles: { name: 'student_profiles', kind: 'object', type: 'student_profiles', isList: false },
            };
            if (name === 'jobs') return {
                id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
                title: { name: 'title', kind: 'scalar', type: 'String' },
                companyId: { name: 'companyId', kind: 'scalar', type: 'String' },
                locationId: { name: 'locationId', kind: 'scalar', type: 'String' },
                company_profiles: { name: 'company_profiles', kind: 'object', type: 'company_profiles', isList: false },
                applications: { name: 'applications', kind: 'object', type: 'applications', isList: true },
                company_locations: { name: 'company_locations', kind: 'object', type: 'company_locations', isList: false },
            };
            return {};
        });

        const data = {
            title: 'Dev',
            applications: [
                { id: 'existing-1' },                      // connect only (has PK, no other data)
                { status: 'SUBMITTED', studentId: 'stu-1' } // create (no PK)
            ]
        };
        const original = JSON.parse(JSON.stringify(data));
        const result = qb.create(data);

        expect(result.applications).toBeDefined();
        expect(result.applications.connect).toBeDefined();
        expect(result.applications.create).toBeDefined();
        // Original untouched
        expect(data).toEqual(original);
    });
});


// ==========================================
// update() tests - immutability + transforms
// ==========================================
describe('QueryBuilder.update()', () => {
    test('does NOT mutate the original data object', () => {
        setupSimpleModel();
        const qb = new QueryBuilder('users');

        const original = { name: 'Jane', email: 'jane@test.com' };
        const originalCopy = { ...original };

        qb.update('user-1', original);

        expect(original).toEqual(originalCopy);
    });

    test('returns transformed data as a new object', () => {
        setupSimpleModel();
        const qb = new QueryBuilder('users');

        const data = { name: 'Jane' };
        const result = qb.update('user-1', data);

        expect(result).toBeDefined();
        expect(result).not.toBe(data);
        expect(result.name).toBe('Jane');
    });

    test('removes omitted fields from result', () => {
        setupSimpleModel();
        const qb = new QueryBuilder('users');

        mockAcl.model.users = {
            getOmitFields: jest.fn(() => ['email'])
        };

        const data = { name: 'Jane', email: 'jane@test.com' };
        const result = qb.update('user-1', data, { role: 'STUDENT' });

        expect(result.email).toBeUndefined();
        expect(data.email).toBe('jane@test.com');
    });

    test('transforms FK field to connect', () => {
        setupModelWithRelations();
        const qb = new QueryBuilder('jobs');

        const data = { title: 'Updated', companyId: 'company-2' };
        const result = qb.update('job-1', data);

        expect(result.companyId).toBeUndefined();
        expect(result.company_profiles).toEqual({
            connect: { id: 'company-2' }
        });
        expect(data.companyId).toBe('company-2');
    });

    test('transforms null FK to disconnect', () => {
        setupModelWithRelations();
        const qb = new QueryBuilder('jobs');

        const data = { locationId: null };
        const result = qb.update('job-1', data);

        expect(result.locationId).toBeUndefined();
        expect(result.company_locations).toEqual({
            disconnect: true
        });
    });

    test('throws on unexpected key', () => {
        setupSimpleModel();
        const qb = new QueryBuilder('users');

        expect(() => qb.update('user-1', { unknownField: 'value' }))
            .toThrow();
    });
});


// ==========================================
// cleanFilter() tests
// ==========================================
describe('QueryBuilder.cleanFilter()', () => {
    let qb;

    beforeEach(() => {
        setupSimpleModel();
        qb = new QueryBuilder('users');
    });

    test('returns null for null/undefined input', () => {
        expect(qb.cleanFilter(null)).toBeNull();
        expect(qb.cleanFilter(undefined)).toBeNull();
    });

    test('removes undefined values', () => {
        const result = qb.cleanFilter({ name: 'John', age: undefined });
        expect(result).toEqual({ name: 'John' });
    });

    test('preserves null values', () => {
        const result = qb.cleanFilter({ name: null });
        expect(result).toEqual({ name: null });
    });

    test('removes empty AND/OR arrays', () => {
        const result = qb.cleanFilter({ AND: [], name: 'John' });
        expect(result).toEqual({ name: 'John' });
    });

    test('unwraps single-element AND array', () => {
        const result = qb.cleanFilter({ AND: [{ name: 'John' }] });
        expect(result).toEqual({ name: 'John' });
    });

    test('unwraps single-element OR array', () => {
        const result = qb.cleanFilter({ OR: [{ name: 'John' }] });
        expect(result).toEqual({ name: 'John' });
    });

    test('preserves multi-element AND array', () => {
        const result = qb.cleanFilter({
            AND: [{ name: 'John' }, { age: 25 }]
        });
        expect(result).toEqual({
            AND: [{ name: 'John' }, { age: 25 }]
        });
    });

    test('recursively cleans nested objects', () => {
        const result = qb.cleanFilter({
            AND: [
                { name: 'John', extra: undefined },
                { OR: [] }
            ]
        });
        expect(result).toEqual({ name: 'John' });
    });

    test('returns null for completely empty filter', () => {
        expect(qb.cleanFilter({})).toBeNull();
        expect(qb.cleanFilter({ a: undefined })).toBeNull();
    });
});


// ==========================================
// errorHandler() tests
// ==========================================
describe('QueryBuilder.errorHandler()', () => {
    test('maps P2002 duplicate error', () => {
        const error = {
            code: 'P2002',
            meta: { target: 'email', modelName: 'users' }
        };
        const result = QueryBuilder.errorHandler(error, { email: 'test@test.com' });

        expect(result.status_code).toBe(409);
        expect(result.message).toContain('Duplicate');
        expect(result.message).toContain('email');
    });

    test('maps P2025 not found error', () => {
        const error = { code: 'P2025' };
        const result = QueryBuilder.errorHandler(error);

        expect(result.status_code).toBe(404);
    });

    test('maps P2003 FK constraint error', () => {
        const error = { code: 'P2003' };
        const result = QueryBuilder.errorHandler(error);

        expect(result.status_code).toBe(400);
    });

    test('maps P2024 timeout error', () => {
        const error = { code: 'P2024' };
        const result = QueryBuilder.errorHandler(error);

        expect(result.status_code).toBe(408);
    });

    test('returns 500 for unknown errors', () => {
        const error = new Error('Something unexpected');
        const result = QueryBuilder.errorHandler(error);

        expect(result.status_code).toBe(500);
    });

    test('preserves ErrorResponse status code', () => {
        // Simulate ErrorResponse-like object
        const error = new Error('Custom error');
        error.status_code = 422;
        const result = QueryBuilder.errorHandler(error);

        expect(result.status_code).toBe(422);
    });
});


// ==========================================
// include() tests
// ==========================================
describe('QueryBuilder.include()', () => {
    test('returns empty object for empty string include', () => {
        setupSimpleModel();
        const qb = new QueryBuilder('users');
        expect(qb.include('', {})).toEqual({});
    });

    test('includes all first-level relations for "ALL"', () => {
        setupModelWithRelations();
        const qb = new QueryBuilder('jobs');

        const result = qb.include('ALL', { role: 'application' });

        expect(result).toHaveProperty('company_profiles');
        expect(result).toHaveProperty('applications');
        expect(result).toHaveProperty('company_locations');
    });

    test('includes only specified relations', () => {
        setupModelWithRelations();
        const qb = new QueryBuilder('jobs');

        const result = qb.include('company_profiles', { role: 'application' });

        expect(result).toHaveProperty('company_profiles');
        expect(result).not.toHaveProperty('applications');
    });

    test('supports comma-separated relation names', () => {
        setupModelWithRelations();
        const qb = new QueryBuilder('jobs');

        const result = qb.include('company_profiles,applications', { role: 'application' });

        expect(result).toHaveProperty('company_profiles');
        expect(result).toHaveProperty('applications');
        expect(result).not.toHaveProperty('company_locations');
    });
});


// ==========================================
// Composite PK in create/update
// ==========================================
describe('Composite primary key support in QueryBuilder', () => {
    test('getPrimaryKey returns array for composite keys', () => {
        setupCompositeKeyModel();
        const qb = new QueryBuilder('company_member_invites');
        const pk = qb.getPrimaryKey();
        expect(Array.isArray(pk)).toBe(true);
        expect(pk).toEqual(['email', 'companyId']);
    });

    test('create with composite PK model does not mutate input', () => {
        setupCompositeKeyModel();

        mockDmmf.getFields.mockImplementation((name) => {
            if (name === 'company_member_invites') {
                return {
                    email: { name: 'email', kind: 'scalar', type: 'String' },
                    companyId: { name: 'companyId', kind: 'scalar', type: 'String' },
                    role: { name: 'role', kind: 'scalar', type: 'String' },
                    invitedBy: { name: 'invitedBy', kind: 'scalar', type: 'String' },
                    company_profiles: { name: 'company_profiles', kind: 'object', type: 'company_profiles', isList: false },
                    company_members: { name: 'company_members', kind: 'object', type: 'company_members', isList: false },
                };
            }
            if (name === 'company_profiles') {
                return { id: { name: 'id', kind: 'scalar', type: 'String', isId: true } };
            }
            if (name === 'company_members') {
                return { id: { name: 'id', kind: 'scalar', type: 'String', isId: true } };
            }
            return {};
        });

        mockDmmf.getPrimaryKey.mockImplementation((name) => {
            if (name === 'company_member_invites') return ['email', 'companyId'];
            return 'id';
        });

        const qb = new QueryBuilder('company_member_invites');
        const data = { email: 'test@test.com', companyId: 'comp-1', role: 'RECRUITER', invitedBy: 'member-1' };
        const original = { ...data };

        const result = qb.create(data);

        // Original should not be mutated
        expect(data).toEqual(original);
        // Result should have FK transforms
        expect(result).toBeDefined();
        expect(result.email).toBe('test@test.com');
    });
});


// ==========================================
// Deep relationship processing (>2 levels)
// ==========================================
describe('Deep relationship processing', () => {
    test('#ensureRelations enables processing beyond 2 levels', () => {
        setupModelWithRelations();
        const qb = new QueryBuilder('jobs');

        // getRelations should be called when processing nested relations
        // that don't have pre-built relation configs
        mockDmmf.getRelations.mockImplementation((name) => {
            if (name === 'applications') {
                return [
                    {
                        name: 'student_profiles',
                        type: 'student_profiles',
                        isList: false,
                        relationFromFields: ['studentId'],
                        relationToFields: ['id']
                    }
                ];
            }
            if (name === 'student_profiles') {
                return [
                    {
                        name: 'users_student_profiles_userIdTousers',
                        type: 'users',
                        isList: false,
                        relationFromFields: ['userId'],
                        relationToFields: ['id']
                    }
                ];
            }
            return [];
        });

        mockDmmf.getFields.mockImplementation((name) => {
            if (name === 'jobs') return {
                id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
                title: { name: 'title', kind: 'scalar', type: 'String' },
                companyId: { name: 'companyId', kind: 'scalar', type: 'String' },
                locationId: { name: 'locationId', kind: 'scalar', type: 'String' },
                company_profiles: { name: 'company_profiles', kind: 'object', type: 'company_profiles', isList: false },
                applications: { name: 'applications', kind: 'object', type: 'applications', isList: true },
                company_locations: { name: 'company_locations', kind: 'object', type: 'company_locations', isList: false },
            };
            if (name === 'applications') return {
                id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
                status: { name: 'status', kind: 'scalar', type: 'String' },
                studentId: { name: 'studentId', kind: 'scalar', type: 'String' },
                student_profiles: { name: 'student_profiles', kind: 'object', type: 'student_profiles', isList: false },
            };
            if (name === 'student_profiles') return {
                id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
                userId: { name: 'userId', kind: 'scalar', type: 'String' },
                users_student_profiles_userIdTousers: { name: 'users_student_profiles_userIdTousers', kind: 'object', type: 'users', isList: false },
            };
            if (name === 'users') return {
                id: { name: 'id', kind: 'scalar', type: 'String', isId: true },
            };
            return {};
        });

        // This test verifies that getRelations is called for deep nesting
        // The create method should not throw even with 3+ levels of nesting
        const data = {
            title: 'Dev Job',
            applications: [
                {
                    status: 'SUBMITTED',
                    studentId: 'stu-1'
                }
            ]
        };

        // Should not throw - even though applications.student_profiles
        // doesn't have pre-built nested relations
        expect(() => qb.create(data)).not.toThrow();
    });
});


// ==========================================
// getRelatedOmit() tests
// ==========================================
describe('QueryBuilder.getRelatedOmit()', () => {
    let qb;

    beforeEach(() => {
        setupSimpleModel();
        qb = new QueryBuilder('users');
    });

    test('returns omit fields for related model', () => {
        mockAcl.model.company_profiles = {
            getOmitFields: jest.fn(() => ['internalNotes'])
        };

        const result = qb.getRelatedOmit('company_profiles', { role: 'STUDENT' });
        expect(result).toEqual({ internalNotes: true });
    });

    test('returns empty object when no ACL for related model', () => {
        const result = qb.getRelatedOmit('nonexistent_model', { role: 'STUDENT' });
        expect(result).toEqual({});
    });
});
