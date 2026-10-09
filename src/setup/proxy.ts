import dns from 'dns';
import proxyAddr from '@fastify/proxy-addr';
import { clientIp, isCloudflare, parseTrustProxy, trustProxyError } from '../core/trustProxy';
import type { TrustProxy } from '../core/trustProxy';
import type { Values } from './catalog';

/**
 * TRUST_PROXY in the wizard: how this page's own request came in — through Cloudflare, a proxy
 * on this machine — and the client IP the API makes of it with a value. Cloudflare's servers
 * have public addresses, so no hop count trusts them: behind Cloudflare the API sees every
 * visitor as a Cloudflare server until TRUST_PROXY names it.
 */

export const CLOUDFLARE_PROPOSAL = 'private,cloudflare';

export type HopKind = 'this machine' | 'private network' | 'Cloudflare' | 'internet';

export interface ProxyView {
    /** From this server's peer outward: the proxies, then the client */
    chain: { address: string; kind: HopKind }[];
    /** Cloudflare in front: its headers or servers on this request, or PUBLIC_URL resolves to it */
    cloudflare: { via: 'request' | 'dns'; host?: string } | null;
    /** The client IP the API sees for this request with TRUST_PROXY as set — null for an invalid value */
    seenAs: string | null;
    /** TRUST_PROXY to set: Cloudflare is in front and the value does not trust it, or trusts everyone */
    proposal: string | null;
    /** The client IP for this request with the proposal */
    seenAsWithProposal: string | null;
    /** Even with Cloudflare trusted the client is a Cloudflare server: a proxy here replaces X-Forwarded-For */
    replacedForwardedFor: boolean;
    /** What is wrong and what the proposal changes — for the field and the review */
    message: string | null;
}

export interface IncomingRequest {
    /** The address this server's connection comes from */
    peer: string;
    headers: Record<string, string | string[] | undefined>;
}

const loopback = proxyAddr.compile('loopback');
const privateNetwork = proxyAddr.compile(['linklocal', 'uniquelocal']);

function kindOf(address: string): HopKind {
    if (loopback(address, 0)) return 'this machine';
    if (privateNetwork(address, 0)) return 'private network';
    if (isCloudflare(address)) return 'Cloudflare';
    return 'internet';
}

const header = (value: string | string[] | undefined): string => (Array.isArray(value) ? value.join(', ') : value ?? '');

// PUBLIC_URL host → served through Cloudflare (DNS answers are cached for ten minutes)
const DNS_TTL = 10 * 60_000;
const dnsCache = new Map<string, { at: number; cloudflare: boolean }>();

async function resolvesToCloudflare(host: string): Promise<boolean> {
    const hit = dnsCache.get(host);
    if (hit && Date.now() - hit.at < DNS_TTL) return hit.cloudflare;
    const resolver = new dns.promises.Resolver({ timeout: 1500, tries: 1 });
    const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    const addresses = answers.flatMap((a) => (a.status === 'fulfilled' ? a.value : []));
    const cloudflare = addresses.length > 0 && addresses.every(isCloudflare);
    dnsCache.set(host, { at: Date.now(), cloudflare });
    return cloudflare;
}

function publicHost(url: string | undefined): string | null {
    try {
        const host = url ? new URL(url).hostname : '';
        return host && host !== 'localhost' && !/^[\d.]+$|:/.test(host) ? host : null;
    } catch {
        return null;
    }
}

export async function proxyView(request: IncomingRequest, values: Values): Promise<ProxyView> {
    const forwardedFor = header(request.headers['x-forwarded-for']) || undefined;
    const addresses = [request.peer, ...(forwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean).reverse()];
    const chain = addresses.map((address) => ({ address, kind: kindOf(address) }));

    const viaRequest = !!(request.headers['cf-ray'] || request.headers['cf-connecting-ip']) || chain.some((hop) => hop.kind === 'Cloudflare');
    let cloudflare: ProxyView['cloudflare'] = viaRequest ? { via: 'request' } : null;
    const host = publicHost(values.PUBLIC_URL);
    if (!cloudflare && host && await resolvesToCloudflare(host)) cloudflare = { via: 'dns', host };

    const production = values.NODE_ENV === 'production';
    const trust: TrustProxy | null = trustProxyError(values.TRUST_PROXY) === null ? parseTrustProxy(values.TRUST_PROXY) : null;
    const seenAs = trust === null ? null : clientIp(trust, request.peer, forwardedFor);
    const proposed = parseTrustProxy(CLOUDFLARE_PROPOSAL);
    const empty: ProxyView = { chain, cloudflare, seenAs, proposal: null, seenAsWithProposal: null, replacedForwardedFor: false, message: null };
    if (!cloudflare || trust === null) return empty;

    // This request through Cloudflare — or, known from DNS only, Cloudflare in front of a proxy here or not
    const samples: [string, string | undefined][] = viaRequest
        ? [[request.peer, forwardedFor]]
        : [['127.0.0.1', '203.0.113.9, 172.64.0.1'], ['172.64.0.1', '203.0.113.9']];
    const wrong = samples.some(([peer, xff]) => clientIp(trust, peer, xff) !== clientIp(proposed, peer, xff));
    const seenAsWithProposal = clientIp(proposed, request.peer, forwardedFor);
    const replacedForwardedFor = viaRequest && isCloudflare(seenAsWithProposal);
    // Trusting every proxy is fine outside production; in production it lets clients set their IP
    if (trust === true ? !production : !wrong) return { ...empty, replacedForwardedFor };

    const where = cloudflare.via === 'request' ? 'This page came through Cloudflare' : `${cloudflare.host} resolves to Cloudflare`;
    const problem = trust === true
        ? 'Trusting every proxy lets a client that bypasses Cloudflare set its own IP'
        : `The API sees visitors as Cloudflare's servers${viaRequest ? ` (you: ${seenAs})` : ''} — one rate limit for everyone behind the same one`;
    const fix = `${CLOUDFLARE_PROPOSAL} trusts Cloudflare and the proxies on this machine or in your network${viaRequest && !replacedForwardedFor ? ` (you: ${seenAsWithProposal})` : ''}`;
    return {
        ...empty,
        proposal: CLOUDFLARE_PROPOSAL,
        seenAsWithProposal,
        replacedForwardedFor,
        message: `${where}. ${problem}. ${fix}.`,
    };
}
