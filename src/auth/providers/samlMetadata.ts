import crypto from 'crypto';

/**
 * SAML 2.0 metadata of an identity provider: what a service provider needs from it — its
 * entity id, where to send the browser to sign in, and the certificates its signatures verify
 * against. Used by the SAML provider and by the setup wizard (upload, check).
 */

export interface IdpMetadata {
    entityId: string;
    /** Single sign-on endpoint for the HTTP-Redirect binding — null when the IdP offers none */
    ssoUrl: string | null;
    /** … and for HTTP-POST */
    ssoPostUrl: string | null;
    /** Signing certificates as published: base64 DER */
    certificates: string[];
    nameIdFormats: string[];
    /** The IdP asks for signed authentication requests */
    wantAuthnRequestsSigned: boolean;
}

export interface CertificateInfo {
    subject: string;
    validTo: string;
    expired: boolean;
    /** Within 30 days */
    expiresSoon: boolean;
    fingerprint: string;
}

export class SamlMetadataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SamlMetadataError';
    }
}

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const HTTP_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const HTTP_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';

/** The SAML library, loaded only when SAML is used — an optional dependency, so untyped here */
export function requireSaml(): any {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('@node-saml/node-saml');
    } catch {
        throw new Error('[Auth] SAML needs the "@node-saml/node-saml" package — run: npm install @node-saml/node-saml');
    }
}

/** The little of the DOM this reads (the project compiles without the DOM library) */
interface XmlList {
    length: number;
    item(index: number): XmlElement | null;
}
interface XmlElement {
    getAttribute(name: string): string | null;
    getElementsByTagNameNS(ns: string, name: string): XmlList;
    textContent: string | null;
}
interface XmlDocument {
    documentElement: XmlElement | null;
    getElementsByTagNameNS(ns: string, name: string): XmlList;
}

function domParser(errors: string[]): { parseFromString(xml: string, type: string): XmlDocument } {
    requireSaml();
    // Installed with @node-saml/node-saml, which parses with it too
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DOMParser } = require('@xmldom/xmldom');
    return new DOMParser({
        errorHandler: { warning: () => undefined, error: (m: string) => errors.push(m), fatalError: (m: string) => errors.push(m) },
    });
}

function elements(node: XmlDocument | XmlElement, ns: string, name: string): XmlElement[] {
    const list = node.getElementsByTagNameNS(ns, name);
    return Array.from({ length: list.length }, (_, i) => list.item(i)!);
}

/**
 * Parse an IdP's metadata — an EntityDescriptor, or the EntitiesDescriptor of a federation, from
 * which `entityId` picks one when it describes several identity providers
 */
export function parseIdpMetadata(xml: string, entityId?: string): IdpMetadata {
    const errors: string[] = [];
    let doc: XmlDocument | undefined;
    try {
        doc = domParser(errors).parseFromString(xml, 'text/xml');
    } catch (err) {
        errors.push((err as Error).message);
    }
    const root = doc?.documentElement;
    if (!doc || !root || errors.length) throw new SamlMetadataError(`Not valid XML${errors.length ? ` — ${errors[0].split('\n')[0]}` : ''}`);

    const descriptors = elements(doc, MD, 'EntityDescriptor').filter((d) => elements(d, MD, 'IDPSSODescriptor').length > 0);
    if (descriptors.length === 0) {
        throw new SamlMetadataError(elements(doc, MD, 'SPSSODescriptor').length
            ? 'This is a service provider’s metadata — the identity provider’s is needed'
            : 'No SAML identity provider in it (no EntityDescriptor with an IDPSSODescriptor)');
    }
    let descriptor = descriptors[0];
    if (entityId) {
        const chosen = descriptors.find((d) => d.getAttribute('entityID') === entityId);
        if (!chosen) throw new SamlMetadataError(`No identity provider ${entityId} in it`);
        descriptor = chosen;
    } else if (descriptors.length > 1) {
        const names = descriptors.slice(0, 3).map((d) => d.getAttribute('entityID')).join(', ');
        throw new SamlMetadataError(`It describes ${descriptors.length} identity providers (${names}${descriptors.length > 3 ? ', …' : ''}) — choose one with SAML_IDP_ENTITY_ID`);
    }

    const idp = elements(descriptor, MD, 'IDPSSODescriptor')[0];
    const services = elements(idp, MD, 'SingleSignOnService');
    const location = (binding: string) => services.find((s) => s.getAttribute('Binding') === binding)?.getAttribute('Location') || null;
    const certificates = [...new Set(elements(idp, MD, 'KeyDescriptor')
        // No `use`: the key signs and encrypts
        .filter((k) => !k.getAttribute('use') || k.getAttribute('use') === 'signing')
        .flatMap((k) => elements(k, DS, 'X509Certificate').map((c) => (c.textContent || '').replace(/\s+/g, '')))
        .filter(Boolean))];
    if (certificates.length === 0) throw new SamlMetadataError('The identity provider publishes no signing certificate');
    for (const certificate of certificates) {
        try {
            new crypto.X509Certificate(Buffer.from(certificate, 'base64'));
        } catch {
            throw new SamlMetadataError('A signing certificate in it cannot be read');
        }
    }
    return {
        entityId: descriptor.getAttribute('entityID') || '',
        ssoUrl: location(HTTP_REDIRECT),
        ssoPostUrl: location(HTTP_POST),
        certificates,
        nameIdFormats: elements(idp, MD, 'NameIDFormat').map((n) => (n.textContent || '').trim()).filter(Boolean),
        wantAuthnRequestsSigned: idp.getAttribute('WantAuthnRequestsSigned') === 'true',
    };
}

/** A certificate from metadata (base64 DER) as PEM */
export function pemCertificate(base64: string): string {
    return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
}

/** PEM (a certificate, possibly with \n escapes from an env file) → the base64 DER inside */
export function certificateBody(pem: string): string {
    return pem.replace(/\\n/g, '\n').replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

export function certificateInfo(base64: string, now: number = Date.now()): CertificateInfo {
    const cert = new crypto.X509Certificate(Buffer.from(base64, 'base64'));
    const validTo = new Date(cert.validTo).getTime();
    return {
        subject: cert.subject.split('\n').join(', '),
        validTo: new Date(validTo).toISOString(),
        expired: validTo < now,
        expiresSoon: validTo >= now && validTo - now < 30 * 24 * 3600 * 1000,
        fingerprint: cert.fingerprint256,
    };
}
