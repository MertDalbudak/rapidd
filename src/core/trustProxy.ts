import proxyAddr from '@fastify/proxy-addr';

/**
 * TRUST_PROXY: which proxies may set X-Forwarded-For / -Host / -Proto — they make request.ip,
 * hostname and protocol (rate limits, logs, sessions). Unset: every proxy — production warns,
 * since a client that reaches the server directly can then set its own IP.
 *
 *   true | false            every proxy | none
 *   10.0.0.0/8,127.0.0.1    proxies at these addresses: IPs, CIDRs and the names below
 *   1                       one proxy hop, from a private address (this machine, private networks)
 *   2,10.0.0.0/8            two proxy hops, from these addresses
 *   private,cloudflare      Cloudflare in front of a proxy on this machine or in the network
 *
 * Names: private (loopback + linklocal + uniquelocal), cloudflare (Cloudflare's published
 * ranges), loopback, linklocal, uniquelocal.
 *
 * Fastify (5.12+) trusts no proxy for a bare hop count: a count cannot tell a proxy from a client
 * that reaches the server directly and writes X-Forwarded-For itself. So a hop is trusted only
 * from a proxy address — the trust function Fastify asks for.
 */

/**
 * Cloudflare's addresses — https://www.cloudflare.com/ips (API: /client/v4/ips), as of
 * 2026-10-09. Cloudflare connects to the origin from these.
 */
export const CLOUDFLARE_RANGES = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
    '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
    '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
    '2a06:98c0::/29', '2c0f:f248::/32',
];

/** proxy-addr's own names */
const PROXY_ADDR_NAMES = ['loopback', 'linklocal', 'uniquelocal'];

/** Rapidd's names for address ranges */
const NAMED_RANGES: Record<string, string[]> = {
    private: PROXY_ADDR_NAMES,
    cloudflare: CLOUDFLARE_RANGES,
};

/** Where proxies run when no address is given */
export const PRIVATE_PROXY_RANGES = ['private'];

export type TrustProxy = boolean | string[] | { hops: number; addresses: string[] };

const COUNT = /^\d+$/;

// `production` no longer changes the default (unset trusts every proxy everywhere); kept for callers
export function parseTrustProxy(value: string | undefined, _production?: boolean): TrustProxy {
    const v = value?.trim();
    if (!v) return true;
    if (v === 'true') return true;
    if (v === 'false') return false;
    const items = v.split(',').map((s) => s.trim()).filter(Boolean);
    const counts = items.filter((s) => COUNT.test(s));
    const addresses = items.filter((s) => !COUNT.test(s));
    if (counts.length > 1) throw new Error(`TRUST_PROXY: one hop count, not ${counts.length} (${counts.join(', ')})`);
    if (counts.length === 0) return addresses;
    return { hops: parseInt(counts[0], 10), addresses: addresses.length ? addresses : PRIVATE_PROXY_RANGES };
}

/** The names resolved to what proxy-addr reads */
function expand(addresses: string[]): string[] {
    return addresses.flatMap((a) => {
        const name = a.toLowerCase();
        return NAMED_RANGES[name] ?? (PROXY_ADDR_NAMES.includes(name) ? [name] : [a]);
    });
}

function matcher(addresses: string[]): (address: string, hop: number) => boolean {
    try {
        return proxyAddr.compile(expand(addresses));
    } catch (err) {
        throw new Error(`TRUST_PROXY: ${(err as Error).message} — use IPs, CIDRs, private, cloudflare, loopback, linklocal or uniquelocal`);
    }
}

/** Fastify's trustProxy option: a hop count becomes a trust function that checks each hop's address */
export function trustProxyOption(trust: TrustProxy): boolean | string[] | ((address: string, hop: number) => boolean) {
    if (typeof trust === 'boolean') return trust;
    if (Array.isArray(trust)) {
        // Fastify compiles the list itself — compiled here for a clear message when it can't
        matcher(trust);
        return expand(trust);
    }
    const isProxy = matcher(trust.addresses);
    return (address, hop) => hop < trust.hops && isProxy(address, hop);
}

/** Why a TRUST_PROXY value cannot be used — null when it can */
export function trustProxyError(value: string | undefined): string | null {
    try {
        trustProxyOption(parseTrustProxy(value));
        return null;
    } catch (err) {
        return (err as Error).message.replace(/^TRUST_PROXY: /, '');
    }
}

/** The client IP Fastify derives for a peer and X-Forwarded-For under this trust */
export function clientIp(trust: TrustProxy, peer: string, forwardedFor?: string): string {
    const option = trustProxyOption(trust);
    const fn = typeof option === 'function' ? option : option === true ? () => true : option === false ? () => false : matcher(option);
    const req = { socket: { remoteAddress: peer }, headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} };
    return proxyAddr(req as any, fn);
}

const cloudflare = proxyAddr.compile(CLOUDFLARE_RANGES);
/** One of Cloudflare's addresses */
export const isCloudflare = (address: string): boolean => {
    try {
        return cloudflare(address, 0);
    } catch {
        return false;
    }
};
