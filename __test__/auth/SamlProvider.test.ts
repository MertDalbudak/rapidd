/**
 * The SAML provider against a test IdP that signs with real keys: the authentication request,
 * what a response must be to be accepted (signature, request id, audience, issuer, validity),
 * the identity it becomes, and this API's metadata.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { SamlProvider } from '../../src/auth/providers/SamlProvider';
import { parseIdpMetadata, certificateInfo } from '../../src/auth/providers/samlMetadata';
import { SessionStoreManager } from '../../src/auth/stores';
import { keys, idpMetadata, readRequest, samlResponse, IDP_ENTITY_ID, IDP_SSO_URL } from '../helpers/samlIdp';
import type { ResponseOptions } from '../helpers/samlIdp';
import type { SamlProviderConfig } from '../../src/types';

const ACS = 'https://api.example.com/auth/saml/callback';
const SP = 'https://api.example.com/auth/saml/metadata';

const stores: SessionStoreManager[] = [];
afterAll(async () => {
    await Promise.all(stores.map((s) => s.destroy()));
});

function provider(config: Partial<SamlProviderConfig> = {}, store = new SessionStoreManager({ store: 'memory', ttl: 3600 })) {
    stores.push(store);
    return new SamlProvider({ type: 'saml', idpMetadata: idpMetadata(), ...config }, { sessionStore: () => store });
}

/** A login begun at the provider and the IdP's answer to it */
async function answered(p: SamlProvider, options: Partial<ResponseOptions> = {}) {
    const begun = await p.beginLogin({ redirectUri: ACS });
    const request = readRequest(begun.url);
    const SAMLResponse = await samlResponse({ inResponseTo: request.id, ...options });
    return { ...begun, request, body: { SAMLResponse, RelayState: begun.state } };
}

const rejected = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ status_code: 401, message: 'auth_login_failed' });

describe('identity provider metadata', () => {
    it('entity id, the HTTP-Redirect sign-on URL, the signing certificates (not the encryption one), NameID formats', () => {
        const idp = parseIdpMetadata(idpMetadata({ certs: [keys.idp.cert, keys.sp.cert] }));
        expect(idp).toMatchObject({ entityId: IDP_ENTITY_ID, ssoUrl: IDP_SSO_URL, ssoPostUrl: IDP_SSO_URL, wantAuthnRequestsSigned: false });
        expect(idp.certificates).toHaveLength(2);
        expect(idp.nameIdFormats).toEqual(['urn:oasis:names:tc:SAML:2.0:nameid-format:persistent']);
        expect(parseIdpMetadata(idpMetadata({ redirect: false })).ssoUrl).toBeNull();
    });

    it('a federation file names its identity providers — SAML_IDP_ENTITY_ID chooses one', () => {
        const entity = (id: string) => idpMetadata({ entityId: id }).replace(/^<\?xml[^>]*>\s*/, '').replace(' xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"', '');
        const federation = `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${entity('https://a.example')}${entity('https://b.example')}</md:EntitiesDescriptor>`;
        expect(() => parseIdpMetadata(federation)).toThrow('It describes 2 identity providers (https://a.example, https://b.example) — choose one with SAML_IDP_ENTITY_ID');
        expect(parseIdpMetadata(federation, 'https://b.example').entityId).toBe('https://b.example');
        expect(() => parseIdpMetadata(federation, 'https://c.example')).toThrow('No identity provider https://c.example in it');
    });

    it('says what is wrong with the wrong file', async () => {
        expect(() => parseIdpMetadata('<nope')).toThrow(/^Not valid XML/);
        expect(() => parseIdpMetadata('<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"><md:SPSSODescriptor/></md:EntityDescriptor>'))
            .toThrow('This is a service provider’s metadata — the identity provider’s is needed');
        expect(() => parseIdpMetadata(idpMetadata({ certs: [] }))).toThrow('The identity provider publishes no signing certificate');
    });

    it('certificates: subject, expiry and whether it is close', () => {
        const [body] = parseIdpMetadata(idpMetadata()).certificates;
        expect(certificateInfo(body)).toMatchObject({ subject: 'CN=Rapidd Test IdP', expired: false, expiresSoon: false, fingerprint: expect.stringMatching(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/) });
        expect(certificateInfo(body, Date.parse('2200-01-01'))).toMatchObject({ expired: true });
    });
});

