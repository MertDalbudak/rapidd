import http from 'http';
import { WebdavProvider } from '../../src/auth/providers/WebdavProvider';

describe('WebdavProvider', () => {
    let server: http.Server;
    let base: string;
    let lastRequest: { method?: string; url?: string; headers: http.IncomingHttpHeaders };
    let status = 207;
    let reportPrincipal = true;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            lastRequest = { method: req.method, url: req.url, headers: req.headers };
            const [user, pass] = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64')
                .toString().split(':');
            if (status !== 207) {
                res.writeHead(status);
                res.end();
                return;
            }
            // Two accounts; bob also accepts the alias "alice@example.com" as his login
            const principal = pass === 'secret' && user === 'alice' ? 'alice'
                : pass === 'bob-pass' && (user === 'bob' || user === 'alice@example.com') ? 'bob' : null;
            res.writeHead(principal ? 207 : 401);
            res.end(principal && reportPrincipal
                ? `<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/users/${principal}/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`
                : '<d:multistatus xmlns:d="DAV:"/>');
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });

    afterAll(async () => {
        await new Promise<void>((r) => server.close(() => r()));
    });

    beforeEach(() => {
        status = 207;
        reportPrincipal = true;
    });

    const provider = (url = `${base}/remote.php/dav/files/{{username}}/`) =>
        new WebdavProvider({ type: 'webdav', url });

    it('accepts credentials the server accepts (PROPFIND, Depth 0)', async () => {
        const identity = await provider().authenticate('alice', 'secret');
        expect(identity).toMatchObject({ provider: 'webdav', subject: 'alice', username: 'alice' });
        expect(lastRequest.method).toBe('PROPFIND');
        expect(lastRequest.headers.depth).toBe('0');
        expect(lastRequest.url).toBe('/remote.php/dav/files/alice/');
    });

    it('rejects credentials the server rejects', async () => {
        expect(await provider().authenticate('alice', 'wrong')).toBeNull();
    });

    it('URL-encodes the username in the URL template', async () => {
        await provider().authenticate('a/b?c', 'x');
        expect(lastRequest.url).toBe('/remote.php/dav/files/a%2Fb%3Fc/');
    });

    it('rejects usernames Basic auth cannot carry, and empty passwords', async () => {
        expect(await provider().authenticate('ali:ce', 'secret')).toBeNull();
        expect(await provider().authenticate('alice\r\nX-Injected: 1', 'secret')).toBeNull();
        expect(await provider().authenticate('alice', '')).toBeNull();
    });

    it('treats 404 as a failed login, 5xx and network errors as unavailable', async () => {
        status = 404;
        expect(await provider().authenticate('alice', 'secret')).toBeNull();
        status = 500;
        await expect(provider().authenticate('alice', 'secret')).rejects.toMatchObject({ status_code: 503 });
        await expect(provider('http://127.0.0.1:1/dav').authenticate('alice', 'secret'))
            .rejects.toMatchObject({ status_code: 503 });
    });

    it('requires a url', () => {
        expect(() => new WebdavProvider({ type: 'webdav', url: '' })).toThrow(/url/);
    });

    it('uses the principal the server authenticated, not the typed alias', async () => {
        const p = provider(`${base}/remote.php/dav/`);
        const identity = await p.authenticate('alice@example.com', 'bob-pass'); // bob logging in via an alias
        expect(identity).toMatchObject({ subject: 'bob', username: 'bob', claims: { login: 'alice@example.com' } });
    });

    it('fails closed when the account cannot be confirmed (no principal, no {{username}})', async () => {
        reportPrincipal = false;
        expect(await provider(`${base}/remote.php/dav/`).authenticate('alice', 'secret')).toBeNull();
        expect(await provider().authenticate('alice', 'secret')).toMatchObject({ username: 'alice' }); // path-bound URL
    });
});
