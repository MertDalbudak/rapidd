<img width="64" height="64" alt="logo" src="https://github.com/user-attachments/assets/706dd13b-212c-4076-b4d7-94dec4001a06" />

# Rapidd

Code-first REST API framework for TypeScript. Database in, API out.

[![npm](https://img.shields.io/npm/v/@rapidd/core?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@rapidd/core)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![Prisma](https://img.shields.io/badge/Prisma-7.x-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![CI](https://github.com/MertDalbudak/rapidd/actions/workflows/ci.yml/badge.svg)](https://github.com/MertDalbudak/rapidd/actions/workflows/ci.yml)

---

## Why Rapidd

Rapidd generates a fully-featured REST API from your database schema — then gets out of your way. It's not a scaffolder that dumps code you'll rewrite. It's not a hosted service between you and your data. It's a framework you own, extend, and deploy anywhere.

**Unlike Hasura or Supabase**, you get a full TypeScript codebase — no vendor lock-in, no managed service dependency. **Unlike PostgREST**, you get auth, ACL, middleware hooks, and utilities built in. **Unlike Strapi**, it's schema-first via Prisma, not UI-driven.

- **Zero to API in 3 commands** — CRUD endpoints with filtering, pagination, relations, and field selection
- **Convention over configuration** — auto-detects auth tables, password fields, DB provider, and RLS support. Every default overridable
- **Production-grade from day one** — security headers, rotating sessions with reuse detection, row-level security, per-model ACL, rate limiting, health checks, graceful shutdown, request-id-correlated (JSON) logs
- **Enterprise sign-in, plug & play** — your user table, LDAP / Active Directory, OpenID Connect / OAuth2 (Entra ID, Keycloak, Okta, ...) and WebDAV — configured with env vars
- **Essentials included, the rest is yours** — HTTP client, file uploads, rate limiting, i18n across 10 languages; pick your own mailer, queue or SDK
- **Fully extensible** — before/after middleware on every CRUD operation, custom routes alongside generated ones

---

## Quick Start

```bash
mkdir my-api && cd my-api
npx @rapidd/core create-project && npm install
```

```bash
npm run dev                 # not configured yet → opens the setup wizard
npm run setup               # the setup wizard, any time
```

The console prints a link to the **setup wizard**: connect and test the database, read the
schema from it (or create the tables from yours), generate the Prisma client, models and routes,
set up sign-in, access rules, row-level security, rate limits and the external APIs you call,
create the first user — then the API starts, in the same process.

Every table gets full CRUD endpoints. Auth is enabled automatically when a user table is detected. Every auto-detected value — auth fields, password hashing, JWT secrets, session store — is overridable via env vars. See [`.env.example`](.env.example) for the full list.

> **[Getting Started guide](https://github.com/MertDalbudak/rapidd/wiki/Getting-Started)** — full walkthrough with project structure

---

## How It Compares

| | Rapidd | Hasura | PostgREST | Supabase | Strapi |
|---|:---:|:---:|:---:|:---:|:---:|
| Full source code ownership | ✓ | — | — | — | ✓ |
| Schema-first (no UI) | ✓ | ✓ | ✓ | ✓ | — |
| REST API | ✓ | partial | ✓ | ✓ | ✓ |
| Multi-database | ✓ | ✓ | — | — | ✓ |
| Built-in auth | ✓ | — | — | ✓ | ✓ |
| Per-model ACL | ✓ | ✓ | — | — | ✓ |
| Row-level security | ✓* | ✓ | ✓ | ✓ | — |
| Before/after middleware | ✓ | — | — | — | ✓ |
| Custom routes alongside generated | ✓ | — | — | ✓ | ✓ |
| No vendor dependency | ✓ | ✓ | ✓ | — | ✓ |

<sub>* PostgreSQL only. All other features support PostgreSQL and MySQL/MariaDB.</sub>

---

## Query API

All generated endpoints support filtering, relations, field selection, sorting, and pagination.

```
GET /api/v1/posts?filter=status=active,title=%typescript%
GET /api/v1/posts?filter=createdAt=after:2025-01-01,views=gte:100
GET /api/v1/posts?include=author,comments.user&fields=id,title,author.name
GET /api/v1/posts?sort=createdAt:desc&limit=10&offset=20
GET /api/v1/posts?filter=OR(AND(status=active,views=gte:100),author.name=%erika%)
```

Comma-separated conditions combine with implicit AND. For explicit boolean logic use nestable `OR(...)` / `AND(...)` groups (case-insensitive) whose leaves are ordinary conditions, including relation paths.

20+ filter operators for strings, numbers, dates, arrays, nulls, and nested relation fields. Responses include pagination metadata with `total`, `count`, `limit`, `offset`, and `hasMore`.

> **[Query API wiki](https://github.com/MertDalbudak/rapidd/wiki/Query-API)** — all operators, composite PKs, relation filtering

---

## Authentication

Auto-enabled when a user table is detected — or off with `AUTH_PROVIDERS=none`: every request is anonymous and access rules decide. External identity providers plug in with env vars:

```env
AUTH_PROVIDERS=ldap,oidc,local        # tried in order for password logins

LDAP_URL=ldaps://dc1.corp.example.com # Active Directory / LDAP
LDAP_BIND_DN=CN=svc-api,OU=Service,DC=corp,DC=example,DC=com
LDAP_BIND_PASSWORD=...
LDAP_SEARCH_BASE=DC=corp,DC=example,DC=com

OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0   # Entra ID, Keycloak, Okta, ...
OIDC_CLIENT_ID=...                    # accepts the IdP's access tokens + SSO browser login
```

```
POST /auth/login          { "user": "john@example.com", "password": "..." }
POST /auth/logout         Authorization: Bearer <token>
POST /auth/refresh        { "refreshToken": "..." }
GET  /auth/me             Authorization: Bearer <token>
GET  /auth/providers      enabled providers, for login pages
GET  /auth/<provider>/login → IdP → callback → single-use ticket → POST /auth/exchange
```

External identities link to your user table by email (or provision rows on first login, or come from IdP claims with role mapping). Sessions are server-side with rotating refresh tokens, reuse detection and per-user revocation; `validateUser` / `onLogin` hooks gate deactivated accounts and record logins.

Four strategies — **bearer** (default), **basic**, **cookie**, and **custom header** — configurable globally via `AUTH_STRATEGIES` env var or per endpoint prefix in `config/app.json`:

```json
{
    "endpointAuthStrategy": {
        "/api/v1": ["basic", "bearer"],
        "/api/v2": "bearer"
    }
}
```

Set `null` for the global default, a string for a single strategy, or an array for multiple. Route-level config takes highest priority, then prefix match, then global default.

Multi-identifier login lets users authenticate with any unique field (email, username, phone) in a single endpoint.

**Production:** `JWT_SECRET` and `JWT_REFRESH_SECRET` must be set explicitly. The server refuses to start without them to prevent session invalidation on restart.

> **[Authentication wiki](https://github.com/MertDalbudak/rapidd/wiki/Authentication)** — session stores, route protection, per-endpoint strategy overrides

---

## Access Control

Rules per model and role in `config/acl.json` — edited in the setup wizard, generated with defaults by `rapidd build`. Enforced on every CRUD operation, relation include, and field selection.

```json
{
    "models": {
        "posts": {
            "create": { "GUEST": false, "*": true },
            "read":   { "ADMIN": "all", "*": { "where": { "authorId": "$user.id" } } },
            "delete": { "ADMIN": "all" },
            "hide":   { "*": ["internalNotes"], "ADMIN": [] }
        }
    }
}
```

Anything a rule cannot express goes into `src/config/acl.ts` — an entry there takes its model over:

```typescript
const acl: AclConfig = {
    model: {
        posts: {
            canCreate: (user, data) => user.role !== 'GUEST',
            getAccessFilter: (user) => user.role === 'ADMIN' ? {} : { authorId: user.id },
            getUpdateFilter: (user) => user.role === 'ADMIN' ? {} : { authorId: user.id },
            getDeleteFilter: (user) => user.role === 'ADMIN' ? {} : false,
            getOmitFields: (user) => user.role !== 'ADMIN' ? ['internalNotes'] : [],
        }
    }
};
```

Return `{}` for full access, a filter object to scope records, or `false` to deny.

> **[Access Control wiki](https://github.com/MertDalbudak/rapidd/wiki/Access-Control-(ACL))** — all 5 ACL methods, relation ACL, 404 vs 403 distinction

---

## Model Middleware

Hook into any CRUD operation before or after execution.

```typescript
// Auto-timestamps
Model.middleware.use('before', 'create', async (ctx) => {
    ctx.data.createdAt = new Date();
    ctx.data.createdBy = ctx.user?.id;
    return ctx;
});

// Soft deletes (scoped to a specific model)
Model.middleware.use('before', 'delete', async (ctx) => {
    ctx.softDelete = true;
    ctx.data = { deletedAt: new Date(), deletedBy: ctx.user?.id };
    return ctx;
}, 'posts');
```

Supports `create`, `update`, `upsert`, `upsertMany`, `delete`, `get`, `getMany`, and `count`. Middleware can abort operations, modify data, and short-circuit with cached results.

> **[Model Middleware wiki](https://github.com/MertDalbudak/rapidd/wiki/Model-Middleware)** — all hooks, context object, patterns (soft delete, validation, caching)

---

## Row-Level Security

Auto-enabled for PostgreSQL. Define which variables to inject in `src/config/rls.ts`:

```typescript
// src/config/rls.ts
const rlsContext: RlsContextFn = (request) => ({
    current_user_id: request.user?.id ?? null,
    current_tenant_id: request.headers['x-tenant-id'] ?? null,
});
```

```sql
CREATE POLICY tenant_isolation ON orders
    USING (tenant_id = current_setting('app.current_tenant_id')::int);
```

> **[Row-Level Security wiki](https://github.com/MertDalbudak/rapidd/wiki/Row%E2%80%90Level-Security-(RLS))** — policy examples, RLS vs ACL comparison

---

## Built-in Utilities

| Utility | Description | Docs |
|---------|-------------|------|
| **ApiClient** | Config-driven HTTP client with Bearer, Basic, API Key, and OAuth2 auth. Automatic token caching, retries, and fluent builder. | [Wiki](https://github.com/MertDalbudak/rapidd/wiki/ApiClient) |
| **File Uploads** | Multipart uploads with MIME validation, size limits, and type presets (`images`, `documents`, etc.). | [Wiki](https://github.com/MertDalbudak/rapidd/wiki/File-Uploads) |
| **Rate Limiting** | Redis-backed with automatic memory fallback. Per-path configuration via `config/rate-limit.json`. | [Wiki](https://github.com/MertDalbudak/rapidd/wiki/Rate-Limiting) |
| **i18n** | 10 languages included. Auto-detected from `Accept-Language` header. Parameter interpolation in error messages. | [Wiki](https://github.com/MertDalbudak/rapidd/wiki/Internationalization-(i18n)) |

---

## Production & Deployment

```env
NODE_ENV=production
JWT_SECRET=your-secret-here          # Required — server won't start without it
JWT_REFRESH_SECRET=your-refresh-secret
ALLOWED_ORIGINS=yourdomain.com
TRUST_PROXY=1                        # your proxy's hop count or IP/CIDR
REDIS_URL=rediss://cache.example.com:6380
LOG_FORMAT=json
```

```bash
npm run build && npm start

# or Docker
docker build -t my-api . && docker run -p 3000:3000 --env-file .env my-api
```

**Security defaults in production:** HSTS, Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, and CORS with explicit origin whitelisting — all enabled automatically.

**Operations built in:** `GET /health` and `GET /health/ready` (database + session store), graceful shutdown on `SIGTERM` that drains in-flight requests, `X-Request-Id` on every response and every log line, credential redaction in logs, and an `errorReporter` hook for Sentry & co.

> **[Deployment wiki](https://github.com/MertDalbudak/rapidd/wiki/Deployment-&-Production)** — Docker Compose, nginx reverse proxy, production checklist, horizontal scaling

---

## Packages

| Package | Description |
|---------|-------------|
| [`@rapidd/core`](https://www.npmjs.com/package/@rapidd/core) | Project template + unified `npx rapidd` CLI — scaffolds the framework **source** into your project |
| [`@rapidd/build`](https://www.npmjs.com/package/@rapidd/build) | Code generation — models, routes, and ACL from your Prisma schema |

```bash
npx @rapidd/core create-project   # scaffold a new project
npx rapidd build                   # generate from schema (after npm install)
```

> **You own the code.** `create-project` copies the entire framework — ORM, plugins,
> auth, utilities — into your repository. `@rapidd/core` is **not** a runtime dependency
> (only `@rapidd/build` remains, as a devDependency, to regenerate models and routes from
> your schema). This is the strongest form of "you own it": every file is yours to read and
> edit. The trade-off is that framework fixes don't arrive via `npm update` — see
> [How updates work](https://github.com/MertDalbudak/rapidd/wiki/Getting-Started#architecture--updates).

---

## Documentation

Full documentation: **[github.com/MertDalbudak/rapidd/wiki](https://github.com/MertDalbudak/rapidd/wiki)**

[Getting Started](https://github.com/MertDalbudak/rapidd/wiki/Getting-Started) · [Setup Wizard](https://github.com/MertDalbudak/rapidd/wiki/Setup) · [Configuration](https://github.com/MertDalbudak/rapidd/wiki/Configuration) · [Query API](https://github.com/MertDalbudak/rapidd/wiki/Query-API) · [Authentication](https://github.com/MertDalbudak/rapidd/wiki/Authentication) · [Access Control](https://github.com/MertDalbudak/rapidd/wiki/Access-Control-(ACL)) · [Model Middleware](https://github.com/MertDalbudak/rapidd/wiki/Model-Middleware) · [Row-Level Security](https://github.com/MertDalbudak/rapidd/wiki/Row%E2%80%90Level-Security-(RLS)) · [ApiClient](https://github.com/MertDalbudak/rapidd/wiki/ApiClient) · [File Uploads](https://github.com/MertDalbudak/rapidd/wiki/File-Uploads) · [Rate Limiting](https://github.com/MertDalbudak/rapidd/wiki/Rate-Limiting) · [i18n](https://github.com/MertDalbudak/rapidd/wiki/Internationalization-(i18n)) · [Deployment](https://github.com/MertDalbudak/rapidd/wiki/Deployment-&-Production)

---

## Contributing

Issues and pull requests are welcome. If you find a bug or have a feature request, [open an issue](https://github.com/MertDalbudak/rapidd/issues).

## License

[ISC](LICENSE)

Built by [Mert Dalbudak](https://github.com/MertDalbudak)