describe('the authentication request', () => {
    it('goes to the IdP with RelayState = state, for this API — no fixed way of signing in demanded', async () => {
        const p = provider();
        const { url, state, flow } = await p.beginLogin({ redirectUri: ACS });
        expect(url.startsWith(`${IDP_SSO_URL}?`)).toBe(true);
        const request = readRequest(url);
        expect(request).toMatchObject({ relayState: state, acs: ACS, issuer: SP, signed: false });
        expect(flow).toEqual({ requestId: request.id, redirectUri: ACS });
        expect(request.id).toMatch(/^_[0-9a-f]{40}$/);
        expect(request.xml).not.toContain('RequestedAuthnContext');
        expect(request.xml).toContain('Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"');
    });

    it('with a private key it is signed (RSA-SHA256) — verifiable with the certificate', async () => {
        const p = provider({ privateKey: keys.sp.key, cert: keys.sp.cert });
        const { url } = await p.beginLogin({ redirectUri: ACS });
        const query = new URL(url).search.slice(1);
        const params = new URLSearchParams(query);
        expect(params.get('SigAlg')).toBe('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');
        // HTTP-Redirect binding: the signature covers SAMLRequest, RelayState and SigAlg as sent
        const signedPart = query.split('&').filter((p) => !p.startsWith('Signature=')).join('&');
        expect(crypto.verify('sha256', Buffer.from(signedPart), keys.sp.cert, Buffer.from(params.get('Signature')!, 'base64'))).toBe(true);
    });
});

