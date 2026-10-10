// A scriptable fake of the ldapts Client: binds check a tiny directory, searches are
// answered by a per-test handler (and recorded, so tests can assert on the filters sent).
const directory: Record<string, string> = {};
const unreachable = new Set<string>();
let searchHandler: (base: string, options: any) => { searchEntries: any[] } = () => ({ searchEntries: [] });
const calls: Array<{ op: string; url: string; args: any[] }> = [];

jest.mock('ldapts', () => ({
    Client: class {
        url: string;
        constructor(options: { url: string }) { this.url = options.url; }
        private check(op: string, args: any[]) {
            calls.push({ op, url: this.url, args });
            if (unreachable.has(this.url)) {
                throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            }
        }
        async bind(dn: string, password: string) {
            this.check('bind', [dn, password]);
            if (directory[dn] === undefined || directory[dn] !== password) {
                throw Object.assign(new Error('InvalidCredentialsError'), { code: 49 });
            }
        }
        async search(base: string, options: any) {
            this.check('search', [base, options]);
            return searchHandler(base, options);
        }
        async startTLS() { this.check('startTLS', []); }
        async unbind() { calls.push({ op: 'unbind', url: this.url, args: [] }); }
    },
}));

import { LdapProvider, escapeFilterValue, escapeDnValue, formatObjectGuid } from '../../src/auth/providers/LdapProvider';
import { ErrorResponse } from '../../src/core/errors';

const SERVICE_DN = 'CN=svc-api,OU=Service,DC=corp,DC=example';
const ALICE_DN = 'CN=Alice Doe,OU=Users,DC=corp,DC=example';
const GUID = Buffer.from('04030201060508070090a0b0c0d0e0f0', 'hex');

const alice = {
    dn: ALICE_DN,
    sAMAccountName: 'alice',
    mail: 'alice@corp.example',
    displayName: 'Alice Doe',
    memberOf: ['CN=Domain Admins,OU=Groups,DC=corp,DC=example', 'CN=Staff\\, Berlin,OU=Groups,DC=corp,DC=example'],
    objectGUID: GUID,
};

const searchThenBind = (overrides: Record<string, unknown> = {}) => new LdapProvider({
    type: 'ldap',
    url: 'ldaps://dc1.corp.example',
    bindDN: SERVICE_DN,
    bindPassword: 'svc-pass',
    searchBase: 'DC=corp,DC=example',
    ...overrides,
} as any);

beforeEach(() => {
    for (const key of Object.keys(directory)) delete directory[key];
    directory[SERVICE_DN] = 'svc-pass';
    directory[ALICE_DN] = 'alice-pass';
    unreachable.clear();
    calls.length = 0;
    searchHandler = () => ({ searchEntries: [alice] });
});

describe('LDAP escaping', () => {
    it('escapes filter metacharacters (RFC 4515)', () => {
        expect(escapeFilterValue('*)(uid=*')).toBe('\\2a\\29\\28uid=\\2a');
        expect(escapeFilterValue('back\\slash')).toBe('back\\5cslash');
        expect(escapeFilterValue('nul\0')).toBe('nul\\00');
        expect(escapeFilterValue('plain.user@x')).toBe('plain.user@x');
    });

    it('escapes DN special characters (RFC 4514)', () => {
        expect(escapeDnValue('Smith, John')).toBe('Smith\\, John');
        expect(escapeDnValue('a+b=c;d<e>"f')).toBe('a\\+b\\=c\\;d\\<e\\>\\"f');
        expect(escapeDnValue('#lead')).toBe('\\#lead');
        expect(escapeDnValue(' lead')).toBe('\\ lead');
        expect(escapeDnValue('trail ')).toBe('trail\\ ');
    });

    it('formats an AD objectGUID with little-endian leading groups', () => {
        expect(formatObjectGuid(GUID)).toBe('01020304-0506-0708-0090-a0b0c0d0e0f0');
    });
});

