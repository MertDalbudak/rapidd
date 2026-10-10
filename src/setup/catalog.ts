/**
 * Every setting Rapidd reads from the environment — with its effective default, help text,
 * when it applies and how it is validated. The setup wizard renders from this catalog; a test
 * keeps it in step with the code and with .env.example.
 *
 * Defaults are the values the code applies when a variable is unset — not the values in
 * .env.example.
 */

export type SettingType = 'string' | 'number' | 'boolean' | 'enum' | 'multi' | 'secret' | 'url' | 'json' | 'list';

/** Declarative condition — serializable, evaluated by the server for both front-ends */
export type Condition =
    | { key: string; equals: string }
    | { key: string; includes: string }
    | { key: string; set: boolean }
    | { any: Condition[] }
    | { all: Condition[] }
    | { not: Condition };

export interface Setting {
    key: string;
    label: string;
    help: string;
    type: SettingType;
    /** What applies when unset (display text) */
    default?: string;
    /** Allowed values (enum, multi) */
    options?: string[];
    /** multi: options that stand alone — choosing one clears the others */
    exclusive?: string[];
    /** How options are shown, when not by their value */
    labels?: Record<string, string>;
    placeholder?: string;
    /** Only shown — and only validated — when this holds */
    when?: Condition;
    /** An empty value is an error (always, or when the condition holds) */
    required?: boolean | Condition;
    /** A random value can be generated */
    generate?: 'secret';
    /** Collapsed under "advanced" */
    advanced?: boolean;
}

export type CheckName = 'database' | 'redis' | 'ldap' | 'oidc' | 'webdav';

export interface Section {
    id: string;
    /** Top-level group — the ══ banners of .env.example */
    group: string;
    title: string;
    description: string;
    when?: Condition;
    /** Connection test offered for this section */
    check?: CheckName;
    settings: Setting[];
}

export type Values = Record<string, string | undefined>;

const has = (key: string, item: string): Condition => ({ key, includes: item });
const is = (key: string, value: string): Condition => ({ key, equals: value });
const set = (key: string): Condition => ({ key, set: true });
const EXTERNAL: Condition = { any: [has('AUTH_PROVIDERS', 'ldap'), has('AUTH_PROVIDERS', 'oidc'), has('AUTH_PROVIDERS', 'webdav')] };
const PRODUCTION = is('NODE_ENV', 'production');
/** Sign-in is on — everything but AUTH_PROVIDERS=none */
const SIGN_IN: Condition = { not: has('AUTH_PROVIDERS', 'none') };

