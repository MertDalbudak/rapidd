import fs from 'fs';
import path from 'path';
import { parseIdpMetadata, certificateInfo, SamlMetadataError } from '../auth/providers/samlMetadata';
import type { CertificateInfo } from '../auth/providers/samlMetadata';
import { DEFAULT_IDP_METADATA_FILE, samlEntityId, samlServiceMetadata } from '../auth/providers/SamlProvider';
import type { CheckResult } from './checks';
import type { Values } from './catalog';

/**
 * SAML in the setup wizard: the identity provider's metadata as the wizard shows it — uploaded
 * (staged until saved), from its URL or from the file — and what to register at the IdP for
 * this API: entity id, assertion consumer URL, its metadata.
 */

export interface SamlIdpSummary {
    source: 'url' | 'upload' | 'file';
    entityId: string;
    ssoUrl: string | null;
    certificates: CertificateInfo[];
    nameIdFormats: string[];
    wantAuthnRequestsSigned: boolean;
}

/** What the identity provider needs to know about this API */
export interface SamlServiceValues {
    entityId: string;
    acsUrl: string;
    metadataUrl: string;
}

/** The metadata file — where an upload is saved unless SAML_IDP_METADATA_FILE names another */
export function idpMetadataPath(values: Values): string {
    return values.SAML_IDP_METADATA_FILE || DEFAULT_IDP_METADATA_FILE;
}

/** An upload goes to the default file — offered while no other file is configured */
export function uploadsToDefault(values: Values): boolean {
    return idpMetadataPath(values) === DEFAULT_IDP_METADATA_FILE;
}

export function samlServiceValues(values: Values): SamlServiceValues | null {
    const base = values.PUBLIC_URL?.trim().replace(/\/$/, '');
    const acsUrl = values.SAML_CALLBACK_URL?.trim() || (base ? `${base}/auth/saml/callback` : '');
    if (!acsUrl) return null;
    return {
        entityId: samlEntityId({ spEntityId: values.SAML_SP_ENTITY_ID?.trim() || undefined }, acsUrl),
        acsUrl,
        metadataUrl: base ? `${base}/auth/saml/metadata` : acsUrl.replace(/\/callback$/, '/metadata'),
    };
}

function isLoopback(url: string): boolean {
    try {
        return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
    } catch {
        return false;
    }
}

