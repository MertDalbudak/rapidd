import { IdentityResolver, linkFromEnv } from '../../src/auth/identity';
import type { ExternalIdentity } from '../../src/types';

const identity = (overrides: Partial<ExternalIdentity> = {}): ExternalIdentity => ({
    provider: 'ldap',
    subject: 'guid-1',
    username: 'alice',
    email: 'alice@corp.example',
    name: 'Alice',
    groups: ['Staff', 'Domain Admins'],
    roles: [],
    claims: { employeeId: 'E-7' },
    ...overrides,
});

function userTable(rows: Record<string, unknown>[] = []) {
    const model = {
        rows,
        findMany: jest.fn(async ({ where }: any) => rows.filter((r) => Object.entries(where).every(([k, v]: [string, any]) =>
            typeof v === 'object' && v ? String(r[k]).toLowerCase() === String(v.equals).toLowerCase() : r[k] === v))),
        findFirst: jest.fn(async ({ where }: any) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null),
        create: jest.fn(async ({ data }: any) => {
            const row = { id: rows.length + 1, ...data };
            rows.push(row);
            return row;
        }),
    };
    const source = {
        getUserModel: () => model,
        buildUserQuery: () => ({}),
        sanitizeUser: (u: any) => {
            if (!u) return null;
            const { password: _p, ...rest } = u;
            return rest;
        },
    };
    return { model, source };
}