/** Lower-cased, trimmed items of a comma-separated value */
export function listItems(value: string | undefined): string[] {
    return (value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Evaluate a condition against the values */
export function matches(condition: Condition | undefined, values: Values): boolean {
    if (!condition) return true;
    if ('any' in condition) return condition.any.some((c) => matches(c, values));
    if ('all' in condition) return condition.all.every((c) => matches(c, values));
    if ('not' in condition) return !matches(condition.not, values);
    const value = values[condition.key] ?? '';
    if ('equals' in condition) return value.trim().toLowerCase() === condition.equals.toLowerCase();
    if ('includes' in condition) return listItems(value).includes(condition.includes.toLowerCase());
    return (value.trim() !== '') === condition.set;
}

/** Keys that conditions depend on — a change to one of them can show or hide settings */
export function conditionKeys(sections: Section[]): string[] {
    const keys = new Set<string>();
    const visit = (c: Condition | boolean | undefined): void => {
        if (!c || typeof c === 'boolean') return;
        if ('any' in c) c.any.forEach(visit);
        else if ('all' in c) c.all.forEach(visit);
        else if ('not' in c) visit(c.not);
        else keys.add(c.key);
    };
    for (const section of sections) {
        visit(section.when);
        for (const setting of section.settings) {
            visit(setting.when);
            visit(setting.required);
        }
    }
    return [...keys];
}

export const SECTIONS: Section[] = [
    {
        id: 'server',
        group: 'Server',
        title: 'Server',
        description: 'Where the API listens and how it is reached from outside.',
        settings: [
            { key: 'NODE_ENV', label: 'Environment', type: 'enum', options: ['development', 'production', 'test'], default: 'development',
                help: 'production enforces secrets, restricts CORS to ALLOWED_ORIGINS and sets Secure cookies.' },
            { key: 'HOST', label: 'Listen address', type: 'string', default: '0.0.0.0',
                help: 'Network interface to bind. 0.0.0.0 listens on all interfaces; 127.0.0.1 only locally.' },
            { key: 'PORT', label: 'Port', type: 'number', default: '3000', help: 'TCP port of the API.' },
            { key: 'PUBLIC_URL', label: 'Public URL', type: 'url', placeholder: 'https://api.example.com',
                required: { all: [PRODUCTION, has('AUTH_PROVIDERS', 'oidc'), { not: is('OIDC_LOGIN', 'false') }] },
                help: 'Externally visible base URL of this API — used for single sign-on callback URLs. Required in production for OIDC browser login.' },
            { key: 'TRUST_PROXY', label: 'Trusted proxies', type: 'string', default: 'every proxy', placeholder: 'private or 10.0.0.0/8',
                help: 'The proxies in front of the API — nginx, a load balancer, Cloudflare — that may pass on the client’s IP (X-Forwarded-For). Rate limits and logs use that IP. Set it in production.' },
            { key: 'BODY_LIMIT', label: 'Max request body (bytes)', type: 'number', default: '1048576', advanced: true,
                help: 'Largest request body in bytes — 1048576 = 1 MB, 10485760 = 10 MB. Larger bodies are rejected with 413.' },
            { key: 'REQUEST_ID_HEADER', label: 'Request id header', type: 'string', default: 'x-request-id', advanced: true,
                help: 'Incoming header whose value becomes the request id (end-to-end correlation) — if it is 1–128 letters, digits, dots, underscores, colons or dashes; otherwise a new UUID is used.' },
        ],
    },
    {
        id: 'health',
        group: 'Server',
        title: 'Health & shutdown',
        description: 'Health endpoints for orchestrators, and how a shutdown drains traffic.',
        settings: [
            { key: 'HEALTH_ENABLED', label: 'Health endpoints', type: 'boolean', default: 'true',
                help: 'GET /health (liveness) and /health/ready (database, Redis).' },
            { key: 'SHUTDOWN_DELAY_MS', label: 'Shutdown delay (ms)', type: 'number', default: '0',
                help: 'Milliseconds the API keeps serving after SIGTERM, with readiness answering 503, so load balancers stop routing to it first. Kubernetes: 5000.' },
            { key: 'SHUTDOWN_TIMEOUT_MS', label: 'Shutdown timeout (ms)', type: 'number', default: '10000',
                help: 'Milliseconds running requests get to finish on shutdown — then the process exits with code 1.' },
        ],
    },
    {
        id: 'database',
        group: 'Data stores',
        title: 'Database',
        description: 'PostgreSQL, MySQL or MariaDB. The connection string is the only setting the API cannot start without.',
        check: 'database',
        settings: [
            { key: 'DATABASE_URL', label: 'Connection string', type: 'secret', required: true,
                placeholder: 'postgresql://user:password@localhost:5432/app?schema=public',
                help: 'postgresql:// for PostgreSQL, mysql:// or mariadb:// for MySQL and MariaDB — with user, password, host, port, database and the parameters below.' },
            { key: 'DATABASE_URL_ADMIN', label: 'Admin connection string', type: 'secret', default: 'DATABASE_URL',
                help: 'Same format as DATABASE_URL, for a role that may bypass row-level security (the tables’ owner or a superuser): sign-in looks users up with it, and this wizard changes policies with it. Defaults to the main connection.' },
            { key: 'DATABASE_PROVIDER', label: 'Provider', type: 'enum', options: ['postgresql', 'mysql'], default: 'detected from the URL', advanced: true,
                help: 'Only needed when the connection string does not reveal the database type.' },
        ],
    },
    {
        id: 'redis',
        group: 'Data stores',
        title: 'Redis',
        description: 'Optional. Sessions and rate limits are shared between instances and survive restarts with Redis; without it they live in process memory.',
        check: 'redis',
        settings: [
            { key: 'REDIS_URL', label: 'URL', type: 'secret', placeholder: 'redis://:password@redis:6379 or rediss://... for TLS',
                help: 'redis://user:password@host:port/db — user, password and /db optional; rediss:// for TLS. Takes precedence over host and port; a /db here wins over the database numbers.' },
            { key: 'REDIS_HOST', label: 'Host', type: 'string', when: { not: set('REDIS_URL') }, help: 'Host name or IP — instead of a URL.' },
            { key: 'REDIS_PORT', label: 'Port', type: 'number', default: '6379', when: { not: set('REDIS_URL') }, help: 'Redis port.' },
            { key: 'REDIS_USERNAME', label: 'Username', type: 'string', help: 'Redis 6+ ACL user.' },
            { key: 'REDIS_PASSWORD', label: 'Password', type: 'secret', help: 'Redis password.' },
            { key: 'REDIS_TLS', label: 'TLS', type: 'boolean', default: 'false', when: { not: set('REDIS_URL') },
                help: 'For managed Redis (Azure, AWS, GCP) with host and port.' },
            { key: 'REDIS_DB_RATE_LIMIT', label: 'Database: rate limits', type: 'number', default: '0', advanced: true, help: 'Redis database number for rate limits — 0–15 on a default server. A /db in REDIS_URL wins.' },
            { key: 'REDIS_DB_AUTH', label: 'Database: sessions', type: 'number', default: '1', advanced: true, help: 'Redis database number for sessions — 0–15 on a default server. A /db in REDIS_URL wins.' },
        ],
    },
    {
        id: 'access',
        group: 'Security',
        title: 'Access control',
        description: 'The default for models without ACL rules, and row-level security in the database.',
        settings: [
            { key: 'ACL_DEFAULT', label: 'Models without an ACL entry', type: 'enum', options: ['allow', 'deny'], default: 'allow',
                help: 'For models without access rules (Access control page, or code in src/config/acl.ts). allow: unrestricted — every signed-in user (without sign-in: everyone) may read and change them · deny: closed to everyone but the system user.' },
            { key: 'RLS_ENABLED', label: 'Row-level security', type: 'boolean', default: 'true on PostgreSQL, false on MySQL',
                help: 'Sets SQL session variables (Row-level security page, config/rls.json) on every query, so PostgreSQL policies can use them.' },
            { key: 'RLS_NAMESPACE', label: 'RLS variable namespace', type: 'string', default: 'app', advanced: true,
                help: 'Prefix of the session variables — letters, digits and _. app gives app.current_user_id on PostgreSQL, @app_current_user_id on MySQL.' },
        ],
    },
    {
        id: 'browser',
        group: 'Security',
        title: 'Browser access',
        description: 'Which websites may call the API, and how cookies are signed.',
        settings: [
            { key: 'ALLOWED_ORIGINS', label: 'Allowed origins (CORS)', type: 'list', default: 'all in development, same-origin only in production',
                placeholder: 'app.example.com, https://admin.example.com',
                help: 'Comma-separated websites that may call the API from a browser. app.example.com: that host and its subdomains, any scheme and port · https://admin.example.com:8443: exactly that scheme, host and port · *: every website.' },
            { key: 'CORS_ALLOWED_HEADERS', label: 'Extra allowed request headers', type: 'list', advanced: true, placeholder: 'X-Tenant-Id',
                help: 'Comma-separated request headers browsers may send besides Content-Type, Authorization, X-Request-Id and the auth header (AUTH_CUSTOM_HEADER).' },
            { key: 'COOKIE_SECRET', label: 'Cookie secret', type: 'secret', generate: 'secret',
                help: 'At least 32 random characters. Signs cookies, the auth cookies included — without it they are not signed.' },
            { key: 'COOKIE_SAME_SITE', label: 'Cookie SameSite', type: 'enum', options: ['strict', 'lax', 'none'], default: 'strict', advanced: true,
                help: 'For the app’s own cookies (auth cookies: AUTH_COOKIE_SAME_SITE). strict: sent by this site’s pages only · lax: also when following a link here · none: also from other sites — HTTPS only.' },
        ],
    },
    {
        id: 'ratelimit',
        group: 'Security',
        title: 'Rate limiting',
        description: 'Requests per client IP. Per-path limits live in config/rate-limit.json; counters are shared through Redis when it is configured.',
        settings: [
            { key: 'RATE_LIMIT_ENABLED', label: 'Enabled', type: 'boolean', default: 'true', help: 'Limit requests per client IP — enforced with NODE_ENV=production only.' },
            { key: 'RATE_LIMIT_WINDOW_MS', label: 'Window (ms)', type: 'number', default: '900000', help: 'Length of the window in milliseconds — 60000 = 1 minute, 900000 = 15 minutes.' },
            { key: 'RATE_LIMIT_MAX_REQUESTS', label: 'Requests per window', type: 'number', default: '100', help: 'Requests per client IP and window. Paths with their own rule (Rate limits page) use that instead.' },
        ],
    },
    {
        id: 'api',
        group: 'API',
        title: 'Queries & responses',
        description: 'Result limits, pagination, filters, and the language of messages.',
        settings: [
            { key: 'API_RESULT_LIMIT', label: 'Max results per query', type: 'number', default: '500', help: 'Most rows a list returns — a larger ?limit= is lowered to it.' },
            { key: 'API_INCLUDE_RESULT_LIMIT', label: 'Max rows per included list', type: 'number', default: 'API_RESULT_LIMIT',
                help: 'Most rows per included list relation (?include=posts). 0 = no cap.' },
            { key: 'PAGINATION_MODE', label: 'Pagination', type: 'enum', options: ['offset', 'page'], default: 'offset',
                help: 'offset: ?limit & ?offset · page: ?page & ?pageSize.' },
            { key: 'MAX_FILTER_CONDITIONS', label: 'Max filter conditions', type: 'number', default: '100', advanced: true, help: 'Most conditions in one ?q= filter.' },
            { key: 'MAX_FILTER_ARRAY_LENGTH', label: 'Max filter array length', type: 'number', default: '1000', advanced: true, help: 'Most values in a list filter such as id=[1,2,3].' },
            { key: 'API_TIMEZONE', label: 'Timezone for date filters', type: 'string', default: "the server's timezone", placeholder: 'Europe/Berlin',
                help: 'IANA zone in which date-only filters (on:2024-06-15) mean a calendar day — e.g. Europe/Berlin, America/New_York, UTC.' },
            { key: 'DEFAULT_LANGUAGE', label: 'Default language', type: 'enum', default: 'en_US',
                help: 'Language of messages when the request names none.' },
        ],
    },
    {
        id: 'outgoing',
        group: 'API',
        title: 'Outgoing requests',
        description: 'Timeout and retries of ApiClient calls to the services in config/app.json.',
        settings: [
            { key: 'REQUEST_TIMEOUT', label: 'Timeout (ms)', type: 'number', default: '10000', help: 'Milliseconds before an ApiClient call is aborted — the default for every service.' },
            { key: 'API_MAX_RETRIES', label: 'Retries', type: 'number', default: '2',
                help: 'How often ApiClient retries a failed idempotent call (GET, PUT, DELETE …). POST and PATCH are not retried unless a call asks for it.' },
        ],
    },
    {
        id: 'logging',
        group: 'Operations',
        title: 'Logging',
        description: 'Verbosity, format and where logs go.',
        settings: [
            { key: 'LOG_LEVEL', label: 'Level', type: 'enum', options: ['essential', 'fine', 'finest'], default: 'essential',
                help: 'essential: one line per event · fine: plus its details (ids, timings, error stacks) · finest: plus request bodies and headers, credentials redacted.' },
            { key: 'LOG_FORMAT', label: 'Format', type: 'enum', options: ['text', 'json'], default: 'text', help: 'json writes one object per line for log aggregators.' },
            { key: 'LOG_DIR', label: 'Log directory', type: 'string', default: 'logs',
                help: 'Empty disables log files (containers: log to stdout only).' },
            { key: 'FASTIFY_LOGGER', label: 'Fastify request logger', type: 'boolean', default: 'false', advanced: true,
                help: "Fastify's own per-request logger, in addition to Rapidd's logging." },
        ],
    },
    {
        id: 'setup',
        group: 'Operations',
        title: 'Setup wizard',
        description: 'When this wizard opens by itself.',
        settings: [
            { key: 'SETUP_WIZARD', label: 'Setup wizard', type: 'enum', options: ['auto', 'on', 'off'], default: 'auto',
                help: 'auto: while the API cannot start, serve this wizard instead of exiting · on: at every start, before the API — set it back once done · off: exit with an error (orchestrated deployments). npm run setup opens it any time.' },
            { key: 'SETUP_PASSWORD', label: 'Setup password', type: 'secret', default: 'random, printed to the console', advanced: true,
                help: "The wizard's access password. Empty: a random one per start, printed with the wizard link. Set one (16+ characters) only when a script drives the setup." },
        ],
    },
    {
        id: 'providers',
        group: 'Authentication',
        title: 'Sign-in providers',
        description: 'Where users sign in — or none, for an API without sign-in. Every provider you enable gets its own page.',
        settings: [
            { key: 'AUTH_PROVIDERS', label: 'Identity providers', type: 'multi', options: ['local', 'ldap', 'oidc', 'webdav', 'none'], default: 'local',
                exclusive: ['none'], labels: { none: 'none — no sign-in' },
                help: 'In order — password logins try them one after another. local: your user table · ldap: LDAP / Active Directory · oidc: OpenID Connect / OAuth2 (Entra ID, Keycloak, Okta, Google) · webdav: a WebDAV server (Nextcloud) · none: no sign-in — every request is anonymous, access rules decide what it may do.' },
        ],
    },
    {
        id: 'tokens',
        group: 'Authentication',
        when: SIGN_IN,
        title: 'Tokens',
        description: 'How access and refresh tokens are signed, and how long they live.',
        settings: [
            { key: 'JWT_SECRET', label: 'Access token secret', type: 'secret', generate: 'secret', required: PRODUCTION,
                help: 'At least 32 random characters. Signs access tokens. Without it development generates one per start — every restart logs everyone out.' },
            { key: 'JWT_REFRESH_SECRET', label: 'Refresh token secret', type: 'secret', generate: 'secret', required: PRODUCTION,
                help: 'At least 32 random characters, not the access token secret. Signs refresh tokens.' },
            { key: 'AUTH_ACCESS_TOKEN_EXPIRY', label: 'Access token lifetime', type: 'string', default: '1d', placeholder: '15m', help: 'How long an access token is valid: a number and a unit — 15m, 1h, 1d (s, m, h, d, w). A bare number is seconds.' },
            { key: 'AUTH_REFRESH_TOKEN_EXPIRY', label: 'Refresh token lifetime', type: 'string', default: '7d', placeholder: '30d', help: 'How long a refresh token is valid — 7d, 30d, same units. Refresh tokens rotate on every use.' },
        ],
    },
    {
        id: 'sessions',
        group: 'Authentication',
        when: SIGN_IN,
        title: 'Sessions',
        description: 'Where sessions are stored and how long they last.',
        settings: [
            { key: 'AUTH_SESSION_STORAGE', label: 'Session store', type: 'enum', options: ['redis', 'memory'], default: 'redis when Redis is configured, else memory',
                help: 'memory loses sessions on restart and is not shared between instances.' },
            { key: 'AUTH_SESSION_TTL', label: 'Idle timeout (s)', type: 'number', default: '86400', help: 'Seconds without use after which a session ends — 86400 = 1 day.' },
            { key: 'AUTH_SESSION_MAX_AGE', label: 'Absolute lifetime (s)', type: 'number', default: '0', help: 'Seconds after sign-in after which a new sign-in is required, in use or not. 0 = no limit.' },
        ],
    },
    {
        id: 'transport',
        group: 'Authentication',
        when: SIGN_IN,
        title: 'Session transport',
        description: 'How clients send their session: a header, a cookie, or both.',
        settings: [
            { key: 'AUTH_STRATEGIES', label: 'Methods', type: 'multi', options: ['bearer', 'basic', 'cookie', 'header'], default: 'bearer',
                help: 'How clients send their session: Authorization: Bearer, HTTP Basic, a cookie, or a custom header.' },
            { key: 'AUTH_COOKIE_NAME', label: 'Cookie name', type: 'string', default: 'token', when: has('AUTH_STRATEGIES', 'cookie'),
                help: 'The refresh cookie is <name>_refresh.' },
            { key: 'AUTH_COOKIE_DOMAIN', label: 'Cookie domain', type: 'string', when: has('AUTH_STRATEGIES', 'cookie'), placeholder: '.example.com',
                help: 'Unset: the current host only. .example.com shares the cookie with subdomains.' },
            { key: 'AUTH_COOKIE_SAME_SITE', label: 'Cookie SameSite', type: 'enum', options: ['strict', 'lax', 'none'], default: 'strict',
                when: has('AUTH_STRATEGIES', 'cookie'), help: 'none is needed for cross-site front-ends and requires Secure.' },
            { key: 'AUTH_COOKIE_SECURE', label: 'Secure cookie', type: 'boolean', default: 'true in production', when: has('AUTH_STRATEGIES', 'cookie'),
                help: 'Send the cookie over HTTPS only.' },
            { key: 'AUTH_CUSTOM_HEADER', label: 'Custom header', type: 'string', default: 'X-Auth-Token', when: has('AUTH_STRATEGIES', 'header'),
                help: 'Header carrying the token for the header strategy.' },
        ],
    },
    {
        id: 'users',
        group: 'Authentication',
        when: SIGN_IN,
        title: 'User table',
        description: 'Your users — for local sign-in, and to link external identities to rows. Detected automatically; set these only to override.',
        settings: [
            { key: 'DB_USER_TABLE', label: 'Table', type: 'string', default: 'detected (user, users, account, accounts)',
                help: 'The Prisma model that holds the users — its name as in the schema (case matters).' },
            { key: 'DB_USER_PASSWORD_FIELD', label: 'Password field', type: 'string', default: 'detected (password, hash, ...)',
                help: 'Column of the user table holding the bcrypt password hash.' },
            { key: 'DB_USER_IDENTIFIER_FIELDS', label: 'Login identifiers', type: 'list', default: 'unique text columns, else email',
                help: 'Comma-separated columns a user can sign in with — e.g. email, username.' },
            { key: 'AUTH_SALT_ROUNDS', label: 'bcrypt rounds', type: 'number', default: '10',
                help: 'bcrypt cost, 4–31. Each step doubles the time a password check takes — 10 to 12 is usual.' },
        ],
    },
    {
        id: 'identities',
        group: 'Authentication',
        title: 'External identities',
        description: 'How LDAP, OIDC and WebDAV users become app users: linked to a user-table row, or roles from their claims.',
        when: EXTERNAL,
        settings: [
            { key: 'AUTH_LINK', label: 'Link external identities by', type: 'string', default: 'email', placeholder: 'email',
                help: 'How a directory or identity provider sign-in finds its user-table row — see the values below.' },
            { key: 'AUTH_ROLE_MAP', label: 'Role mapping', type: 'json',
                placeholder: '{"CN=App Admins,OU=Groups,DC=corp,DC=example,DC=com":"admin","role:editor":"editor"}',
                help: 'Roles for users that come from claims only (no user-table row) — a JSON object, see below.' },
            { key: 'AUTH_DEFAULT_ROLE', label: 'Default role', type: 'string',
                help: 'Role of claims-only users that no AUTH_ROLE_MAP entry matched. Empty: no role — the rules for everyone (*) apply.' },
        ],
    },
    {
        id: 'ldap',
        group: 'Authentication',
        title: 'LDAP / Active Directory',
        description: 'Search-then-bind with a service account (recommended), or direct bind with a DN template.',
        when: has('AUTH_PROVIDERS', 'ldap'),
        check: 'ldap',
        settings: [
            { key: 'LDAP_URL', label: 'Servers', type: 'list', required: true, placeholder: 'ldaps://dc1.corp.example.com, ldaps://dc2.corp.example.com',
                help: 'One or more servers, tried in order (failover). ldaps:// recommended.' },
            { key: 'LDAP_BIND_DN', label: 'Service account DN', type: 'string', placeholder: 'CN=svc-api,OU=Service Accounts,DC=corp,DC=example,DC=com',
                help: 'Search-then-bind: the account that looks users up.' },
            { key: 'LDAP_BIND_PASSWORD', label: 'Service account password', type: 'secret', help: 'Password of the service account.' },
            { key: 'LDAP_SEARCH_BASE', label: 'Search base', type: 'string', placeholder: 'DC=corp,DC=example,DC=com', help: 'Where users are searched.' },
            { key: 'LDAP_SEARCH_FILTER', label: 'Search filter', type: 'string', default: 'sAMAccountName, userPrincipalName, uid or mail', advanced: true,
                placeholder: '(&(objectClass=user)(sAMAccountName={{username}}))', help: '{{username}} is escaped and inserted.' },
            { key: 'LDAP_BIND_TEMPLATE', label: 'Direct bind template', type: 'string', placeholder: '{{username}}@corp.example.com',
                help: 'Bind as the user directly, without a service account: {{username}}@corp.example.com (Active Directory) or uid={{username}},ou=people,dc=example,dc=com.' },
            { key: 'LDAP_NESTED_GROUPS', label: 'Nested groups (AD)', type: 'boolean', default: 'false', help: 'Resolve Active Directory group membership transitively.' },
            { key: 'LDAP_GROUP_SEARCH_BASE', label: 'Group search base', type: 'string', advanced: true,
                help: 'For servers without memberOf: search groups that contain the user.' },
            { key: 'LDAP_GROUP_SEARCH_FILTER', label: 'Group search filter', type: 'string', advanced: true, help: '{{dn}} (the user’s DN) and {{username}} are escaped and inserted. Default: (|(member={{dn}})(uniqueMember={{dn}})(memberUid={{username}})).' },
            { key: 'LDAP_STARTTLS', label: 'StartTLS', type: 'boolean', default: 'false', help: 'Upgrade ldap:// connections to TLS.' },
            { key: 'LDAP_TLS_CA_FILE', label: 'CA certificate file', type: 'string', advanced: true, placeholder: '/etc/ssl/corp-ca.pem',
                help: 'PEM file of the CA that signed the directory certificate.' },
            { key: 'LDAP_TLS_REJECT_UNAUTHORIZED', label: 'Verify TLS certificates', type: 'boolean', default: 'true', advanced: true,
                help: 'Only disable for testing.' },
            { key: 'LDAP_TIMEOUT', label: 'Timeout (ms)', type: 'number', default: '5000', advanced: true, help: 'Milliseconds per server for connecting and for each operation.' },
        ],
    },
    {
        id: 'oidc',
        group: 'Authentication',
        title: 'OpenID Connect / OAuth2',
        description: 'Accept access tokens from your identity provider, and offer browser single sign-on.',
        when: has('AUTH_PROVIDERS', 'oidc'),
        check: 'oidc',
        settings: [
            { key: 'OIDC_ISSUER', label: 'Issuer', type: 'url', required: true, placeholder: 'https://login.microsoftonline.com/<tenant-id>/v2.0',
                help: 'Entra ID: https://login.microsoftonline.com/<tenant-id>/v2.0 · Keycloak: https://sso.example.com/realms/<realm>' },
            { key: 'OIDC_CLIENT_ID', label: 'Client id', type: 'string', required: true, help: 'The application registered at the identity provider.' },
            { key: 'OIDC_CLIENT_SECRET', label: 'Client secret', type: 'secret', help: 'Needed for browser login with a confidential client.' },
            { key: 'OIDC_AUDIENCE', label: 'Expected audience', type: 'list', default: 'the client id',
                help: 'Comma-separated aud values — a bearer token must carry one of them.' },
            { key: 'OIDC_SCOPES', label: 'Login scopes', type: 'string', default: 'openid profile email', advanced: true, help: 'Scopes requested at browser login — separated by spaces or commas.' },
            { key: 'OIDC_REQUIRED_SCOPES', label: 'Required scopes', type: 'string', advanced: true, help: 'Scopes every bearer token must carry, all of them — separated by spaces or commas.' },
            { key: 'OIDC_REDIRECT_URI', label: 'Redirect URI', type: 'url', default: '<PUBLIC_URL>/auth/oidc/callback', advanced: true,
                help: 'Register this callback at the identity provider.' },
            { key: 'OIDC_SUBJECT_CLAIM', label: 'User id claim', type: 'string', default: 'sub', advanced: true, help: 'Stable user id claim — Entra ID: oid.' },
            { key: 'OIDC_ACCEPT_BEARER', label: 'Accept access tokens', type: 'boolean', default: 'true', help: "Accept the IdP's access tokens as bearer tokens." },
            { key: 'OIDC_LOGIN', label: 'Browser login', type: 'boolean', default: 'true', help: 'Offer /auth/oidc/login (authorization code + PKCE).' },
            { key: 'OIDC_INTROSPECTION', label: 'Token introspection', type: 'boolean', default: 'false', advanced: true,
                help: 'Validate opaque (non-JWT) tokens via RFC 7662.' },
            { key: 'AUTH_LOGIN_REDIRECT', label: 'After single sign-on, go to', type: 'string', default: '/',
                help: 'Where browser logins land without ?redirect= — a path (/app) or a URL (https://app.example.com/). ?redirect= may name a path, the API’s own origin, an ALLOWED_ORIGINS entry (not *) or this URL’s origin.' },
        ],
    },
    {
        id: 'webdav',
        group: 'Authentication',
        title: 'WebDAV',
        description: 'Check credentials against a WebDAV server such as Nextcloud or ownCloud.',
        when: has('AUTH_PROVIDERS', 'webdav'),
        check: 'webdav',
        settings: [
            { key: 'WEBDAV_URL', label: 'URL', type: 'url', required: true, placeholder: 'https://cloud.example.com/remote.php/dav/files/{{username}}/',
                help: '{{username}} is URL-encoded and inserted.' },
            { key: 'WEBDAV_TIMEOUT', label: 'Timeout (ms)', type: 'number', default: '5000', advanced: true, help: 'Milliseconds per request.' },
        ],
    },
];

/**
 * Secret-like names — for variables outside the catalog (config/app.json references); catalog
 * settings say it with type 'secret'. TOKEN only at the end: AUTH_ACCESS_TOKEN_EXPIRY is not one.
 */
export function isSecretKey(key: string): boolean {
    return /SECRET|PASSWORD|PASSWD|TOKEN$|PRIVATE|CREDENTIAL|(^|_)KEY$|API_?KEY/.test(key);
}
