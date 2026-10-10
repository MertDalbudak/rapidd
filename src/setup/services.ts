import crypto from 'crypto';
import { substituteEnv } from '../core/config';
import { prepareServiceRequest, ApiClient } from '../utils/ApiClient';
import type { ServiceConfig } from '../utils/ApiClient';
import { isSecretKey } from './catalog';
import type { Values } from './catalog';

/**
 * Test calls for the services of config/app.json — with the wizard's unsaved configuration:
 * ${ENV} references are filled from the settings as they are on screen. One attempt, a
 * short timeout, and a preview of the answer instead of the whole body.
 */

export interface ServiceTestResult {
    ok: boolean;
    message: string;
    status?: number;
    durationMs?: number;
    method?: string;
    /** Without credentials: values of secret-looking query parameters are masked */
    url?: string;
    contentType?: string;
    preview?: string;
    /** ${NAME} references without a value */
    missing?: string[];
}

const PREVIEW_BYTES = 4096;
const TIMEOUT_MS = 10_000;

function displayUrl(url: string): string {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
        if (isSecretKey(key.toUpperCase())) parsed.searchParams.set(key, '••••');
    }
    return decodeURI(parsed.toString());
}

export async function testService(
    appConfigText: string,
    serviceName: string,
    endpointName: string,
    params: Record<string, string>,
    values: Values,
): Promise<ServiceTestResult> {
    let raw: ServiceConfig | undefined;
    try {
        raw = JSON.parse(appConfigText)?.services?.[serviceName];
    } catch (err) {
        return { ok: false, message: `config/app.json: ${(err as Error).message}` };
    }
    if (!raw) return { ok: false, message: `No service ${serviceName}` };

    const missing = new Set<string>();
    const service = substituteEnv(raw, missing, { ...process.env, ...values });
    // A key of its own: the test must neither use nor leave a token in the app's cache
    const cacheKey = `setup-test:${crypto.randomUUID()}`;
    const started = Date.now();
    try {
        const request = await prepareServiceRequest(cacheKey, service, endpointName, { params });
        const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const durationMs = Date.now() - started;
        const contentType = response.headers.get('content-type') || '';
        const body = Buffer.from(await response.arrayBuffer());
        const textual = /json|text|xml|html|javascript/.test(contentType) || contentType === '';
        let preview = textual ? body.subarray(0, PREVIEW_BYTES).toString('utf8') : `(${body.length} bytes of ${contentType})`;
        if (textual && /json/.test(contentType)) {
            try {
                preview = JSON.stringify(JSON.parse(body.toString('utf8')), null, 2).slice(0, PREVIEW_BYTES);
            } catch {
                // not valid JSON — shown as text
            }
        }
        if (textual && body.length > PREVIEW_BYTES) preview += `\n… (${body.length} bytes)`;
        return {
            ok: response.ok,
            message: `${response.status} ${response.statusText}`.trim(),
            status: response.status,
            durationMs,
            method: request.method,
            url: displayUrl(request.url),
            contentType,
            preview,
            ...(missing.size ? { missing: [...missing] } : {}),
        };
    } catch (err: any) {
        // fetch reports "fetch failed" — the reason is its cause (ECONNREFUSED, a certificate, a blocked port, ...)
        const cause = err?.cause;
        const reason = err?.name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} s`
            : cause?.code ? `${cause.code}: ${cause.message ?? err.message}` : cause?.message ? `${err.message}: ${cause.message}` : err?.message || String(err);
        return { ok: false, message: reason, durationMs: Date.now() - started, ...(missing.size ? { missing: [...missing] } : {}) };
    } finally {
        ApiClient.clearTokenCache(cacheKey);
    }
}
