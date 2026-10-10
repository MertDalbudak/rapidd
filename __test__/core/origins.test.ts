import { isOriginAllowed, safeRedirectTarget, appendQuery, parseAllowedOrigins } from '../../src/core/origins';

describe('isOriginAllowed', () => {
    const allowed = ['example.com', 'https://app.partner.io'];

    it('matches hosts and subdomains, ignoring scheme and port', () => {
        expect(isOriginAllowed('https://example.com', allowed)).toBe(true);
        expect(isOriginAllowed('http://admin.example.com:8080', allowed)).toBe(true);
        expect(isOriginAllowed('https://app.partner.io', allowed)).toBe(true);
    });

    it('rejects look-alikes', () => {
        expect(isOriginAllowed('https://evilexample.com', allowed)).toBe(false);
        expect(isOriginAllowed('https://example.com.evil.io', allowed)).toBe(false);
        expect(isOriginAllowed('not a url', allowed)).toBe(false);
    });

    it('honours * unless wildcards are disabled', () => {
        expect(isOriginAllowed('https://any.io', ['*'])).toBe(true);
        expect(isOriginAllowed('https://any.io', ['*'], { wildcard: false })).toBe(false);
    });

    it('parses ALLOWED_ORIGINS', () => {
        expect(parseAllowedOrigins(' a.com, ,https://b.io ')).toEqual(['a.com', 'https://b.io']);
    });
});

describe('safeRedirectTarget', () => {
    const saved = process.env.ALLOWED_ORIGINS;
    beforeEach(() => { process.env.ALLOWED_ORIGINS = 'app.example.com,*'; });
    afterAll(() => { process.env.ALLOWED_ORIGINS = saved; });

    it('accepts relative paths but not protocol-relative or backslash tricks', () => {
        expect(safeRedirectTarget('/dashboard?x=1', '/')).toBe('/dashboard?x=1');
        expect(safeRedirectTarget('//evil.com', '/')).toBe('/');
        expect(safeRedirectTarget('/\\evil.com', '/')).toBe('/');
    });

    it('accepts allowed origins and the request origin; * never counts', () => {
        expect(safeRedirectTarget('https://app.example.com/after', '/')).toBe('https://app.example.com/after');
        expect(safeRedirectTarget('https://api.local/x', '/', { requestOrigin: 'https://api.local' })).toBe('https://api.local/x');
        expect(safeRedirectTarget('https://elsewhere.io/x', '/')).toBe('/');
        expect(safeRedirectTarget('https://spa.io/x', '/', { extra: ['spa.io'] })).toBe('https://spa.io/x');
    });

    it('rejects non-http schemes and junk', () => {
        expect(safeRedirectTarget('javascript:alert(1)', '/')).toBe('/');
        expect(safeRedirectTarget('data:text/html,hi', '/')).toBe('/');
        expect(safeRedirectTarget(42, '/home')).toBe('/home');
        expect(safeRedirectTarget('', '/home')).toBe('/home');
    });
});

describe('appendQuery', () => {
    it('works for relative and absolute targets', () => {
        expect(appendQuery('/after?a=1#top', { t: 'x y' })).toBe('/after?a=1&t=x+y#top');
        expect(appendQuery('https://app.io/cb', { t: '1' })).toBe('https://app.io/cb?t=1');
    });
});
