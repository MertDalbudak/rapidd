<img width="64" height="64" alt="logo" src="https://github.com/user-attachments/assets/706dd13b-212c-4076-b4d7-94dec4001a06" />

# Rapidd

Code-first REST API framework for TypeScript. Database in, API out.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![Prisma](https://img.shields.io/badge/Prisma-7.x-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![CI](https://github.com/MertDalbudak/rapidd/actions/workflows/ci.yml/badge.svg)](https://github.com/MertDalbudak/rapidd/actions/workflows/ci.yml)

---

## Why Rapidd

Rapidd is a backend framework that generates a fully-featured REST API from your existing database schema — then gets out of your way. It's not a scaffolding tool that dumps code you'll rewrite. It's not a hosted service sitting between you and your data. It's a framework that handles CRUD, auth, access control, and a dozen other production concerns, while giving you full TypeScript control over every behavior.

- **Zero to API in 3 commands** — point it at a database and get REST endpoints with filtering, pagination, relations, and field selection
- **You own the code** — full TypeScript codebase you control, extend, and deploy anywhere
- **Convention over configuration** — auto-detects auth tables, password fields, DB provider, and RLS support. Every default overridable
- **Production-grade from day one** — security headers, JWT with refresh rotation, row-level security, per-model ACL, rate limiting, i18n error messages
- **Batteries included** — built-in HTTP client, SMTP mailer with templates, file uploads with MIME validation, rate limiting, i18n across 10 languages
- **Extensible** — before/after middleware hooks on every CRUD operation, custom routes alongside generated ones, model-level overrides

---

## Quick Start

```bash
npm install @rapidd/core @rapidd/build
```

```env
DATABASE_URL="postgresql://user:pass@localhost:5432/mydb"
```

```bash
npx prisma db pull        # introspect existing database
npx rapidd build          # generate models, routes & ACL scaffold
npm run dev               # http://localhost:3000
```

Every table gets full CRUD endpoints. Auth is enabled automatically when a user table is detected.

> **[Getting Started guide](https://github.com/MertDalbudak/rapidd/wiki/Getting-Started)** — full walkthrough with project structure

---

## Features

| Feature | PostgreSQL | MySQL/MariaDB |
|---------|:----------:|:-------------:|
| CRUD API generation | Yes | Yes |
| Query filtering (20+ operators) | Yes | Yes |
| Relations & deep includes | Yes | Yes |
| Field selection | Yes | Yes |
| JWT authentication | Yes | Yes |
| Multi-strategy auth (bearer, basic, cookie, header) | Yes | Yes |
| Per-model ACL | Yes | Yes |
| Row-Level Security (database-enforced) | Yes | — |
| Rate limiting (Redis + memory fallback) | Yes | Yes |
| File uploads with MIME validation | Yes | Yes |
| SMTP mailer with EJS templates | Yes | Yes |
| Config-driven HTTP client (ApiClient) | Yes | Yes |
| i18n (10 languages) | Yes | Yes |
| Security headers (HSTS, CSP, etc.) | Yes | Yes |

> **MySQL users:** ACL provides application-level access control for all databases. RLS adds database-enforced row filtering as a second layer — this is PostgreSQL-only because MySQL lacks native RLS support. For MySQL, ACL is your primary access control mechanism and covers most use cases. See the **[Access Control wiki](https://github.com/MertDalbudak/rapidd/wiki/Access-Control-(ACL))** for details.

---

## What Gets Auto-Detected

| Feature | How |
|---------|-----|
| Database provider | From connection URL (`postgresql://` or `mysql://`) |
| Auth system | Enabled when a `user`/`users`/`account`/`accounts` table exists |
| Login fields | Unique string fields on the user model (`email`, `username`, etc.) |
| Password field | Fields named `password`, `hash`, `passwordHash`, `hashed_password`, etc. |
| Row-level security | On for PostgreSQL, off for MySQL (override with `RLS_ENABLED`) |
| Session store | Redis when available, automatic memory fallback for development |

Every value is overridable via env vars. See [`.env.example`](.env.example) for the full list.

---

## Query API

All generated endpoints support filtering, relations, field selection, sorting, and pagination.

```
GET /api/v1/posts?filter=status=active,title=%typescript%
GET /api/v1/posts?filter=createdAt=after:2025-01-01,views=gte:100
GET /api/v1/posts?filter=category=[tech,science],author.role=admin
```

**String:** `%text%` (contains), `%text` (ends with), `text%` (starts with), exact match
**Numeric:** `gt:`, `lt:`, `gte:`, `lte:`, `eq:`, `ne:`, `between:min;max`
**Date:** `before:`, `after:`, `from:`, `to:`, `on:`, `between:date1;date2`
**Special:** `not:value`, `[array]`, `#NULL`, `not:#NULL`, nested relation fields (`author.name=%John%`)

### Relations & Field Selection

```
GET /api/v1/posts?include=author,comments.user           # deep nested
GET /api/v1/posts?include=ALL                              # all relations
GET /api/v1/posts?fields=id,title,author.name,author.email # select specific fields
```

### Sorting & Pagination

```
GET /api/v1/posts?sortBy=createdAt&sortOrder=desc&limit=10&offset=20
```

### Response Format

```json
{
    "data": [...],
    "meta": { "total": 150, "count": 10, "limit": 10, "offset": 20, "hasMore": true }
}
```

> **[Query API wiki](https://github.com/MertDalbudak/rapidd/wiki/Query-API)** — all 20+ filter operators, composite PKs, relation filtering

---

## Authentication

Auto-enabled when a user table is detected. No configuration needed for development.

```
POST /auth/login          { "user": "john@example.com", "password": "..." }
POST /auth/logout         Authorization: Bearer <token>
POST /auth/refresh        { "refreshToken": "..." }
GET  /auth/me             Authorization: Bearer <token>
```

Four strategies: **bearer** (default), **basic**, **cookie**, and **custom header**. Enable multiple at once:

```env
AUTH_STRATEGIES=bearer,cookie
```

Multi-identifier login is supported — users can authenticate with any unique field (email, username, phone) in a single endpoint.

**Production requirement:** `JWT_SECRET` and `JWT_REFRESH_SECRET` must be set explicitly. The server will refuse to start without them in production to prevent session invalidation on restart.

```bash
# Generate secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **[Authentication wiki](https://github.com/MertDalbudak/rapidd/wiki/Authentication)** — session stores, route protection, per-endpoint strategy overrides

---

## Access Control

Define per-model rules in `src/config/acl.ts`. Enforced on every CRUD operation, relation include, and field selection.

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

Return `{}` for full access, a filter object to scope records, or `false` to deny. Omitted fields are automatically excluded from all responses — even when explicitly requested via `fields=`.

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

// Soft deletes
Model.middleware.use('before', 'delete', async (ctx) => {
    ctx.softDelete = true;
    ctx.data = { deletedAt: new Date(), deletedBy: ctx.user?.id };
    return ctx;
}, 'posts');

// Audit logging
Model.middleware.use('after', 'update', async (ctx) => {
    await auditLog.write(ctx.model.name, ctx.id, ctx.user, ctx.data);
    return ctx;
});
```

Supports `create`, `update`, `upsert`, `upsertMany`, `delete`, `get`, `getMany`, and `count`. Middleware can abort operations, modify data, override field selections, and short-circuit with cached results.

> **[Model Middleware wiki](https://github.com/MertDalbudak/rapidd/wiki/Model-Middleware)** — all hooks, context object, patterns (soft delete, validation, caching)

---

## Row-Level Security

Auto-enabled for PostgreSQL. Every query runs inside a transaction with the authenticated user's context injected as session variables.

```sql
CREATE POLICY user_isolation ON posts
    USING (author_id = current_setting('app.current_user_id')::int);
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
```

RLS provides database-enforced access control that can't be bypassed by application bugs. It works alongside ACL — use ACL for application-level rules, RLS for database-level guarantees.

> **[Row-Level Security wiki](https://github.com/MertDalbudak/rapidd/wiki/Row%E2%80%90Level-Security-(RLS))** — policy examples, RLS vs ACL comparison, transaction support

---

## Built-in Utilities

### ApiClient

Config-driven HTTP client for service-to-service communication. Supports Bearer, Basic, API Key, and OAuth2 with automatic token caching and refresh.

```typescript
// Config-based (defined in config/app.json)
const user = await ApiClient.call('MyAPI', 'getUser', { id: '123' });

// Fluent builder
const data = await ApiClient.to('https://api.example.com')
    .bearer(token)
    .retry(3)
    .get('/users/123');
```

> **[ApiClient wiki](https://github.com/MertDalbudak/rapidd/wiki/ApiClient)**

### Mailer

SMTP email with EJS template rendering, layout wrappers, i18n support, batch sending, and attachments.

```typescript
await Mailer.send('default', {
    to: 'user@example.com',
    subject: 'Welcome!',
    template: 'welcome',
    data: { name: 'John' },
    language: 'en_US'
});
```

> **[Mailer wiki](https://github.com/MertDalbudak/rapidd/wiki/Mailer)**

### File Uploads

Multipart uploads with MIME validation, size limits, and type presets.

```typescript
fastify.post('/avatar', async (request) => {
    const file = await request.handleUpload({ type: 'images', maxFileSize: 5 * 1024 * 1024 });
    await file.saveTo('./uploads/avatars');
});
```

> **[File Uploads wiki](https://github.com/MertDalbudak/rapidd/wiki/File-Uploads)**

### Rate Limiting

Redis-backed with automatic memory fallback. Per-path configuration via `config/rate-limit.json`.

```json
{ "/auth/login": { "max": 5, "window": 60000 } }
```

> **[Rate Limiting wiki](https://github.com/MertDalbudak/rapidd/wiki/Rate-Limiting)**

### Internationalization

10 languages included. Auto-detected from `Accept-Language` header. Parameter interpolation in error messages.

```json
{ "validation.minLength": "{{field}} must be at least {{min}} characters" }
```

> **[Internationalization wiki](https://github.com/MertDalbudak/rapidd/wiki/Internationalization-(i18n))**

---

## Production

```env
NODE_ENV=production
JWT_SECRET=your-secret-here          # Required — server won't start without it
JWT_REFRESH_SECRET=your-refresh-secret
ALLOWED_ORIGINS=yourdomain.com
TRUST_PROXY=true
```

```bash
npm run build && npm start
```

### Docker

```bash
docker build -t rapidd . && docker run -p 3000:3000 --env-file .env rapidd
```

Multi-stage build with non-root user, Alpine base, and pre-compiled Prisma client.

### Security Defaults

All responses include security headers:
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'`
- `Strict-Transport-Security` (production only)
- `Referrer-Policy: strict-origin-when-cross-origin`
- CORS with origin whitelisting in production

> **[Deployment wiki](https://github.com/MertDalbudak/rapidd/wiki/Deployment-&-Production)** — Docker Compose, nginx reverse proxy, production checklist, horizontal scaling

---

## Documentation

Full documentation is available in the **[Wiki](https://github.com/MertDalbudak/rapidd/wiki)**:

| Page | Description |
|------|-------------|
| [Getting Started](https://github.com/MertDalbudak/rapidd/wiki/Getting-Started) | Installation, setup, project structure |
| [Configuration](https://github.com/MertDalbudak/rapidd/wiki/Configuration) | Environment variables, app.json, paths |
| [Query API](https://github.com/MertDalbudak/rapidd/wiki/Query-API) | Filtering, sorting, pagination, field selection |
| [Authentication](https://github.com/MertDalbudak/rapidd/wiki/Authentication) | JWT, strategies, sessions, route protection |
| [Access Control](https://github.com/MertDalbudak/rapidd/wiki/Access-Control-(ACL)) | Per-model ACL rules, field omission |
| [Model Middleware](https://github.com/MertDalbudak/rapidd/wiki/Model-Middleware) | Before/after CRUD hooks and patterns |
| [Row-Level Security](https://github.com/MertDalbudak/rapidd/wiki/Row%E2%80%90Level-Security-(RLS)) | PostgreSQL RLS with policy examples |
| [ApiClient](https://github.com/MertDalbudak/rapidd/wiki/ApiClient) | HTTP client with auth, retries, fluent API |
| [Mailer](https://github.com/MertDalbudak/rapidd/wiki/Mailer) | SMTP email with templates and layouts |
| [File Uploads](https://github.com/MertDalbudak/rapidd/wiki/File-Uploads) | Multipart uploads with validation |
| [Rate Limiting](https://github.com/MertDalbudak/rapidd/wiki/Rate-Limiting) | Redis + memory, per-path configuration |
| [Internationalization](https://github.com/MertDalbudak/rapidd/wiki/Internationalization-(i18n)) | Multi-language support with interpolation |
| [Deployment](https://github.com/MertDalbudak/rapidd/wiki/Deployment-&-Production) | Docker, nginx, production checklist |

---

## Configuration

See [`.env.example`](.env.example) for every available environment variable with descriptions and defaults.

> **[Configuration wiki](https://github.com/MertDalbudak/rapidd/wiki/Configuration)** — all settings, app.json structure, TypeScript config

---

## License

[ISC](LICENSE)

Built by [Mert Dalbudak](https://github.com/MertDalbudak)
