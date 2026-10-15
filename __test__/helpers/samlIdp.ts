/**
 * A SAML identity provider for tests: its metadata, the authentication requests it receives
 * (read from the redirect URL), and responses it signs — or forges — with the keys in ./saml.
 * Those are test fixtures only (self-signed, valid until 2126).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SignedXml } = require('xml-crypto');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const xmlenc = require('xml-encryption');

const read = (file: string) => fs.readFileSync(path.join(__dirname, 'saml', file), 'utf8');
export interface KeyPair { key: string; cert: string }
export const keys: Record<'idp' | 'other' | 'sp', KeyPair> = {
    idp: { key: read('idp.key'), cert: read('idp.crt') },
    other: { key: read('other.key'), cert: read('other.crt') },
    sp: { key: read('sp.key'), cert: read('sp.crt') },
};

export const IDP_ENTITY_ID = 'https://idp.example.com/saml';
export const IDP_SSO_URL = 'https://idp.example.com/saml/sso';
const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';

const certBody = (pem: string) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

export function idpMetadata(options: { entityId?: string; certs?: string[]; redirect?: boolean } = {}): string {
    const certs = (options.certs ?? [keys.idp.cert]).map(certBody);
    return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${options.entityId ?? IDP_ENTITY_ID}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
${certs.map((c) => `    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${c}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`).join('\n')}
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody(keys.other.cert)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>${PERSISTENT}</md:NameIDFormat>
${options.redirect === false ? '' : `    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${IDP_SSO_URL}"/>\n`}    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${IDP_SSO_URL}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>
`;
}

/** The authentication request carried by an IdP redirect URL */
export function readRequest(url: string): { id: string; relayState: string; acs: string; issuer: string; signed: boolean; xml: string } {
    const params = new URL(url).searchParams;
    const xml = zlib.inflateRawSync(Buffer.from(params.get('SAMLRequest')!, 'base64')).toString('utf8');
    return {
        id: /\bID="([^"]+)"/.exec(xml)![1],
        acs: /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1] ?? '',
        issuer: /<saml:Issuer[^>]*>([^<]+)</.exec(xml)?.[1] ?? '',
        relayState: params.get('RelayState') ?? '',
        signed: params.has('Signature'),
        xml,
    };
}

export interface ResponseOptions {
    inResponseTo: string | null;
    acs?: string;
    audience?: string;
    issuer?: string;
    nameId?: string;
    nameIdFormat?: string;
    /** [name, value] pairs — a name may repeat, as some IdPs send it */
    attributes?: [string, string][];
    sign?: 'assertion' | 'response' | 'both' | 'none';
    signer?: KeyPair;
    notOnOrAfter?: Date;
    /** A status other than Success: an error response without an assertion */
    status?: string;
    /** Encrypt the (signed) assertion for this certificate */
    encryptFor?: string;
    /** Changed after signing */
    tamper?: (xml: string) => string;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function signed(xml: string, element: 'Assertion' | 'Response', signer: KeyPair): string {
    const target = element === 'Assertion' ? "//*[local-name(.)='Assertion']" : "/*[local-name(.)='Response']";
    const sig = new SignedXml({
        privateKey: signer.key,
        publicCert: signer.cert,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
        xpath: target,
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
        transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    });
    // The schema wants the signature right after the element's Issuer
    sig.computeSignature(xml, { prefix: 'ds', location: { reference: `${target}/*[local-name(.)='Issuer']`, action: 'after' } });
    return sig.getSignedXml();
}

function encrypt(xml: string, cert: string): Promise<string> {
    return new Promise((resolve, reject) => xmlenc.encrypt(xml, {
        rsa_pub: crypto.createPublicKey(cert).export({ type: 'spki', format: 'pem' }),
        pem: cert,
        encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
        keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
        disallowEncryptionWithInsecureAlgorithm: true,
    }, (err: Error | null, result: string) => (err ? reject(err) : resolve(result))));
}

/** The SAMLResponse form value the IdP would post */
export async function samlResponse(o: ResponseOptions): Promise<string> {
    const now = new Date();
    const until = o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
    const issuer = o.issuer ?? IDP_ENTITY_ID;
    const signer = o.signer ?? keys.idp;
    const sign = o.sign ?? 'assertion';
    const acs = o.acs ?? 'https://api.example.com/auth/saml/callback';
    const inResponseTo = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : '';
    const attributes = (o.attributes ?? []).map(([name, value]) =>
        `<saml:Attribute Name="${name}"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`).join('');

    let assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${crypto.randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${iso(now)}">`
        + `<saml:Issuer>${issuer}</saml:Issuer>`
        + `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? PERSISTENT}">${o.nameId ?? 'u-4711'}</saml:NameID>`
        + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${inResponseTo} NotOnOrAfter="${iso(until)}" Recipient="${acs}"/></saml:SubjectConfirmation></saml:Subject>`
        + `<saml:Conditions NotBefore="${iso(new Date(now.getTime() - 60_000))}" NotOnOrAfter="${iso(until)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? 'https://api.example.com/auth/saml/metadata'}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
        + `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
        + (attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : '')
        + '</saml:Assertion>';
    if (sign === 'assertion' || sign === 'both') assertion = signed(assertion, 'Assertion', signer);
    if (o.encryptFor) assertion = `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${await encrypt(assertion, o.encryptFor)}</saml:EncryptedAssertion>`;

    const status = o.status
        ? `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder"><samlp:StatusCode Value="${o.status}"/></samlp:StatusCode></samlp:Status>`
        : '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>';
    let response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${iso(now)}" Destination="${acs}"${inResponseTo}>`
        + `<saml:Issuer>${issuer}</saml:Issuer>${status}${o.status ? '' : assertion}</samlp:Response>`;
    if (sign === 'response' || sign === 'both') response = signed(response, 'Response', signer);
    if (o.tamper) response = o.tamper(response);
    return Buffer.from(response).toString('base64');
}
