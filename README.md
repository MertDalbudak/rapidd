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

**Zero to API in 3 commands.** Point it at a database and get a complete REST API with authentication, access control, security headers, rate limiting, and localized error messages. No boilerplate.

**You own the code.** This isn't a hosted service or a black-box proxy sitting in front of your database. It's a full TypeScript codebase you control, extend, and deploy anywhere — your server, your Docker container, your cloud.

**Convention over configuration.** Rapidd auto-detects your auth tables, password fields, database provider, and RLS support from your Prisma schema. Every default is overridable via environment variables or code.

**Production-grade from day one.** Security headers, JWT with refresh token rotation, row-level security, per-model ACL, rate limiting with Redis, i18n error responses across 10 languages — all built-in, not bolted on.

**Extensible, not locked-in.** Before/after middleware hooks on every CRUD operation. Custom Fastify routes alongside generated ones. Model-level overrides for business logic. It's a framework, not a cage.

---

## Quick Start

```bash
npm install @rapidd/core @rapidd/build
```

```env
DATABASE_URL="postgresql://user:pass@localhost:5432/mydb"
```

```bash
npx prisma db pull        # introspect existing database (or prisma migrate dev)
npx rapidd build          # generate models, routes & ACL scaffold
npm run dev               # http://localhost:3000
```

That's it. Every table gets full CRUD endpoints. Auth is enabled automatically when a user table is detected.

---

## What Gets Auto-Detected

| Feature | How |
|---------|-----|
| Database provider | From connection URL (`postgresql://` or `mysql://`) |
| Auth system | Enabled when a `user`/`users`/`account`/`accounts` table exists |
| Login fields | Unique string fields on the user model (`email`, `username`, etc.) |
| Password field | Fields named `password`, `hash`, `passwordHash`, `hashed_password`, etc. |
| JWT secrets | Auto-generated at startup (set `JWT_SECRET` for persistence across restarts) |
| Row-level security | On for PostgreSQL, off for MySQL (override with `RLS_ENABLED`) |
| Session store | Redis when available, automatic memory fallback for development |

Every value is overridable via env vars. See [`.env.example`](.env.example) for the full list.

---

## Query API

All generated endpoints support filtering, relations, field selection, sorting, and pagination out of the box.

### Filtering

```
GET /api/v1/posts?filter=status=active,title=%typescript%
GET /api/v1/posts?filter=createdAt=after:2025-01-01,views=gte:100
GET /api/v1/posts?filter=category=[tech,science],author.role=admin
```

**String operators:** `%text%` (contains), `%text` (ends with), `text%` (starts with), exact match

**Numeric operators:** `gt:`, `lt:`, `gte:`, `lte:`, `eq:`, `ne:`, `between:min;max`

**Date operators:** `before:`, `after:`, `from:`, `to:`, `on:`, `between:date1;date2`

**Special:** `not:value`, `[array]`, `#NULL`, `not:#NULL`, nested relation fields (`author.name=%John%`)

### Relations

```
GET /api/v1/posts?include=author
GET /api/v1/posts?include=author,comments.user    # deep nested
GET /api/v1/posts?include=ALL                      # all relations
```

### Field Selection

Select specific fields to reduce payload size. Use dot notation for relation fields.

```
GET /api/v1/posts?fields=id,title,createdAt
GET /api/v1/posts?include=author&fields=id,title,author.name,author.email
GET /api/v1/posts?include=author,comments&fields=id,title,author.name,comments.text
```

Relations referenced in `fields` must be present in the `include` parameter. If not, the API returns a `400` error with a hint.

### Sorting & Pagination

```
GET /api/v1/posts?sortBy=createdAt&sortOrder=desc
GET /api/v1/posts?limit=10&offset=20
```

### Response Format

```json
{
    "data": [...],
    "meta": { "total": 150, "count": 10, "limit": 10, "offset": 20, "hasMore": true }
}
```

---

## Authentication

Auto-enabled when a user table is detected. No configuration needed.

```
POST /auth/login          { "user": "john@example.com", "password": "..." }
POST /auth/logout         Authorization: Bearer <token>
POST /auth/refresh        { "refreshToken": "..." }
GET  /auth/me             Authorization: Bearer <token>
```

Supports multiple strategies: **bearer** (default), **basic**, **cookie**, and **custom header**.

```env
AUTH_STRATEGIES=bearer,cookie
```

Routes can override auth per-endpoint:

```typescript
fastify.get('/dashboard', {
    config: { auth: { strategies: ['cookie', 'bearer'] } }
}, handler);
```

Multi-identifier login is supported — users can authenticate with any unique field (email, username, phone) in a single endpoint.

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

Return `{}` for full access, a filter object to scope records, or `false` to deny entirely. Omitted fields are automatically excluded from responses and field selections.

---

## Model Middleware

Hook into any CRUD operation before or after execution. Supports `create`, `update`, `upsert`, `upsertMany`, `delete`, `get`, `getMany`, and `count`.

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
}, 'posts'); // scope to specific model

// Audit logging
Model.middleware.use('after', 'update', async (ctx) => {
    await auditLog.write(ctx.model.name, ctx.id, ctx.user, ctx.data);
    return ctx;
});
```

Middleware can abort operations, modify data, override field selections, and access the full request context.

---

## Row-Level Security

Auto-enabled for PostgreSQL. Every query runs inside a transaction with the authenticated user's context injected as session variables.

```sql
CREATE POLICY user_isolation ON posts
    USING (author_id = current_setting('app.current_user_id')::int);
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
```

MySQL/MariaDB uses `@` session variables for the same effect. Override with `RLS_ENABLED=false` to disable, or configure the variable names:

```env
RLS_NAMESPACE=app
RLS_USER_ID=current_user_id
RLS_USER_ROLE=current_user_role
```

---

## Built-in Utilities

Rapidd ships with utilities you'd otherwise install and wire up yourself:

- **ApiClient** — Service-to-service HTTP with retry, Bearer/Basic/API Key/OAuth2 auth, fluent builder (`ApiClient.to(url).bearer(token).get('/users')`)
- **Mailer** — SMTP email via Nodemailer with EJS template rendering, layout support, batch sending, and attachments (see `templates/email/`)
- **File Uploads** — Multipart uploads with MIME validation, size limits, and presets for `images`, `documents`, `media`
- **Rate Limiting** — Redis-backed (memory fallback), per-path config, standard `X-RateLimit-*` headers
- **i18n** — 10 languages out of the box, auto-detected from `Accept-Language` header, parameter interpolation in error messages

---

## Production

```env
NODE_ENV=production
JWT_SECRET=your-secret-here
JWT_REFRESH_SECRET=your-refresh-secret-here
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

Multi-stage build with non-root user, Alpine base, and pre-compiled Prisma client. Production image is ~150MB.

### Security Defaults

All responses include security headers out of the box:
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'`
- `Strict-Transport-Security` (production only)
- `Referrer-Policy: strict-origin-when-cross-origin`
- CORS with origin whitelisting in production

---

## Configuration

See [`.env.example`](.env.example) for every available environment variable with descriptions and defaults.

Key categories: database, auth (JWT, sessions, strategies), rate limiting, Redis, RLS, CORS, and API limits.

---

## License

[ISC](LICENSE)

Built by [Mert Dalbudak](https://github.com/MertDalbudak)
