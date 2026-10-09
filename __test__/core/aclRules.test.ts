import fs from 'fs';
import os from 'os';
import path from 'path';
import { aclFromRules, validateAclRules, loadAclRules, isRulesEntry, AclRulesError } from '../../src/core/aclRules';
import { rlsFromConfig, validateRlsRules, loadRlsRules, isConfigContext } from '../../src/core/rlsRules';

const rules = {
    models: {
        post: {
            create: { admin: true, '*': true, guest: false },
            read: { admin: 'all', '*': { where: { author_id: '$user.id' } }, guest: 'none' },
            update: { admin: 'all', '*': { where: { author_id: '$user.id', tenant_id: '$user.org.tenant' } } },
            delete: { admin: 'all' },
            hide: { '*': ['internal_notes'], admin: [] },
            write: { '*': ['title', 'content'] },
        },
    },
} as const;

describe('ACL rules (config/acl.json)', () => {
    const acl = aclFromRules(rules as any).post;
    const admin = { id: 1, role: 'admin' };
    const user = { id: 7, role: 'editor', org: { tenant: 3 } } as any;

    it('picks the rule of the role, "*" for every other role', () => {
        expect(acl.getAccessFilter!(admin)).toBe(true);
        expect(acl.getAccessFilter!(user)).toEqual({ author_id: 7 });
        expect(acl.getAccessFilter!({ id: 2, role: 'guest' })).toBe(false);
        expect(acl.canCreate!({ id: 2, role: 'guest' })).toBe(false);
        expect(acl.canCreate!(user)).toBe(true);
    });

    it('resolves nested $user attributes; a missing one grants nothing', () => {
        expect(acl.getUpdateFilter!(user)).toEqual({ author_id: 7, tenant_id: 3 });
        expect(acl.getUpdateFilter!({ id: 7, role: 'editor' } as any)).toBe(false);
    });

    it('fails closed: no rule for the role, or no rule for the action', () => {
        expect(acl.getDeleteFilter!(user)).toBe(false); // delete has no "*"
        expect(aclFromRules({ models: { x: {} } } as any).x.getAccessFilter!(admin)).toBe(false);
        expect(aclFromRules({ models: { x: {} } } as any).x.canCreate!(admin)).toBe(false);
    });

    it('hidden and writable fields per role; copies, not the rule arrays', () => {
        expect(acl.getOmitFields!(user)).toEqual(['internal_notes']);
        expect(acl.getOmitFields!(admin)).toEqual([]);
        expect(acl.getWritableFields!(user)).toEqual(['title', 'content']);
        expect(aclFromRules({ models: { x: {} } } as any).x.getWritableFields!(user)).toBeNull();
        acl.getOmitFields!(user).push('mutated');
        expect(acl.getOmitFields!(user)).toEqual(['internal_notes']);
    });

    it('uses a custom role field', () => {
        const custom = aclFromRules({ roleField: 'kind', models: { x: { read: { boss: 'all' } } } } as any).x;
        expect(custom.getAccessFilter!({ id: 1, kind: 'boss' } as any)).toBe(true);
        expect(custom.getAccessFilter!({ id: 1, role: 'boss' } as any)).toBe(false);
    });

    it('marks its entries, so code entries can be told apart', () => {
        expect(isRulesEntry(acl)).toBe(true);
        expect(isRulesEntry({ getAccessFilter: () => true })).toBe(false);
    });

    it('validates structure, and models and fields against the schema', () => {
        expect(validateAclRules(rules)).toEqual([]);
        const schema = { post: ['id', 'title', 'content', 'author_id', 'tenant_id', 'internal_notes'] };
        expect(validateAclRules(rules, schema)).toEqual([]);
        expect(validateAclRules({ models: { nope: {}, post: { read: { '*': 'some' }, create: { '*': 'yes' }, hide: { '*': ['ghost'] }, fly: {} } } }, schema))
            .toEqual([
                'nope: no such model in the schema',
                'post.read.*: "all", "none" or { "where": { ... } }',
                'post.create.*: true or false',
                'post.hide.*: unknown field(s) ghost',
                'post.fly: unknown — use create, read, update, delete, hide, write',
            ]);
        expect(validateAclRules({ models: { post: { read: { '*': { where: { owner: '$user.id' } } } } } }, schema))
            .toEqual(['post.read.*: unknown field(s) owner']);
    });

    it('loads config/acl.json: none → null; broken → AclRulesError (never fail open)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-rules-'));
        try {
            const file = path.join(dir, 'acl.json');
            expect(loadAclRules(file)).toBeNull();
            fs.writeFileSync(file, '{ broken');
            expect(() => loadAclRules(file)).toThrow(AclRulesError);
            fs.writeFileSync(file, JSON.stringify({ models: { x: { read: { '*': 'maybe' } } } }));
            expect(() => loadAclRules(file)).toThrow(/x.read/);
            fs.writeFileSync(file, JSON.stringify(rules));
            expect(loadAclRules(file)).toEqual(rules);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('RLS variables (config/rls.json)', () => {
    const context = rlsFromConfig({ variables: { current_user_id: 'user.id', current_org: 'user.org.id', current_tenant_id: 'header.X-Tenant-Id', flag: 'user.active' } });

    it('takes values from the user and request headers; missing ones are null (not set)', () => {
        expect(context({ user: { id: 5, org: { id: 9 }, active: true }, headers: { 'x-tenant-id': 't1' } }))
            .toEqual({ current_user_id: 5, current_org: 9, current_tenant_id: 't1', flag: 'true' });
        expect(context({ user: null, headers: {} })).toEqual({ current_user_id: null, current_org: null, current_tenant_id: null, flag: null });
        expect(context({ user: { id: { nested: 1 } }, headers: { 'x-tenant-id': ['a', 'b'] } })).toMatchObject({ current_user_id: null, current_tenant_id: 'a' });
    });

    it('without a config file: no variables', () => {
        expect(rlsFromConfig(null)({ user: { id: 1 } })).toEqual({});
        expect(isConfigContext(context)).toBe(true);
        expect(isConfigContext(() => ({}))).toBe(false);
    });

    it('validates names and sources', () => {
        expect(validateRlsRules({ variables: { ok_name: 'user.id', 'bad-name': 'user.id', other: 'query.x' } }))
            .toEqual(['bad-name: letters, digits and _ only', 'other: "user.<attribute>" or "header.<name>"']);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rls-rules-'));
        try {
            const file = path.join(dir, 'rls.json');
            expect(loadRlsRules(file)).toBeNull();
            fs.writeFileSync(file, '{"variables":{"x":"cookie.y"}}');
            expect(() => loadRlsRules(file)).toThrow(/x:/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
