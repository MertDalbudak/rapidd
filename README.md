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

Rapidd generates a fully-featured REST API from your database schema — then gets out of your way. It's not a scaffolder that dumps code you'll rewrite. It's not a hosted service between you and your data. It's a framework you own, extend, and deploy anywhere.

**Unlike Hasura or Supabase**, you get a full TypeScript codebase — no vendor lock-in, no managed service dependency. **Unlike PostgREST**, you get auth, ACL, middleware hooks, and utilities built in. **Unlike Strapi**, it's schema-first via Prisma, not UI-driven.

- **Zero to API in 3 commands** — CRUD endpoints with filtering, pagination, relations, and field selection
- **Convention over configuration** — auto-detects auth tables, password fields, DB provider, and RLS support. Every default overridable
- **Production-grade from day one** — security headers, JWT with refresh rotation, row-level security, per-model ACL, rate limiting
- **Batteries included** — HTTP client, SMTP mailer with templates, file uploads, rate limiting, i18n across 10 languages
- **Fully extensible** — before/after middleware on every CRUD operation, custom routes alongside generated ones

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

Every table gets full CRUD endpoints. Auth is enabled automatically when a user table is detected. Every auto-detected value — auth fields, password hashing, JWT secrets, session store — is overridable via env vars. See [`.env.example`](.env.example) for the full list.

