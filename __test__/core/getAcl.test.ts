/**
 * getAcl: src/config/acl.ts is the access control — one that does not load stops the API
 * instead of leaving models open.
 */
import path from 'path';

/** A fresh core/prisma — getAcl caches what it loaded. The generated client is not needed here */
const load = (): typeof import('../../src/core/prisma') => {
    let mod: typeof import('../../src/core/prisma') | undefined;
    jest.isolateModules(() => {
        jest.doMock(path.join(process.cwd(), 'prisma', 'client'), () => ({
            PrismaClient: class { $extends() { return this; } },
            Prisma: {},
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require('../../src/core/prisma');
    });
    return mod!;
};

afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../../src/config/acl');
    // getAcl loads acl.ts lazily — outside the isolated registry, so its module would be cached
    jest.resetModules();
});

describe('getAcl', () => {
    it('loads src/config/acl.ts', () => {
        jest.doMock('../../src/config/acl', () => ({ __esModule: true, default: { model: { post: { getAccessFilter: () => true } } } }));
        const { getAcl } = load();
        expect(Object.keys(getAcl().model)).toEqual(['post']);
    });

    it('an acl.ts that does not load stops the API — a missing import inside it is no missing acl.ts', () => {
        jest.doMock('../../src/config/acl', () => {
            throw Object.assign(new Error("Cannot find module '../models/Gone'"), { code: 'MODULE_NOT_FOUND' });
        });
        const { getAcl } = load();
        expect(() => getAcl()).toThrow(/^src\/config\/acl failed to load — the API does not start without its access control: Cannot find module/);
    });
});
