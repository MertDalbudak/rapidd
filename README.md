<img width="64" height="64" alt="logo" src="https://github.com/user-attachments/assets/706dd13b-212c-4076-b4d7-94dec4001a06" />

# Rapidd

A zero-config TypeScript framework that turns your Prisma schema into a full REST API. Provide a database URL and you're done.

## Quick Start

```bash
npm install
```

```env
DATABASE_URL="postgresql://user:pass@localhost:5432/db"
```

```bash
npx prisma db pull        # pull existing schema (or prisma migrate dev)
npx rapidd build          # generate models, routes & ACL
npm run dev               # http://localhost:3000
```

That's it. Auth, security headers, rate limiting, RLS - all auto-configured.

## What Gets Auto-Detected

| Feature | How |
|---------|-----|
| Database provider | From URL prefix (`postgresql://` or `mysql://`) |
| Auth | Enabled when a `user`/`users`/`account`/`accounts` table exists |
| Login fields | Unique string fields on the user model (e.g. `email`, `username`) |
| Password field | Fields named `password`, `hash`, `passwordHash`, etc. |
| JWT secrets | Auto-generated at startup (set `JWT_SECRET` for persistence) |
| RLS | On for PostgreSQL, off for MySQL |
| Session store | Redis with automatic memory fallback |

Every value is overridable via env vars. See [`.env.example`](.env.example) for the full list.

## Query API

All generated endpoints support filtering, relations, sorting, and pagination out of the box.

```
GET /api/v1/posts?filter=status=active,author.name=%John%
GET /api/v1/posts?include=author,comments.user
GET /api/v1/posts?sortBy=createdAt&sortOrder=desc
GET /api/v1/posts?limit=10&offset=20
```

**Operators:** `gt:`, `lt:`, `gte:`, `lte:`, `between:`, `before:`, `after:`, `not:`, `[array]`, `#NULL`

**Response:**
```json
{
    "data": [...],
    "meta": { "total": 150, "count": 10, "limit": 10, "offset": 20, "hasMore": true }
}
```

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

## Access Control

Define per-model rules in `src/config/acl.ts`. Enforced on all CRUD operations and relation includes.

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

Return `{}` for full access, a filter object to scope, or `false` to deny.

## Model Middleware

Hook into any CRUD operation before or after execution.

```typescript
Model.middleware.use('before', 'create', async (ctx) => {
    ctx.data.createdAt = new Date();
    ctx.data.createdBy = ctx.user?.id;
    return ctx;
});

Model.middleware.use('before', 'delete', async (ctx) => {
    ctx.softDelete = true;
    ctx.data = { deletedAt: new Date() };
    return ctx;
}, 'posts'); // scope to specific model
```

## Row-Level Security

Auto-enabled for PostgreSQL. Every query runs inside a transaction with the authenticated user's context.

```sql
CREATE POLICY user_isolation ON posts
    USING (author_id = current_setting('app.current_user_id')::int);
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
```

Override with `RLS_ENABLED=false` to disable, or configure the variable names:

```env
RLS_NAMESPACE=app
RLS_USER_ID=current_user_id
RLS_USER_ROLE=current_user_role
```

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

```bash
# or Docker
docker build -t rapidd . && docker run -p 3000:3000 --env-file .env rapidd
```

---

## License

ISC

Built by [Mert Dalbudak](https://github.com/MertDalbudak)