> 📖 **[Getting Started guide →](https://github.com/MertDalbudak/rapidd/wiki/Getting-Started)** — full walkthrough with project structure

---

## Features

| Feature | PostgreSQL | MySQL/MariaDB |
|---------|:----------:|:-------------:|
| CRUD API generation | ✓ | ✓ |
| Query filtering (20+ operators) | ✓ | ✓ |
| Relations & deep includes | ✓ | ✓ |
| Field selection | ✓ | ✓ |
| JWT authentication (4 strategies) | ✓ | ✓ |
| Per-model ACL | ✓ | ✓ |
| Row-Level Security (database-enforced) | ✓ | — |
| Rate limiting (Redis + memory fallback) | ✓ | ✓ |
| File uploads with MIME validation | ✓ | ✓ |
| SMTP mailer with EJS templates | ✓ | ✓ |
| Config-driven HTTP client | ✓ | ✓ |
| i18n (10 languages) | ✓ | ✓ |
| Security headers (HSTS, CSP, etc.) | ✓ | ✓ |

> **MySQL note:** ACL provides application-level access control for all databases. RLS adds database-enforced row filtering as a second layer (PostgreSQL-only). For MySQL, ACL is your primary access control mechanism and covers most use cases. See the **[Access Control wiki](https://github.com/MertDalbudak/rapidd/wiki/Access-Control-(ACL))** for details.

---

## Query API

All generated endpoints support filtering, relations, field selection, sorting, and pagination.

```
GET /api/v1/posts?filter=status=active,title=%typescript%
GET /api/v1/posts?filter=createdAt=after:2025-01-01,views=gte:100
GET /api/v1/posts?include=author,comments.user&fields=id,title,author.name
GET /api/v1/posts?sortBy=createdAt&sortOrder=desc&limit=10&offset=20
```

20+ filter operators for strings, numbers, dates, arrays, nulls, and nested relation fields. Responses include pagination metadata with `total`, `count`, `limit`, `offset`, and `hasMore`.

> 📖 **[Query API wiki →](https://github.com/MertDalbudak/rapidd/wiki/Query-API)** — all operators, composite PKs, relation filtering

---

## Authentication

Auto-enabled when a user table is detected.

```
POST /auth/login          { "user": "john@example.com", "password": "..." }
POST /auth/logout         Authorization: Bearer <token>
POST /auth/refresh        { "refreshToken": "..." }
GET  /auth/me             Authorization: Bearer <token>
```

Four strategies — **bearer** (default), **basic**, **cookie**, and **custom header** — configurable per-route. Multi-identifier login lets users authenticate with any unique field (email, username, phone) in a single endpoint.

⚠️ **Production:** `JWT_SECRET` and `JWT_REFRESH_SECRET` must be set explicitly. The server refuses to start without them to prevent session invalidation on restart.

> 📖 **[Authentication wiki →](https://github.com/MertDalbudak/rapidd/wiki/Authentication)** — session stores, route protection, per-endpoint strategy overrides

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

Return `{}` for full access, a filter object to scope records, or `false` to deny.

> 📖 **[Access Control wiki →](https://github.com/MertDalbudak/rapidd/wiki/Access-Control-(ACL))** — all 5 ACL methods, relation ACL, 404 vs 403 distinction

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

> 📖 **[Model Middleware wiki →](https://github.com/MertDalbudak/rapidd/wiki/Model-Middleware)** — all hooks, context object, patterns (soft delete, validation, caching)

---

## Row-Level Security

Auto-enabled for PostgreSQL. Every query runs inside a transaction with the authenticated user's context injected as session variables.

```sql
CREATE POLICY user_isolation ON posts
    USING (author_id = current_setting('app.current_user_id')::int);
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
```

RLS provides database-enforced access control that can't be bypassed by application bugs. It works alongside ACL — use ACL for application-level rules, RLS for database-level guarantees.

> 📖 **[Row-Level Security wiki →](https://github.com/MertDalbudak/rapidd/wiki/Row%E2%80%90Level-Security-(RLS))** — policy examples, RLS vs ACL comparison

---

## Built-in Utilities

| Utility | Description | Docs |
|---------|-------------|------|
| **ApiClient** | Config-driven HTTP client with Bearer, Basic, API Key, and OAuth2 auth. Automatic token caching, retries, and fluent builder. | [Wiki →](https://github.com/MertDalbudak/rapidd/wiki/ApiClient) |
| **Mailer** | SMTP email with EJS template rendering, layout wrappers, i18n support, batch sending, and attachments. | [Wiki →](https://github.com/MertDalbudak/rapidd/wiki/Mailer) |
| **File Uploads** | Multipart uploads with MIME validation, size limits, and type presets (`images`, `documents`, etc.). | [Wiki →](https://github.com/MertDalbudak/rapidd/wiki/File-Uploads) |
| **Rate Limiting** | Redis-backed with automatic memory fallback. Per-path configuration via `config/rate-limit.json`. | [Wiki →](https://github.com/MertDalbudak/rapidd/wiki/Rate-Limiting) |
| **i18n** | 10 languages included. Auto-detected from `Accept-Language` header. Parameter interpolation in error messages. | [Wiki →](https://github.com/MertDalbudak/rapidd/wiki/Internationalization-(i18n)) |

---

## Production & Deployment

```env
NODE_ENV=production
JWT_SECRET=your-secret-here          # Required — server won't start without it
JWT_REFRESH_SECRET=your-refresh-secret
ALLOWED_ORIGINS=yourdomain.com
TRUST_PROXY=true
```

```bash
npm run build && npm start

# or Docker
docker build -t rapidd . && docker run -p 3000:3000 --env-file .env rapidd
```

**Security defaults in production:** HSTS, Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, and CORS with explicit origin whitelisting — all enabled automatically.

> 📖 **[Deployment wiki →](https://github.com/MertDalbudak/rapidd/wiki/Deployment-&-Production)** — Docker Compose, nginx reverse proxy, production checklist, horizontal scaling

---

## Documentation

Full documentation: **[github.com/MertDalbudak/rapidd/wiki](https://github.com/MertDalbudak/rapidd/wiki)**

[Getting Started](https://github.com/MertDalbudak/rapidd/wiki/Getting-Started) · [Configuration](https://github.com/MertDalbudak/rapidd/wiki/Configuration) · [Query API](https://github.com/MertDalbudak/rapidd/wiki/Query-API) · [Authentication](https://github.com/MertDalbudak/rapidd/wiki/Authentication) · [Access Control](https://github.com/MertDalbudak/rapidd/wiki/Access-Control-(ACL)) · [Model Middleware](https://github.com/MertDalbudak/rapidd/wiki/Model-Middleware) · [Row-Level Security](https://github.com/MertDalbudak/rapidd/wiki/Row%E2%80%90Level-Security-(RLS)) · [ApiClient](https://github.com/MertDalbudak/rapidd/wiki/ApiClient) · [Mailer](https://github.com/MertDalbudak/rapidd/wiki/Mailer) · [File Uploads](https://github.com/MertDalbudak/rapidd/wiki/File-Uploads) · [Rate Limiting](https://github.com/MertDalbudak/rapidd/wiki/Rate-Limiting) · [i18n](https://github.com/MertDalbudak/rapidd/wiki/Internationalization-(i18n)) · [Deployment](https://github.com/MertDalbudak/rapidd/wiki/Deployment-&-Production)

---

## Contributing

Issues and pull requests are welcome. If you find a bug or have a feature request, [open an issue](https://github.com/MertDalbudak/rapidd/issues).

## License

[ISC](LICENSE)

Built by [Mert Dalbudak](https://github.com/MertDalbudak)
