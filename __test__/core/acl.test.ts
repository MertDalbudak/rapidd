const mockModels = [{ name: 'users', fields: [] }, { name: 'sessions', fields: [] }, { name: 'posts', fields: [] }];

jest.mock('../../src/core/dmmf', () => ({
    getDMMFSync: jest.fn(() => ({ datamodel: { models: mockModels } })),
}));

import { applyAclDefault, auditAcl, DENY_ALL } from '../../src/core/acl';
import type { AclConfig } from '../../src/types';

const config = (): AclConfig => ({ model: { users: { getAccessFilter: () => true } } });

describe('ACL default policy', () => {
    it('allow mode (default) leaves unconfigured models unrestricted', () => {
        const acl = applyAclDefault(config(), undefined);
        expect(acl.model.sessions).toBeUndefined();
    });

    it('deny mode closes unconfigured models only', () => {
        const acl = applyAclDefault(config(), 'deny');
        expect(acl.model.sessions).toBe(DENY_ALL);
        expect(acl.model.users.getAccessFilter!({ id: 1, role: 'x' })).toBe(true);
        expect(DENY_ALL.canCreate!({ id: 1, role: 'x' })).toBe(false);
        expect(DENY_ALL.getAccessFilter!({ id: 1, role: 'x' })).toBe(false);
        expect(DENY_ALL.getUpdateFilter!({ id: 1, role: 'x' })).toBe(false);
        expect(DENY_ALL.getDeleteFilter!({ id: 1, role: 'x' })).toBe(false);
    });

    it('deny mode does not invent entries for non-models', () => {
        const acl = applyAclDefault(config(), 'deny');
        expect((acl.model as any).notAModel).toBeUndefined();
        expect(Object.keys(acl.model)).toEqual(['users']);
    });

    it('audits unconfigured models in either mode', () => {
        expect(auditAcl(config(), undefined)).toEqual(['sessions', 'posts']);
        expect(auditAcl(applyAclDefault(config(), 'deny'), 'deny')).toEqual(['sessions', 'posts']);
        expect(auditAcl({ model: { users: {}, sessions: {}, posts: {} } })).toEqual([]);
    });
});
