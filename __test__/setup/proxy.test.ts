import dns from 'dns';
import { proxyView, CLOUDFLARE_PROPOSAL } from '../../src/setup/proxy';

const VISITOR = '203.0.113.9';
const CLOUDFLARE = '172.68.1.10';

// visitor → Cloudflare → nginx on this machine → wizard
const throughCloudflare = { peer: '127.0.0.1', headers: { 'x-forwarded-for': `${VISITOR}, ${CLOUDFLARE}`, 'cf-ray': '8c1e2a3b4c5d6e7f-FRA' } };

describe('proxyView — this page through Cloudflare and a proxy on this machine', () => {
    afterEach(() => jest.restoreAllMocks());

    it('shows the way in, hop by hop', async () => {
        const view = await proxyView(throughCloudflare, { NODE_ENV: 'production', TRUST_PROXY: CLOUDFLARE_PROPOSAL });
        expect(view.chain).toEqual([
            { address: '127.0.0.1', kind: 'this machine' },
            { address: CLOUDFLARE, kind: 'Cloudflare' },
            { address: VISITOR, kind: 'internet' },
        ]);
        expect(view).toMatchObject({ cloudflare: { via: 'request' }, seenAs: VISITOR, proposal: null, message: null });
    });

    it('a hop count: every visitor is a Cloudflare server — private,cloudflare proposed', async () => {
        const view = await proxyView(throughCloudflare, { NODE_ENV: 'production', TRUST_PROXY: '1' });
        expect(view).toMatchObject({ seenAs: CLOUDFLARE, proposal: CLOUDFLARE_PROPOSAL, seenAsWithProposal: VISITOR });
        expect(view.message).toBe(`This page came through Cloudflare. The API sees visitors as Cloudflare's servers (you: ${CLOUDFLARE}) — one rate limit for everyone behind the same one. private,cloudflare trusts Cloudflare and the proxies on this machine or in your network (you: ${VISITOR}).`);
    });

    it('unset in production trusts every proxy — the right IP, but forgeable: proposed too', async () => {
        const view = await proxyView(throughCloudflare, { NODE_ENV: 'production' });
        expect(view.seenAs).toBe(VISITOR);
        expect(view.proposal).toBe(CLOUDFLARE_PROPOSAL);
        expect(view.message).toMatch(/^This page came through Cloudflare\. Trusting every proxy lets a client that bypasses Cloudflare set its own IP\./);
        // Outside production trusting every proxy is fine: nothing to propose
        expect(await proxyView(throughCloudflare, {})).toMatchObject({ seenAs: VISITOR, proposal: null, message: null });
        // ...but a hop count is wrong there too
        expect((await proxyView(throughCloudflare, { TRUST_PROXY: '1' })).proposal).toBe(CLOUDFLARE_PROPOSAL);
    });

    it('Cloudflare Tunnel: cloudflared on this machine — one hop is right, nothing to propose', async () => {
        const view = await proxyView({ peer: '127.0.0.1', headers: { 'x-forwarded-for': VISITOR, 'cf-ray': 'x' } }, { TRUST_PROXY: '1' });
        expect(view).toMatchObject({ cloudflare: { via: 'request' }, seenAs: VISITOR, proposal: null });
    });

    it('a proxy here that replaces X-Forwarded-For loses the visitor — said, whatever the value', async () => {
        const view = await proxyView({ peer: '127.0.0.1', headers: { 'x-forwarded-for': CLOUDFLARE, 'cf-ray': 'x' } }, { TRUST_PROXY: CLOUDFLARE_PROPOSAL });
        expect(view.replacedForwardedFor).toBe(true);
    });

    it('no Cloudflare: nothing to propose', async () => {
        const view = await proxyView({ peer: '127.0.0.1', headers: {} }, { NODE_ENV: 'production', TRUST_PROXY: '1' });
        expect(view).toMatchObject({ chain: [{ address: '127.0.0.1', kind: 'this machine' }], cloudflare: null, proposal: null });
    });

    it('PUBLIC_URL served by Cloudflare (DNS) — proposed when the setup page came in another way', async () => {
        jest.spyOn(dns.promises.Resolver.prototype, 'resolve4').mockResolvedValue(['104.16.132.229', '104.16.133.229']);
        jest.spyOn(dns.promises.Resolver.prototype, 'resolve6').mockResolvedValue(['2606:4700::6810:84e5']);
        const view = await proxyView({ peer: '127.0.0.1', headers: {} }, { TRUST_PROXY: '1', PUBLIC_URL: 'https://api.cf-example.test' });
        expect(view).toMatchObject({ cloudflare: { via: 'dns', host: 'api.cf-example.test' }, proposal: CLOUDFLARE_PROPOSAL });
        expect(view.message).toMatch(/^api\.cf-example\.test resolves to Cloudflare\. The API sees visitors as Cloudflare's servers — /);
        // Already trusted
        expect((await proxyView({ peer: '127.0.0.1', headers: {} }, { TRUST_PROXY: CLOUDFLARE_PROPOSAL, PUBLIC_URL: 'https://api.cf-example.test' })).proposal).toBeNull();
    });

    it('a host elsewhere is not Cloudflare', async () => {
        jest.spyOn(dns.promises.Resolver.prototype, 'resolve4').mockResolvedValue(['203.0.113.80']);
        jest.spyOn(dns.promises.Resolver.prototype, 'resolve6').mockRejectedValue(Object.assign(new Error('no AAAA'), { code: 'ENODATA' }));
        expect((await proxyView({ peer: '127.0.0.1', headers: {} }, { TRUST_PROXY: '1', PUBLIC_URL: 'https://api.elsewhere.test' })).cloudflare).toBeNull();
    });
});