/** The metadata the API would use: from the URL, else the staged upload, else the file */
async function idpXml(root: string, values: Values, staged: string | undefined, timeoutMs: number): Promise<{ xml: string; source: SamlIdpSummary['source'] } | null> {
    const url = values.SAML_IDP_METADATA_URL?.trim();
    if (url) {
        if (!/^https:\/\//i.test(url) && !isLoopback(url)) throw new SamlMetadataError('The metadata URL must use https — the signing certificates come from it');
        const response = await fetch(url, { headers: { Accept: 'application/samlmetadata+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new SamlMetadataError(`GET ${url} → ${response.status}`);
        return { xml: await response.text(), source: 'url' };
    }
    if (staged !== undefined && uploadsToDefault(values)) return { xml: staged, source: 'upload' };
    const file = path.resolve(root, idpMetadataPath(values));
    if (!fs.existsSync(file)) return null;
    return { xml: fs.readFileSync(file, 'utf8'), source: 'file' };
}

/** The identity provider as its metadata describes it — null without metadata */
export async function samlIdpSummary(root: string, values: Values, staged?: string, timeoutMs = 5000): Promise<SamlIdpSummary | null> {
    const found = await idpXml(root, values, staged, timeoutMs);
    if (!found) return null;
    const idp = parseIdpMetadata(found.xml, values.SAML_IDP_ENTITY_ID?.trim() || undefined);
    return {
        source: found.source,
        entityId: idp.entityId,
        ssoUrl: idp.ssoUrl,
        certificates: idp.certificates.map((c) => certificateInfo(c)),
        nameIdFormats: idp.nameIdFormats,
        wantAuthnRequestsSigned: idp.wantAuthnRequestsSigned,
    };
}

/** Problems with an uploaded metadata file — staged files are validated before saving */
export function validateIdpMetadata(xml: string): string[] {
    try {
        const idp = parseIdpMetadata(xml);
        return idp.ssoUrl ? [] : ['The identity provider offers no single sign-on endpoint for the HTTP-Redirect binding'];
    } catch (err) {
        // A federation file needs SAML_IDP_ENTITY_ID — that is chosen in the settings, not a broken file
        if (/choose one with SAML_IDP_ENTITY_ID/.test((err as Error).message)) return [];
        return [(err as Error).message.replace(/^\[Auth\]\s*/, '')];
    }
}

const readKey = (root: string, values: Values, key: string): string | undefined => {
    const file = values[key]?.trim();
    return file ? fs.readFileSync(path.resolve(root, file), 'utf8') : undefined;
};

/** This API's metadata with the settings as they are on screen — to download and upload at the IdP */
export function samlServiceMetadataXml(root: string, values: Values): string {
    const service = samlServiceValues(values);
    if (!service) throw new SamlMetadataError('Set PUBLIC_URL first — the identity provider posts sign-ins to <PUBLIC_URL>/auth/saml/callback');
    return samlServiceMetadata({
        spEntityId: values.SAML_SP_ENTITY_ID?.trim() || undefined,
        nameIdFormat: values.SAML_NAMEID_FORMAT?.trim() || undefined,
        privateKey: readKey(root, values, 'SAML_SP_PRIVATE_KEY_FILE'),
        cert: readKey(root, values, 'SAML_SP_CERT_FILE'),
    }, service.acsUrl);
}

/** The wizard's SAML check: the IdP's metadata, its sign-on endpoint and certificates, and this API's URLs */
export async function checkSaml(root: string, values: Values, staged: string | undefined, timeoutMs = 5000): Promise<CheckResult> {
    const steps: NonNullable<CheckResult['steps']> = [];
    let summary: SamlIdpSummary | null;
    try {
        summary = await samlIdpSummary(root, values, staged, timeoutMs);
    } catch (err) {
        // fetch() names the network failure in its cause (ENOTFOUND, ECONNREFUSED, …)
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        return { ok: false, message: err instanceof SamlMetadataError ? err.message : `Cannot load the metadata: ${cause?.code ?? cause?.message ?? (err as Error).message}` };
    }
    if (!summary) return { ok: false, message: 'No metadata — upload the identity provider’s metadata, or set its URL' };
    steps.push({ target: { url: 'metadata URL', upload: 'uploaded metadata', file: idpMetadataPath(values) }[summary.source], ok: true, message: summary.entityId });
    steps.push(summary.ssoUrl
        ? { target: 'single sign-on', ok: true, message: summary.ssoUrl }
        : { target: 'single sign-on', ok: false, message: 'no HTTP-Redirect endpoint' });
    for (const cert of summary.certificates) {
        steps.push({
            target: `certificate ${cert.subject}`,
            ok: !cert.expired,
            message: cert.expired ? `expired ${cert.validTo.slice(0, 10)}` : `valid until ${cert.validTo.slice(0, 10)}${cert.expiresSoon ? ' — soon: the IdP will roll it over' : ''}`,
        });
    }
    // The IdP may list several (rollover): one valid certificate is enough
    const certificatesOk = summary.certificates.some((c) => !c.expired);
    const service = samlServiceValues(values);
    if (!service) steps.push({ target: 'this API', ok: false, message: 'set PUBLIC_URL — the identity provider posts sign-ins to it' });
    // Its metadata may ask for signed requests in general, while this API's registration there
    // does not (Keycloak advertises it per realm) — advice, not a failure
    const unsigned = summary.wantAuthnRequestsSigned && !values.SAML_SP_PRIVATE_KEY_FILE;
    const ok = !!summary.ssoUrl && certificatesOk && !!service;
    return {
        ok,
        message: !ok ? 'Identity provider check failed'
            : unsigned ? 'Identity provider ready — it asks for signed requests: set a private key and certificate (advanced), or turn that off for this API at the identity provider'
                : 'Identity provider ready',
        steps,
        details: {
            idp_entity_id: summary.entityId,
            ...(service ? { register_entity_id: service.entityId, register_acs_url: service.acsUrl, register_metadata_url: service.metadataUrl } : {}),
        },
    };
}