describe('responses', () => {
    it('a signed assertion becomes the identity — repeated attributes keep every value', async () => {
        const p = provider();
        const { body, flow } = await answered(p, {
            attributes: [['email', 'ada@example.com'], ['uid', 'ada'], ['givenName', 'Ada'], ['sn', 'Lovelace'],
                ['Role', 'admin'], ['Role', 'editor'], ['http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', 'g-1']],
        });
        const posted = await p.receivePost(body, { redirectUri: ACS });
        expect(posted.state).toBe(body.RelayState);
        const identity = await p.completeLogin({}, flow, posted.data);
        expect(identity).toMatchObject({
            provider: 'saml', subject: 'u-4711', email: 'ada@example.com', username: 'ada', name: 'Ada Lovelace',
            roles: ['admin', 'editor'], groups: ['g-1'],
            claims: { nameID: 'u-4711', issuer: IDP_ENTITY_ID, attributes: { Role: ['admin', 'editor'] } },
        });
    });

    it('a signed response (assertion unsigned) is accepted too — and an encrypted assertion with this API\'s key', async () => {
        const p = provider();
        const signedResponse = await answered(p, { sign: 'response' });
        expect((await p.receivePost(signedResponse.body, { redirectUri: ACS })).data.requestId).toBe(signedResponse.flow.requestId);

        const withKey = provider({ privateKey: keys.sp.key, cert: keys.sp.cert });
        const encrypted = await answered(withKey, { encryptFor: keys.sp.cert, attributes: [['email', 'ada@example.com']] });
        expect((await withKey.receivePost(encrypted.body, { redirectUri: ACS })).data.identity).toMatchObject({ email: 'ada@example.com' });
        await rejected(p.receivePost((await answered(p, { encryptFor: keys.sp.cert })).body, { redirectUri: ACS }));
    });

    it('rejects responses without a valid signature of the IdP', async () => {
        const p = provider();
        await rejected(p.receivePost((await answered(p, { sign: 'none' })).body, { redirectUri: ACS }));
        await rejected(p.receivePost((await answered(p, { signer: keys.other })).body, { redirectUri: ACS }));
        const tampered = await answered(p, { attributes: [['email', 'ada@example.com']], tamper: (xml) => xml.replace('ada@example.com', 'eve@example.com') });
        await rejected(p.receivePost(tampered.body, { redirectUri: ACS }));
    });

    it('accepts each request id once — and only ids it sent', async () => {
        const p = provider();
        const first = await answered(p);
        await p.receivePost(first.body, { redirectUri: ACS });
        await rejected(p.receivePost(first.body, { redirectUri: ACS }));
        await rejected(p.receivePost({ SAMLResponse: await samlResponse({ inResponseTo: '_never-sent' }), RelayState: 's' }, { redirectUri: ACS }));
        await rejected(p.receivePost({ SAMLResponse: await samlResponse({ inResponseTo: null }), RelayState: 's' }, { redirectUri: ACS }));
    });

    it('rejects assertions for another audience, from another issuer, or expired', async () => {
        const p = provider();
        await rejected(p.receivePost((await answered(p, { audience: 'https://other.example.com' })).body, { redirectUri: ACS }));
        await rejected(p.receivePost((await answered(p, { issuer: 'https://evil.example.com' })).body, { redirectUri: ACS }));
        await rejected(p.receivePost((await answered(p, { notOnOrAfter: new Date(Date.now() - 120_000) })).body, { redirectUri: ACS }));
    });

    it('an IdP error status, or a POST without RelayState (a login the IdP began), is no login', async () => {
        const p = provider();
        await rejected(p.receivePost((await answered(p, { status: 'urn:oasis:names:tc:SAML:2.0:status:AuthnFailed' })).body, { redirectUri: ACS }));
        const { body } = await answered(p);
        await expect(p.receivePost({ SAMLResponse: body.SAMLResponse }, { redirectUri: ACS })).rejects.toMatchObject({ status_code: 400 });
    });

    it('binds the answer to the login it answers: another browser\'s request id is refused (login CSRF)', async () => {
        const p = provider();
        const attacker = await answered(p);
        const victim = await p.beginLogin({ redirectUri: ACS });
        const posted = await p.receivePost(attacker.body, { redirectUri: ACS });
        await rejected(p.completeLogin({}, victim.flow, posted.data));
        await rejected(p.completeLogin({}, attacker.flow, undefined));
    });

    it('instances sharing a session store accept each other\'s requests (Redis: every instance)', async () => {
        const shared = new SessionStoreManager({ store: 'memory', ttl: 3600 });
        const a = provider({}, shared);
        const b = provider({}, shared);
        const { body } = await answered(a);
        await expect(b.receivePost(body, { redirectUri: ACS })).resolves.toMatchObject({ state: body.RelayState });
        await rejected(provider().receivePost((await answered(a)).body, { redirectUri: ACS }));
    });

    it('attribute names can be set; an emailAddress NameID is the email', async () => {
        const p = provider({ attributes: { groups: 'department', email: 'Mail-Address' } });
        const { body } = await answered(p, {
            nameId: 'ada@example.com', nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            attributes: [['department', 'Research'], ['groups', 'ignored'], ['mail-address', 'ada@corp.example']],
        });
        expect((await p.receivePost(body, { redirectUri: ACS })).data.identity).toMatchObject({ email: 'ada@corp.example', groups: ['Research'] });

        const plain = provider();
        const byNameId = await answered(plain, { nameId: 'ada@example.com', nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' });
        expect((await plain.receivePost(byNameId.body, { redirectUri: ACS })).data.identity).toMatchObject({ subject: 'ada@example.com', email: 'ada@example.com' });
    });
});

describe('this API\'s metadata', () => {
    it('entity id and assertion consumer URL — with a key also its certificate, for signing and encryption', async () => {
        const plain = (await provider().serviceMetadata({ redirectUri: ACS })).body;
        expect(plain).toContain(`entityID="${SP}"`);
        expect(plain).toContain(`Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${ACS}"`);
        expect(plain).toContain('WantAssertionsSigned="true"');
        expect(plain).not.toContain('KeyDescriptor');

        const withKey = await provider({ privateKey: keys.sp.key, cert: keys.sp.cert, spEntityId: 'urn:rapidd:api' }).serviceMetadata({ redirectUri: ACS });
        expect(withKey.contentType).toBe('application/samlmetadata+xml');
        expect(withKey.body).toContain('entityID="urn:rapidd:api"');
        expect(withKey.body).toContain('AuthnRequestsSigned="true"');
        expect(withKey.body).toContain('<KeyDescriptor use="signing">');
        expect(withKey.body).toContain('<KeyDescriptor use="encryption">');
    });
});

describe('configuration', () => {
    it('needs the IdP metadata — and a metadata URL over https', () => {
        const cwd = process.cwd();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-saml-'));
        try {
            process.chdir(dir);
            expect(() => new SamlProvider({ type: 'saml' })).toThrow('SAML provider "saml" needs the identity provider\'s metadata — SAML_IDP_METADATA_URL, or the file');
            fs.mkdirSync('config');
            fs.writeFileSync('config/saml-idp-metadata.xml', idpMetadata());
            expect(() => new SamlProvider({ type: 'saml' })).not.toThrow();
        } finally {
            process.chdir(cwd);
            fs.rmSync(dir, { recursive: true, force: true });
        }
        expect(() => new SamlProvider({ type: 'saml', idpMetadataUrl: 'http://idp.example.com/metadata' })).toThrow('the metadata URL must use https');
    });

    it('metadata from a URL — an IdP that cannot be reached is 503, not a crash', async () => {
        const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end(idpMetadata()); });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/metadata`;
            const { url: login } = await provider({ idpMetadata: undefined, idpMetadataUrl: url }).beginLogin({ redirectUri: ACS });
            expect(login.startsWith(IDP_SSO_URL)).toBe(true);
            await expect(provider({ idpMetadata: undefined, idpMetadataUrl: 'http://127.0.0.1:9/metadata', timeout: 500 }).beginLogin({ redirectUri: ACS }))
                .rejects.toMatchObject({ status_code: 503, message: 'auth_provider_unavailable' });
        } finally {
            server.close();
        }
    });
});
