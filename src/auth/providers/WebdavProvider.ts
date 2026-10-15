import { ErrorResponse } from '../../core/errors';
import { Logger } from '../../utils/Logger';
import type { AuthProvider, ExternalIdentity, WebdavProviderConfig, AuthLinkConfig } from '../../types';

/**
 * WebDAV password provider — validates credentials by issuing an authenticated
 * `PROPFIND` (Depth: 0) against a WebDAV server such as Nextcloud, ownCloud or SharePoint.
 * 2xx means the server accepted the credentials; 401/403 means it did not.
 *
 * The URL may contain `{{username}}` (URL-encoded), e.g.
 * `https://cloud.example.com/remote.php/dav/files/{{username}}/` — which additionally
 * proves the credentials belong to that user's own collection.
 */
export class WebdavProvider implements AuthProvider {
    readonly name: string;
    readonly type = 'webdav';
    readonly link?: AuthLinkConfig | false;
    private readonly url: string;
    private readonly timeout: number;
    private readonly urlNamesUser: boolean;

    constructor(config: WebdavProviderConfig) {
        this.name = config.name || 'webdav';
        this.link = config.link;
        this.url = config.url;
        this.timeout = config.timeout ?? 5000;
        this.urlNamesUser = this.url.includes('{{username}}');

        if (!this.url) {
            throw new Error(`[Auth] WebDAV provider "${this.name}" needs a url`);
        }
        if (process.env.NODE_ENV === 'production' && this.url.startsWith('http://')) {
            Logger.warn(`Auth: WebDAV provider "${this.name}" sends passwords over plain http://`);
        }
    }

    async authenticate(username: string, password: string): Promise<ExternalIdentity | null> {
        if (typeof username !== 'string' || typeof password !== 'string') return null;
        // RFC 7617: the user-id of Basic credentials cannot contain a colon
        if (!username.trim() || !password || username.includes(':') || /[\r\n\0]/.test(username)) return null;

        const url = this.url.replace(/\{\{username\}\}/g, encodeURIComponent(username));
        let status: number;
        let body = '';
        try {
            const response = await fetch(url, {
                method: 'PROPFIND',
                headers: {
                    Authorization: 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64'),
                    Depth: '0',
                    'Content-Type': 'application/xml; charset=utf-8',
                },
                // current-user-principal (RFC 5397): WHO the server authenticated — the typed
                // login may be an alias (e.g. an email address another account claims)
                body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>',
                redirect: 'manual',
                signal: AbortSignal.timeout(this.timeout),
            });
            status = response.status;
            body = status >= 200 && status < 300 ? (await response.text()).slice(0, 65536) : '';
            if (!body) await response.body?.cancel().catch(() => undefined);
        } catch (err) {
            Logger.error(`Auth: WebDAV server unreachable for provider "${this.name}"`, { error: (err as Error).message });
            throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
        }

        if (status === 401 || status === 403) return null;
        if (status === 404) {
            // A {{username}} URL that doesn't exist for this login (e.g. email typed where the
            // server expects its internal user name) — or a misconfigured URL. Not a login.
            Logger.warn(`Auth: WebDAV URL not found for provider "${this.name}" — check the url template`, { status });
            return null;
        }
        if (status < 200 || status >= 300) {
            Logger.error(`Auth: unexpected WebDAV status for provider "${this.name}"`, { status });
            throw new ErrorResponse(503, 'auth_provider_unavailable', { provider: this.name });
        }

        // Prefer the principal the server reports over the typed login
        const principal = principalName(body);
        if (!principal && !this.urlNamesUser) {
            Logger.warn(`Auth: WebDAV provider "${this.name}" cannot confirm which account authenticated (no current-user-principal) — put {{username}} in the url`);
            return null;
        }
        const name = principal ?? username;
        return {
            provider: this.name,
            subject: name,
            username: name,
            groups: [],
            roles: [],
            claims: { username: name, ...(principal && principal !== username ? { login: username } : {}) },
        };
    }
}

/** Last path segment of the <current-user-principal> href, e.g. /remote.php/dav/principals/users/alice/ → alice */
function principalName(xml: string): string | null {
    const match = /<(?:[\w-]+:)?current-user-principal\b[^>]*>\s*<(?:[\w-]+:)?href\b[^>]*>([^<]+)</i.exec(xml);
    if (!match) return null;
    const segments = match[1].trim().replace(/\/+$/, '').split('/');
    try {
        return decodeURIComponent(segments[segments.length - 1]) || null;
    } catch {
        return null;
    }
}
