import { parseTrustProxy, trustProxyError, clientIp, isCloudflare } from '../../src/core/trustProxy';

const ip = (value: string, peer: string, forwardedFor?: string) => clientIp(parseTrustProxy(value, true), peer, forwardedFor);

const VISITOR = '203.0.113.9';
const CLOUDFLARE = '172.68.1.10'; // in 172.64.0.0/13
const NGINX = '127.0.0.1';

describe('TRUST_PROXY behind Cloudflare and a reverse proxy on the machine', () => {
    // visitor → Cloudflare → nginx (127.0.0.1) → API: each proxy appends the address it saw
    const xff = `${VISITOR}, ${CLOUDFLARE}`;

    it('a hop count stops at Cloudflare: a public address is no proxy — every visitor is a Cloudflare server', () => {
        expect(ip('1', NGINX, xff)).toBe(CLOUDFLARE);
        expect(ip('2', NGINX, xff)).toBe(CLOUDFLARE);
    });

    it('private,cloudflare finds the visitor', () => {
        expect(ip('private,cloudflare', NGINX, xff)).toBe(VISITOR);
        expect(ip('loopback,cloudflare', NGINX, xff)).toBe(VISITOR);
        expect(ip('2,loopback,cloudflare', NGINX, xff)).toBe(VISITOR);
    });

    it('a forged X-Forwarded-For: private,cloudflare ignores it, trusting every proxy does not', () => {
        const forged = `6.6.6.6, ${xff}`;
        expect(ip('private,cloudflare', NGINX, forged)).toBe(VISITOR);
        expect(ip('true', NGINX, forged)).toBe('6.6.6.6');
    });

    it('a client that bypasses Cloudflare (straight to nginx) cannot set its IP', () => {
        expect(ip('private,cloudflare', NGINX, '6.6.6.6, 198.51.100.20')).toBe('198.51.100.20');
    });

    it('Cloudflare straight to the API, Cloudflare Tunnel (cloudflared on the machine), tunnel and nginx', () => {
        expect(ip('cloudflare', CLOUDFLARE, VISITOR)).toBe(VISITOR);
        expect(ip('1', CLOUDFLARE, VISITOR)).toBe(CLOUDFLARE);
        expect(ip('1', NGINX, VISITOR)).toBe(VISITOR);
        expect(ip('1', NGINX, `${VISITOR}, 127.0.0.1`)).toBe('127.0.0.1');
        expect(ip('private', NGINX, `${VISITOR}, 127.0.0.1`)).toBe(VISITOR);
    });

    it('nginx replacing X-Forwarded-For with Cloudflare\'s address loses the visitor', () => {
        expect(ip('private,cloudflare', NGINX, CLOUDFLARE)).toBe(CLOUDFLARE);
    });
});

describe('TRUST_PROXY names', () => {
    it('private is this machine and private networks; names ignore case', () => {
        expect(parseTrustProxy('2', true)).toEqual({ hops: 2, addresses: ['private'] });
        expect(ip('private', '10.1.2.3', VISITOR)).toBe(VISITOR);
        expect(ip('Loopback,Cloudflare', NGINX, xffOf(VISITOR, CLOUDFLARE))).toBe(VISITOR);
        expect(trustProxyError('private,cloudflare,2606:4700::/32')).toBeNull();
        expect(trustProxyError('1,cloudfare')).toBe('invalid IP address: cloudfare — use IPs, CIDRs, private, cloudflare, loopback, linklocal or uniquelocal');
    });

    it('Cloudflare addresses, IPv4, IPv6 and IPv4-mapped', () => {
        expect(['172.68.1.10', '104.16.0.1', '2606:4700::1', '::ffff:172.68.1.10'].map(isCloudflare)).toEqual([true, true, true, true]);
        expect(['203.0.113.9', '10.0.0.1', '::1', 'nonsense'].map(isCloudflare)).toEqual([false, false, false, false]);
    });
});

function xffOf(...addresses: string[]): string {
    return addresses.join(', ');
}
