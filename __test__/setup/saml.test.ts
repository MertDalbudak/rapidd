/**
 * SAML in the setup wizard: the identity provider's metadata from an upload (staged until
 * saved), the file or the URL; the check; this API's values and metadata for the IdP; and the
 * settings' validation.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { checkSaml, samlIdpSummary, samlServiceMetadataXml, samlServiceValues, validateIdpMetadata } from '../../src/setup/saml';
import { validateConfigFile } from '../../src/setup/files';
import { validate, buildSections } from '../../src/setup/settings';
import { idpMetadata, keys, IDP_ENTITY_ID, IDP_SSO_URL } from '../helpers/samlIdp';

let root: string;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidd-wizard-saml-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const BASE = { AUTH_PROVIDERS: 'saml', PUBLIC_URL: 'https://api.example.com' };

describe('the identity provider', () => {
    it('an upload (not saved yet) wins over the file — the URL over both', async () => {
        expect(await samlIdpSummary(root, BASE)).toBeNull();
        expect(await samlIdpSummary(root, BASE, idpMetadata())).toMatchObject({
            source: 'upload', entityId: IDP_ENTITY_ID, ssoUrl: IDP_SSO_URL,
            certificates: [{ subject: 'CN=Rapidd Test IdP', expired: false }],
        });
        fs.mkdirSync(path.join(root, 'config'));
        fs.writeFileSync(path.join(root, 'config', 'saml-idp-metadata.xml'), idpMetadata({ entityId: 'https://file.example' }));
        expect(await samlIdpSummary(root, BASE)).toMatchObject({ source: 'file', entityId: 'https://file.example' });
        // Another file configured: an upload (which goes to the default file) does not apply
        expect(await samlIdpSummary(root, { ...BASE, SAML_IDP_METADATA_FILE: 'config/saml-idp-metadata.xml' }, idpMetadata())).toMatchObject({ source: 'upload' });
        expect(await samlIdpSummary(root, { ...BASE, SAML_IDP_METADATA_FILE: 'elsewhere.xml' }, idpMetadata())).toBeNull();

        const server = http.createServer((_req, res) => res.end(idpMetadata({ entityId: 'https://url.example' })));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/md`;
            expect(await samlIdpSummary(root, { ...BASE, SAML_IDP_METADATA_URL: url }, idpMetadata())).toMatchObject({ source: 'url', entityId: 'https://url.example' });
        } finally {
            server.close();
        }
        await expect(samlIdpSummary(root, { ...BASE, SAML_IDP_METADATA_URL: 'http://idp.example.com/md' })).rejects.toThrow('must use https');
    });

    it('an upload is checked before it is saved: XML, an identity provider, a redirect sign-on URL', () => {
        expect(validateConfigFile('samlIdp', idpMetadata())).toEqual([]);
        expect(validateConfigFile('samlIdp', '<html><body>Sign in</body></html>')).toEqual(['No SAML identity provider in it (no EntityDescriptor with an IDPSSODescriptor)']);
        expect(validateConfigFile('samlIdp', '<md:EntityDescriptor')).toEqual([expect.stringMatching(/^Not valid XML/)]);
        expect(validateIdpMetadata(idpMetadata({ redirect: false }))).toEqual(['The identity provider offers no single sign-on endpoint for the HTTP-Redirect binding']);
        expect(validateIdpMetadata('<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="x"><md:SPSSODescriptor/></md:EntityDescriptor>'))
            .toEqual(['This is a service provider’s metadata — the identity provider’s is needed']);
    });
});

describe('the check', () => {
    it('metadata, sign-on endpoint, certificates — and the values to register', async () => {
        const result = await checkSaml(root, BASE, idpMetadata());
        expect(result).toMatchObject({
            ok: true, message: 'Identity provider ready',
            details: {
                idp_entity_id: IDP_ENTITY_ID,
                register_entity_id: 'https://api.example.com/auth/saml/metadata',
                register_acs_url: 'https://api.example.com/auth/saml/callback',
                register_metadata_url: 'https://api.example.com/auth/saml/metadata',
            },
        });
        expect(result.steps!.map((s) => s.target)).toEqual(['uploaded metadata', 'single sign-on', 'certificate CN=Rapidd Test IdP']);
    });

    it('fails without metadata, without a sign-on endpoint, and without PUBLIC_URL', async () => {
        expect(await checkSaml(root, BASE, undefined)).toMatchObject({ ok: false, message: 'No metadata — upload the identity provider’s metadata, or set its URL' });
        expect((await checkSaml(root, BASE, idpMetadata({ redirect: false }))).ok).toBe(false);
        const noUrl = await checkSaml(root, { AUTH_PROVIDERS: 'saml' }, idpMetadata());
        expect(noUrl.ok).toBe(false);
        expect(noUrl.steps).toContainEqual({ target: 'this API', ok: false, message: 'set PUBLIC_URL — the identity provider posts sign-ins to it' });
    });
});

describe('this API for the identity provider', () => {
    it('entity id and URLs follow PUBLIC_URL — or what is set', () => {
        expect(samlServiceValues({})).toBeNull();
        expect(samlServiceValues({ PUBLIC_URL: 'https://api.example.com/' })).toEqual({
            entityId: 'https://api.example.com/auth/saml/metadata', acsUrl: 'https://api.example.com/auth/saml/callback', metadataUrl: 'https://api.example.com/auth/saml/metadata',
        });
        expect(samlServiceValues({ PUBLIC_URL: 'https://api.example.com', SAML_SP_ENTITY_ID: 'urn:rapidd', SAML_CALLBACK_URL: 'https://sso.example.com/acs' }))
            .toMatchObject({ entityId: 'urn:rapidd', acsUrl: 'https://sso.example.com/acs' });
    });

    it('its metadata, with the certificate when a key is set', () => {
        expect(() => samlServiceMetadataXml(root, {})).toThrow('Set PUBLIC_URL first');
        expect(samlServiceMetadataXml(root, BASE)).toContain('Location="https://api.example.com/auth/saml/callback"');
        fs.writeFileSync(path.join(root, 'sp.key'), keys.sp.key);
        fs.writeFileSync(path.join(root, 'sp.crt'), keys.sp.cert);
        const signed = samlServiceMetadataXml(root, { ...BASE, SAML_SP_PRIVATE_KEY_FILE: 'sp.key', SAML_SP_CERT_FILE: 'sp.crt' });
        expect(signed).toContain('AuthnRequestsSigned="true"');
        expect(signed).toContain('<KeyDescriptor use="encryption">');
    });
});

describe('settings', () => {
    const sections = buildSections();
    const project = (saml: { metadata: boolean; library?: boolean }) => ({ saml: { metadataFile: 'config/saml-idp-metadata.xml', library: true, ...saml } });

    it('without a URL the metadata file is needed — an unsaved upload counts', () => {
        expect(validate(BASE, sections, project({ metadata: false })).errors.SAML_IDP_METADATA_FILE).toBe('Upload the identity provider’s metadata below — or set its URL');
        expect(validate(BASE, sections, project({ metadata: true })).errors.SAML_IDP_METADATA_FILE).toBeUndefined();
        expect(validate({ ...BASE, SAML_IDP_METADATA_URL: 'https://idp.example.com/md' }, sections, project({ metadata: false })).errors.SAML_IDP_METADATA_FILE).toBeUndefined();
        expect(validate(BASE, sections, project({ metadata: true, library: false })).errors.SAML_IDP_METADATA_FILE).toMatch(/npm install @node-saml\/node-saml/);
    });

    it('a metadata URL over https, PUBLIC_URL for the callback, readable key files', () => {
        const errors = validate({ AUTH_PROVIDERS: 'saml', SAML_IDP_METADATA_URL: 'http://idp.example.com/md', SAML_SP_PRIVATE_KEY_FILE: path.join(root, 'none.key') }, sections, project({ metadata: true })).errors;
        expect(errors.SAML_IDP_METADATA_URL).toBe('Use https — the identity provider’s signing certificates come from it');
        expect(errors.SAML_SP_ENTITY_ID).toMatch(/^Set PUBLIC_URL/);
        expect(errors.SAML_SP_PRIVATE_KEY_FILE).toMatch(/^File not found/);
        expect(errors.SAML_SP_CERT_FILE).toBeDefined(); // required with a key

        fs.writeFileSync(path.join(root, 'sp.key'), 'not a key');
        expect(validate({ ...BASE, SAML_SP_PRIVATE_KEY_FILE: path.join(root, 'sp.key') }, sections, project({ metadata: true })).errors.SAML_SP_PRIVATE_KEY_FILE).toBe('Not a PEM private key');
        expect(validate({ ...BASE, SAML_IDP_METADATA_URL: 'http://localhost:8080/md' }, sections, project({ metadata: true })).errors.SAML_IDP_METADATA_URL).toBeUndefined();
    });

    it('single sign-on settings: the landing page shows for SAML too', () => {
        expect(validate(BASE, sections, project({ metadata: true })).visible).toEqual(expect.arrayContaining(['AUTH_LOGIN_REDIRECT', 'AUTH_LINK', 'SAML_SP_ENTITY_ID']));
        expect(validate({ AUTH_PROVIDERS: 'ldap' }, sections, project({ metadata: true })).visible).not.toContain('AUTH_LOGIN_REDIRECT');
    });
});
