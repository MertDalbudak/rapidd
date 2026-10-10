/**
 * Origin allow-listing shared by CORS and redirect validation.
 *
 * ALLOWED_ORIGINS entries are hostnames, optionally with a scheme
 * (`example.com`, `https://app.example.com`). An entry also covers its subdomains.
 */

export function parseAllowedOrigins(value = process.env.ALLOWED_ORIGINS): string[] {
    return (value || '').split(',').map((e) => e.trim()).filter(Boolean);
}

const ENTRY = /^(?:(https?):\/\/)?([^/:\s]+)(?::(\d+))?/i;

/**
 * Does `origin` (scheme://host[:port]) match an allow-list entry? `*` matches anything.
 * A bare host (`example.com`) matches any scheme/port, and its subdomains. An entry that
 * names a scheme or port (`https://app.example.com:8443`) also requires that scheme/port.
 */
export function isOriginAllowed(origin: string, allowed: string[], options: { wildcard?: boolean } = {}): boolean {
    if (options.wildcard !== false && allowed.includes('*')) return true;
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    const host = url.hostname;
    const scheme = url.protocol.replace(':', '');
    const port = url.port || (scheme === 'https' ? '443' : scheme === 'http' ? '80' : '');
    return allowed.some((entry) => {
        if (entry === '*') return false;
        const match = ENTRY.exec(entry);
        if (!match) return false;
        const [, entryScheme, entryHost, entryPort] = match;
        if (entryScheme && entryScheme.toLowerCase() !== scheme) return false;
        if (entryPort && entryPort !== port) return false;
        const expected = entryHost.toLowerCase();
        return host === expected || host.endsWith(`.${expected}`);
    });
}

/**
 * Validate a post-login redirect target to prevent open redirects. Accepts same-site
 * relative paths, and absolute http(s) URLs whose origin is explicitly allowed —
 * ALLOWED_ORIGINS (a `*` there does NOT count), the request's own origin, or `extra`.
 */
export function safeRedirectTarget(
    target: unknown,
    fallback: string,
    options: { requestOrigin?: string; extra?: string[] } = {}
): string {
    if (typeof target !== 'string' || target === '') return fallback;
    // Browsers strip tabs/newlines from URLs: "/\t/evil.com" would become "//evil.com"
    if (/[\u0000-\u0020\u007f-\u009f]/.test(target)) return fallback;
    // Relative path — resolved the way a browser would; anything leaving the origin
    // (//evil.com, /\evil.com, ...) is rejected, the rest is returned normalized
    if (target.startsWith('/')) {
        const base = 'http://relative.invalid';
        let resolved: URL;
        try {
            resolved = new URL(target, base);
        } catch {
            return fallback;
        }
        return resolved.origin === base ? `${resolved.pathname}${resolved.search}${resolved.hash}` : fallback;
    }
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        return fallback;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
    // Login tickets must not travel in cleartext to a production frontend
    if (process.env.NODE_ENV === 'production' && url.protocol === 'http:'
        && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        return fallback;
    }
    if (options.requestOrigin && url.origin === options.requestOrigin) return url.toString();
    const allowed = [...parseAllowedOrigins(), ...(options.extra || [])];
    return isOriginAllowed(url.origin, allowed, { wildcard: false }) ? url.toString() : fallback;
}

/** Append query parameters to an absolute URL or a relative path */
export function appendQuery(target: string, params: Record<string, string>): string {
    const relative = target.startsWith('/');
    const url = new URL(target, 'http://relative.invalid');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return relative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}