describe('IdentityResolver', () => {
    it('passes through identities that already carry an app user (local provider)', async () => {
        const { source } = userTable();
        const resolved = await new IdentityResolver(source, {}).resolve(identity({ user: { id: 9, role: 'x' } }));
        expect(resolved).toEqual({ user: { id: 9, role: 'x' }, persisted: true });
    });

    it('links to a user-table row by email by default', async () => {
        const { source } = userTable([{ id: 1, email: 'alice@corp.example', role: 'admin', password: 'hash' }]);
        const resolved = await new IdentityResolver(source, {}).resolve(identity());
        expect(resolved).toEqual({ user: { id: 1, email: 'alice@corp.example', role: 'admin' }, persisted: true });
    });

    it('matches emails case-insensitively on PostgreSQL', async () => {
        const { source, model } = userTable([{ id: 1, email: 'Alice@Corp.Example', role: 'admin' }]);
        await new IdentityResolver(source, {}, { caseInsensitiveEmail: true }).resolve(identity());
        expect(model.findMany.mock.calls[0][0].where).toEqual({ email: { equals: 'alice@corp.example', mode: 'insensitive' } });
    });

    it('links by a custom field and claim', async () => {
        const { source } = userTable([{ id: 3, personnel_no: 'E-7', role: 'staff' }]);
        const resolved = await new IdentityResolver(source, { link: { field: 'personnel_no', from: 'employeeId' } }).resolve(identity());
        expect(resolved!.user.id).toBe(3);
    });

    it('rejects identities that match several users', async () => {
        const { source } = userTable([{ id: 1, email: 'alice@corp.example' }, { id: 2, email: 'alice@corp.example' }]);
        expect(await new IdentityResolver(source, {}).resolve(identity())).toBeNull();
    });

    it('rejects unknown identities unless provisioning is configured', async () => {
        const { source, model } = userTable();
        expect(await new IdentityResolver(source, {}).resolve(identity())).toBeNull();

        const resolver = new IdentityResolver(source, {
            provision: (id) => ({ email: id.email, name: id.name, role: 'user' }),
        });
        const resolved = await resolver.resolve(identity());
        expect(resolved).toMatchObject({ user: { email: 'alice@corp.example', role: 'user' }, persisted: true });
        expect(model.create).toHaveBeenCalledTimes(1);
    });

    it('provision returning null rejects the login', async () => {
        const { source } = userTable();
        expect(await new IdentityResolver(source, { provision: () => null }).resolve(identity())).toBeNull();
    });

    it('recovers from a provisioning race (unique violation)', async () => {
        const { source, model } = userTable();
        model.create.mockImplementationOnce(async () => {
            model.rows.push({ id: 5, email: 'alice@corp.example' }); // the concurrent login won
            throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        });
        const resolved = await new IdentityResolver(source, { provision: (id) => ({ email: id.email }) }).resolve(identity());
        expect(resolved!.user.id).toBe(5);
    });

    it('rejects identities lacking the link attribute', async () => {
        const { source } = userTable([{ id: 1, email: 'alice@corp.example' }]);
        expect(await new IdentityResolver(source, {}).resolve(identity({ email: undefined }))).toBeNull();
    });

    it('builds a claims-only user when there is no user table: its groups and IdP roles as data, no role', async () => {
        const source = { getUserModel: () => null, buildUserQuery: () => ({}), sanitizeUser: (u: any) => u };
        const resolved = await new IdentityResolver(source, {}).resolve(identity({ roles: ['editor'] }));
        expect(resolved).toEqual({
            user: {
                id: 'ldap:guid-1', email: 'alice@corp.example', name: 'Alice', username: 'alice',
                groups: ['Staff', 'Domain Admins'], roles: ['editor'], provider: 'ldap',
            },
            persisted: false,
        });
    });

    it('builds a claims-only user when linking is disabled', async () => {
        const { source } = userTable([{ id: 1, email: 'alice@corp.example' }]);
        const resolved = await new IdentityResolver(source, { link: false }).resolve(identity());
        expect(resolved!.user.id).toBe('ldap:guid-1'); // namespaced: subjects are only unique per IdP
    });

    it('decides links exactly — no LIKE wildcards, accents or padding from the database', async () => {
        // The fake table behaves like PostgreSQL ILIKE / MySQL accent-insensitive collations:
        // it returns every row the wildcard / folded comparison would
        const rows = [{ id: 1, email: 'alice@corp.com' }, { id: 2, email: 'admin@corp.com' }];
        const model = {
            findMany: jest.fn(async () => rows),
            findFirst: jest.fn(), create: jest.fn(),
        };
        const source = { getUserModel: () => model, buildUserQuery: () => ({}), sanitizeUser: (u: any) => u };
        const resolver = new IdentityResolver(source, {}, { caseInsensitiveEmail: true });
        expect(await resolver.resolve(identity({ email: 'a_ice@corp.com' }))).toBeNull();
        expect(await resolver.resolve(identity({ email: '%dmin@corp.com' }))).toBeNull();
        expect(await resolver.resolve(identity({ email: 'alicé@corp.com' }))).toBeNull();
        expect((await resolver.resolve(identity({ email: 'ALICE@corp.com' })))!.user.id).toBe(1);
    });

    it('prefers the per-provider link config', async () => {
        const { source } = userTable([{ id: 8, username: 'alice' }]);
        const provider = { name: 'ldap', type: 'ldap', link: { field: 'username', from: 'username' } };
        const resolver = new IdentityResolver(source, { link: { field: 'email', from: 'email' } });
        expect((await resolver.resolve(identity(), provider as any))!.user.id).toBe(8);
    });

    it('hands full control to resolveUser', async () => {
        const { source } = userTable([{ id: 1, email: 'alice@corp.example' }]);
        const resolveUser = jest.fn(async (id: ExternalIdentity, helpers: any) => {
            const row = await helpers.findUser({ email: id.email });
            return { ...row, groups: id.groups };
        });
        const resolver = new IdentityResolver(source, { resolveUser });
        const resolved = await resolver.resolve(identity());
        expect(resolved).toEqual({ user: { id: 1, email: 'alice@corp.example', groups: ['Staff', 'Domain Admins'] }, persisted: false });
    });
});

describe('env parsing', () => {
    it('parses AUTH_LINK', () => {
        expect(linkFromEnv('')).toBeUndefined();
        expect(linkFromEnv('false')).toBe(false);
        expect(linkFromEnv('email')).toEqual({ field: 'email', from: 'email' });
        expect(linkFromEnv('login_name:username')).toEqual({ field: 'login_name', from: 'username' });
    });
});
