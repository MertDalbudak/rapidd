/**
 * A minimal, real-HTTP OpenID Connect provider for tests: discovery, JWKS (with key
 * rotation), authorization endpoint (auto-approves), token endpoint (verifies PKCE +
 * client auth), userinfo and RFC 7662 introspection.
 */
import http from 'http';
import crypto, { KeyObject } from 'crypto';
import jwt from 'jsonwebtoken';

interface SigningKey { kid: string; privateKey: KeyObject; publicKey: KeyObject }

export interface MockIdp {
    issuer: string;
    clientId: string;
    clientSecret: string;
    /** Claims of the user who "logs in" at /authorize */
    user: Record<string, unknown>;
    /** Sign an access token (defaults: iss, aud=clientId, exp=+1h, kid=current key) */
    sign(claims?: Record<string, unknown>, options?: { kid?: string | null; algorithm?: jwt.Algorithm; key?: KeyObject | string; expiresIn?: number }): string;
    /** Replace the signing key (old key disappears from JWKS) */
    rotateKeys(): void;
    /** Opaque tokens the introspection endpoint knows about */
    opaqueTokens: Map<string, Record<string, unknown>>;
    hits: Record<string, number>;
    /** Simulate the IdP being down */
    down: boolean;
    /** Override the issuer the discovery document reports */
    reportedIssuer?: string;
    /** Corrupt the nonce placed in id_tokens */
    badNonce: boolean;
    /** Roles placed only in access tokens (realm_access.roles) */
    accessRoles: string[];
    close(): Promise<void>;
}

function newKey(): SigningKey {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { kid: crypto.randomUUID(), privateKey, publicKey };
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => resolve(data));
    });
}

export async function startMockIdp(): Promise<MockIdp> {
    let key = newKey();
    const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string }>();
    const accessTokens = new Map<string, Record<string, unknown>>();

    const idp: MockIdp = {
        issuer: '',
        clientId: 'rapidd-client',
        clientSecret: 'rapidd-secret',
        user: { sub: 'user-123', email: 'alice@example.com', email_verified: true, name: 'Alice Doe', preferred_username: 'alice', groups: ['Staff'] },
        opaqueTokens: new Map(),
        hits: {},
        down: false,
        badNonce: false,
        accessRoles: [],
        sign(claims = {}, options = {}) {
            const { kid = key.kid, algorithm = 'RS256', key: signingKey = key.privateKey, expiresIn = 3600 } = options;
            return jwt.sign(
                { iss: idp.issuer, aud: idp.clientId, sub: idp.user.sub, ...claims },
                signingKey as any,
                { algorithm, expiresIn, ...(kid ? { keyid: kid } : {}) }
            );
        },
        rotateKeys() { key = newKey(); },
        async close() { await new Promise<void>((r) => server.close(() => r())); },
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url!, idp.issuer);
        idp.hits[url.pathname] = (idp.hits[url.pathname] || 0) + 1;
        const json = (status: number, body: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (idp.down) return json(503, { error: 'down' });

        const body = new URLSearchParams(await readBody(req));
        const clientAuthOk = () => {
            const header = req.headers.authorization;
            if (header?.startsWith('Basic ')) {
                const [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
                return id === idp.clientId && secret === idp.clientSecret;
            }
            return body.get('client_id') === idp.clientId && body.get('client_secret') === idp.clientSecret;
        };

        switch (url.pathname) {
            case '/.well-known/openid-configuration':
                return json(200, {
                    issuer: idp.reportedIssuer ?? idp.issuer,
                    authorization_endpoint: `${idp.issuer}/authorize`,
                    token_endpoint: `${idp.issuer}/token`,
                    userinfo_endpoint: `${idp.issuer}/userinfo`,
                    jwks_uri: `${idp.issuer}/jwks`,
                    introspection_endpoint: `${idp.issuer}/introspect`,
                    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
                });
            case '/jwks':
                return json(200, { keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: key.kid, use: 'sig', alg: 'RS256' }] });
            case '/authorize': {
                // The "user" approves immediately
                const code = crypto.randomUUID();
                codes.set(code, {
                    nonce: url.searchParams.get('nonce')!,
                    challenge: url.searchParams.get('code_challenge')!,
                    redirectUri: url.searchParams.get('redirect_uri')!,
                });
                const back = new URL(url.searchParams.get('redirect_uri')!);
                back.searchParams.set('code', code);
                back.searchParams.set('state', url.searchParams.get('state')!);
                res.writeHead(302, { Location: back.toString() });
                return res.end();
            }
            case '/token': {
                if (!clientAuthOk()) return json(401, { error: 'invalid_client' });
                const grant = codes.get(body.get('code') || '');
                codes.delete(body.get('code') || '');
                const verifier = body.get('code_verifier') || '';
                const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
                if (!grant || grant.challenge !== challenge || grant.redirectUri !== body.get('redirect_uri')) {
                    return json(400, { error: 'invalid_grant' });
                }
                // Like Keycloak: the access token is a JWT carrying roles the id_token lacks
                const accessToken = idp.sign({ ...idp.user, realm_access: { roles: idp.accessRoles } });
                accessTokens.set(accessToken, idp.user);
                return json(200, {
                    token_type: 'Bearer',
                    access_token: accessToken,
                    id_token: idp.sign({ ...idp.user, nonce: idp.badNonce ? 'wrong' : grant.nonce }),
                });
            }
            case '/userinfo': {
                const token = req.headers.authorization?.replace('Bearer ', '') || '';
                const claims = accessTokens.get(token);
                return claims ? json(200, claims) : json(401, { error: 'invalid_token' });
            }
            case '/introspect': {
                if (!clientAuthOk()) return json(401, { error: 'invalid_client' });
                const claims = idp.opaqueTokens.get(body.get('token') || '');
                return json(200, claims ? { active: true, ...claims } : { active: false });
            }
            default:
                return json(404, { error: 'not_found' });
        }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    idp.issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return idp;
}
