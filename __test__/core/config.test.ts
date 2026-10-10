import { substituteEnv } from '../../src/core/config';

describe('substituteEnv', () => {
    const saved = { ...process.env };
    afterEach(() => { process.env = { ...saved }; });

    it('replaces ${VAR} and ${VAR:-default} everywhere in the structure', () => {
        process.env.SEVDESK_KEY = 'k-123';
        delete process.env.GRAPH_TENANT;
        const missing = new Set<string>();
        const out = substituteEnv({
            services: {
                sevdesk: { authorization: { type: 'api-key', key: '${SEVDESK_KEY}' } },
                graph: { hostname: 'login.microsoftonline.com', path: '/${GRAPH_TENANT:-common}/oauth2', scopes: ['${SCOPE}'] },
            },
            port: 443,
            enabled: true,
        }, missing);

        expect(out.services.sevdesk.authorization.key).toBe('k-123');
        expect(out.services.graph.path).toBe('/common/oauth2');
        expect(out.services.graph.scopes).toEqual(['']);
        expect(out.port).toBe(443);
        expect(out.enabled).toBe(true);
        expect([...missing]).toEqual(['SCOPE']);
    });

    it('leaves strings without references untouched', () => {
        expect(substituteEnv('plain $HOME {{param}}')).toBe('plain $HOME {{param}}');
    });
});