describe('LdapProvider', () => {
    it('validates its configuration', () => {
        expect(() => new LdapProvider({ type: 'ldap', url: '' } as any)).toThrow(/url/);
        expect(() => new LdapProvider({ type: 'ldap', url: 'ldap://x' } as any)).toThrow(/bindTemplate|bindDN/);
    });

    it('authenticates with search-then-bind and maps the entry', async () => {
        const identity = await searchThenBind().authenticate('alice', 'alice-pass');

        expect(identity).toMatchObject({
            provider: 'ldap',
            subject: '01020304-0506-0708-0090-a0b0c0d0e0f0',
            username: 'alice',
            email: 'alice@corp.example',
            name: 'Alice Doe',
            // Full DNs — a bare CN like "Domain Admins" exists in every OU / trusted domain
            groups: ['CN=Domain Admins,OU=Groups,DC=corp,DC=example', 'CN=Staff\\, Berlin,OU=Groups,DC=corp,DC=example'],
        });
        const binds = calls.filter(c => c.op === 'bind').map(c => c.args[0]);
        expect(binds).toEqual([SERVICE_DN, ALICE_DN]); // service account first, then the user
        expect(calls.at(-1)!.op).toBe('unbind');
    });

    it('rejects an empty password without contacting the server (anonymous bind)', async () => {
        expect(await searchThenBind().authenticate('alice', '')).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it('returns null for a wrong password', async () => {
        expect(await searchThenBind().authenticate('alice', 'nope')).toBeNull();
    });

    it('returns null for an unknown user without a user bind', async () => {
        searchHandler = () => ({ searchEntries: [] });
        expect(await searchThenBind().authenticate('ghost', 'x')).toBeNull();
        expect(calls.filter(c => c.op === 'bind')).toHaveLength(1);
    });

    it('rejects ambiguous matches', async () => {
        searchHandler = () => ({ searchEntries: [alice, { ...alice, dn: 'CN=Alice Two,DC=corp,DC=example' }] });
        expect(await searchThenBind().authenticate('alice', 'alice-pass')).toBeNull();
    });

    it('treats sizeLimitExceeded as ambiguous', async () => {
        searchHandler = () => { throw Object.assign(new Error('sizeLimitExceeded'), { code: 4 }); };
        expect(await searchThenBind().authenticate('alice', 'alice-pass')).toBeNull();
    });

    it('escapes the username inside the search filter', async () => {
        searchHandler = () => ({ searchEntries: [] });
        await searchThenBind().authenticate('*)(uid=*', 'x');
        const filter = calls.find(c => c.op === 'search')!.args[1].filter;
        expect(filter).toContain('\\2a\\29\\28uid=\\2a');
        expect(filter).not.toContain('*)(uid=*');
    });

    it('answers 503 when the service account cannot bind', async () => {
        directory[SERVICE_DN] = 'rotated';
        await expect(searchThenBind().authenticate('alice', 'alice-pass'))
            .rejects.toMatchObject({ status_code: 503, message: 'auth_provider_unavailable' });
    });

    it('answers 503 for directory errors other than invalid credentials', async () => {
        searchHandler = () => { throw Object.assign(new Error('noSuchObject'), { code: 32 }); };
        await expect(searchThenBind().authenticate('alice', 'alice-pass')).rejects.toBeInstanceOf(ErrorResponse);
    });

    it('fails over to the next server', async () => {
        unreachable.add('ldaps://dc1.corp.example');
        const identity = await searchThenBind({ url: ['ldaps://dc1.corp.example', 'ldaps://dc2.corp.example'] })
            .authenticate('alice', 'alice-pass');
        expect(identity?.username).toBe('alice');
        expect(calls.filter(c => c.op === 'bind').map(c => c.url)).toContain('ldaps://dc2.corp.example');
    });

    it('answers 503 when no server is reachable', async () => {
        unreachable.add('ldaps://dc1.corp.example');
        await expect(searchThenBind().authenticate('alice', 'alice-pass')).rejects.toMatchObject({ status_code: 503 });
    });

    it('supports direct bind with a UPN template', async () => {
        directory['alice@corp.example'] = 'alice-pass';
        const p = new LdapProvider({ type: 'ldap', url: 'ldap://dc', bindTemplate: '{{username}}@corp.example' } as any);
        const identity = await p.authenticate('alice', 'alice-pass');
        expect(identity).toMatchObject({ username: 'alice', subject: 'alice@corp.example' });
        expect(calls.find(c => c.op === 'bind')!.args[0]).toBe('alice@corp.example');
    });

    it('direct bind reads the own entry when the tree is not searchable (OpenLDAP self-read ACL)', async () => {
        directory['uid=alice,ou=people,dc=example'] = 'alice-pass';
        searchHandler = (base, options) => {
            if (options.scope === 'base' && base === 'uid=alice,ou=people,dc=example') {
                return { searchEntries: [{ dn: base, uid: 'alice', mail: 'alice@corp.example' }] };
            }
            throw Object.assign(new Error('noSuchObject'), { code: 32 });
        };
        const p = new LdapProvider({ type: 'ldap', url: 'ldap://dc', bindTemplate: 'uid={{username}},ou=people,dc=example', searchBase: 'dc=example' } as any);
        expect(await p.authenticate('alice', 'alice-pass')).toMatchObject({ username: 'alice', email: 'alice@corp.example' });
    });

    it('direct bind never fails a verified password over unreadable attributes', async () => {
        directory['uid=alice,ou=people,dc=example'] = 'alice-pass';
        searchHandler = () => { throw Object.assign(new Error('insufficientAccessRights'), { code: 50 }); };
        const p = new LdapProvider({ type: 'ldap', url: 'ldap://dc', bindTemplate: 'uid={{username}},ou=people,dc=example', searchBase: 'dc=example' } as any);
        expect(await p.authenticate('alice', 'alice-pass')).toMatchObject({ username: 'alice', subject: 'uid=alice,ou=people,dc=example' });
    });

    it('escapes the username inside a DN template', async () => {
        const p = new LdapProvider({ type: 'ldap', url: 'ldap://dc', bindTemplate: 'uid={{username}},ou=people,dc=example' } as any);
        await p.authenticate('evil,ou=admins', 'x');
        expect(calls.find(c => c.op === 'bind')!.args[0]).toBe('uid=evil\\,ou\\=admins,ou=people,dc=example');
    });

    it('resolves nested AD groups with the in-chain matching rule', async () => {
        searchHandler = (_base, options) => options.filter.includes('1.2.840.113556.1.4.1941')
            ? { searchEntries: [{ dn: 'CN=Parent,DC=corp', cn: 'Parent' }, { dn: 'CN=Child,DC=corp', cn: 'Child' }] }
            : { searchEntries: [alice] };
        const identity = await searchThenBind({ nestedGroups: true }).authenticate('alice', 'alice-pass');
        expect(identity!.groups).toEqual(['CN=Parent,DC=corp', 'CN=Child,DC=corp']);
        const groupSearch = calls.filter(c => c.op === 'search')[1];
        expect(groupSearch.args[1].filter).toBe(`(member:1.2.840.113556.1.4.1941:=${ALICE_DN})`);
    });

    it('upgrades ldap:// with StartTLS when configured', async () => {
        await searchThenBind({ url: 'ldap://dc1', startTLS: true }).authenticate('alice', 'alice-pass');
        expect(calls[0].op).toBe('startTLS');
    });

    describe('revalidate()', () => {
        const identity = { provider: 'ldap', subject: 's', groups: [], roles: [], claims: { dn: ALICE_DN } } as any;

        it('reports enabled, AD-disabled, locked and deleted accounts', async () => {
            const p = searchThenBind();
            searchHandler = () => ({ searchEntries: [{ dn: ALICE_DN, userAccountControl: '512' }] });
            expect(await p.revalidate(identity)).toBe(true);
            searchHandler = () => ({ searchEntries: [{ dn: ALICE_DN, userAccountControl: '514' }] }); // 512 | ACCOUNTDISABLE
            expect(await p.revalidate(identity)).toBe(false);
            searchHandler = () => ({ searchEntries: [{ dn: ALICE_DN, pwdAccountLockedTime: '000001010000Z' }] });
            expect(await p.revalidate(identity)).toBe(false);
            searchHandler = () => { throw Object.assign(new Error('noSuchObject'), { code: 32 }); };
            expect(await p.revalidate(identity)).toBe(false);
        });

        it('cannot tell without a service account or when the directory is down', async () => {
            const direct = new LdapProvider({ type: 'ldap', url: 'ldap://dc', bindTemplate: '{{username}}@corp' } as any);
            expect(await direct.revalidate(identity)).toBeNull();
            unreachable.add('ldaps://dc1.corp.example');
            expect(await searchThenBind().revalidate(identity)).toBeNull();
        });
    });
});
