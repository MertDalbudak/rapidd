<img width="64" height="64" alt="logo" src="https://github.com/user-attachments/assets/706dd13b-212c-4076-b4d7-94dec4001a06" />

# Rapidd

**Rapidd** is a TypeScript/Fastify framework for rapid development of RESTful APIs with built-in ORM, authentication, authorization, and more. It generates models, routes, and access control rules from your Prisma schema so you can focus on business logic instead of boilerplate.

## Features

- **Schema-Driven API Generation** - Auto-generate REST endpoints from Prisma schema
- **TypeScript First** - Full type safety across models, routes, and middleware
- **Fastify 5** - High-performance HTTP server with plugin architecture
- **Multi-Database Support** - PostgreSQL and MySQL/MariaDB via Prisma adapters
- **Row-Level Security (RLS)** - Database-enforced security via session variables
- **Access Control Layer (ACL)** - Fine-grained model-level permissions with relation filtering
- **Advanced Query Building** - Filtering, sorting, pagination, and relation loading
- **Model Middleware** - Before/after hooks for all CRUD operations
- **JWT Authentication** - Built-in auth with access/refresh token rotation
- **Rate Limiting** - Redis-backed with memory fallback
- **Internationalization** - Multi-language support (10 languages included)
- **Security Headers** - Strict CSP, HSTS, Permissions-Policy out of the box

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Core Concepts](#core-concepts)
  - [Model Class](#model-class)
  - [QueryBuilder](#querybuilder)
  - [Access Control (ACL)](#access-control-acl)
  - [Row-Level Security (RLS)](#row-level-security-rls)
  - [Model Middleware](#model-middleware)
- [Query API](#query-api)
  - [Filtering](#filtering)
  - [Relations](#relations)
  - [Sorting](#sorting)
  - [Pagination](#pagination)
- [Authentication](#authentication)
- [API Reference](#api-reference)
- [Docker](#docker)
- [Examples](#examples)

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create `.env` file (see `.env.example`):

```env
# Database
DATABASE_URL="postgresql://user:pass@localhost:5432/db"
DATABASE_URL_ADMIN="postgresql://admin:pass@localhost:5432/db"

# JWT
JWT_SECRET="your-secret-key"
JWT_REFRESH_SECRET="your-refresh-secret"

# Server
PORT=3000
NODE_ENV=development

# Optional
ALLOWED_ORIGINS="localhost,example.com"
COOKIE_SECRET="cookie-secret"
```

### 3. Set Up Your Database

Pull your existing database schema or create a new one:

```bash
npx prisma db pull
# or
npx prisma migrate dev
```

### 4. Generate Models, Routes & ACL

```bash
npx rapidd build
```

### 5. Build & Start

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

Your API is now live at `http://localhost:3000`!

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | - | Main database connection string |
| `DATABASE_URL_ADMIN` | No | DATABASE_URL | Admin connection (bypasses RLS) |
| `DATABASE_PROVIDER` | No | auto-detect | `postgresql` or `mysql` |
| `JWT_SECRET` | Yes | - | Secret for access tokens |
| `JWT_REFRESH_SECRET` | Yes | - | Secret for refresh tokens |
| `PORT` | No | 3000 | Server port |
| `HOST` | No | 0.0.0.0 | Server bind address |
| `NODE_ENV` | No | development | `development` or `production` |
| `ALLOWED_ORIGINS` | No | * | Comma-separated allowed CORS origins |
| `COOKIE_SECRET` | No | - | Secret for signed cookies |
| `AUTH_SALT_ROUNDS` | No | 10 | bcrypt salt rounds |
| `AUTH_SESSION_STORAGE` | No | redis | Session store (`redis` or `memory`) |
| `AUTH_SESSION_TTL` | No | 86400 | Session TTL in seconds |
| `AUTH_ACCESS_TOKEN_EXPIRY` | No | 1d | JWT access token expiry |
| `AUTH_REFRESH_TOKEN_EXPIRY` | No | 7d | JWT refresh token expiry |
| `DB_USER_TABLE` | No | users | Prisma user model name |
| `API_RESULT_LIMIT` | No | 500 | Max results per query |
| `RATE_LIMIT_WINDOW_MS` | No | 900000 | Rate limit window in ms |
| `RATE_LIMIT_MAX_REQUESTS` | No | 100 | Max requests per window |
| `REDIS_HOST` | No | localhost | Redis host |
| `REDIS_PORT` | No | 6379 | Redis port |
| `REDIS_PASSWORD` | No | - | Redis password |
| `REDIS_DB_RATE_LIMIT` | No | 0 | Redis DB for rate limiting |
| `REDIS_DB_AUTH` | No | 1 | Redis DB for auth sessions |
| `RLS_NAMESPACE` | No | app | RLS variable namespace |
| `RLS_USER_ID` | No | current_user_id | RLS user ID variable name |
| `RLS_USER_ROLE` | No | current_user_role | RLS user role variable name |

### Config Files

- `config/app.json` - Application settings (languages, etc.)
- `config/rate-limit.json` - Rate limiting configuration

---

## Core Concepts

### Model Class

The `Model` class provides a high-level ORM interface with built-in ACL integration.

```typescript
import { Model } from './src/orm/Model';
import { QueryBuilder, prisma } from './src/orm/QueryBuilder';
import type { ModelOptions, GetManyResult } from './src/types';

export class Users extends Model {
    constructor(options?: ModelOptions) {
        super('users', options);
    }

    // Add custom methods
    async findByEmail(email: string) {
        const result = await this.getMany({ email });
        return result.data[0];
    }

    static override QueryBuilder = new QueryBuilder('users');
}

// Usage
const users = new Users({ user: request.user });
const result = await users.getMany({}, 'posts', 10, 0);
```

#### Model Methods

| Method | Description |
|--------|-------------|
| `getMany(filter, include, limit, offset, sortBy, sortOrder)` | Fetch multiple records |
| `get(id, include)` | Fetch single record by ID |
| `create(data)` | Create new record |
| `update(id, data)` | Update existing record |
| `upsert(data, uniqueKey)` | Create or update record |
| `upsertMany(data, uniqueKey)` | Batch create or update records |
| `delete(id)` | Delete record |
| `count(filter)` | Count matching records |

#### Batch Operations

The `upsertMany` method allows efficient batch create/update operations within a single transaction:

```typescript
const contacts = new Contacts({ user: request.user });

const result = await contacts.upsertMany([
    { contact_id: '1', first_name: 'John', email: 'john@example.com' },
    { contact_id: '2', first_name: 'Jane', email: 'jane@example.com' },
    { contact_id: '3', first_name: 'Bob', email: 'bob@example.com' }
], 'contact_id');

// Returns: { created: 2, updated: 1, total: 3 }
```

### QueryBuilder

The `QueryBuilder` class handles query parsing and Prisma query generation.

```typescript
import { QueryBuilder } from './src/orm/QueryBuilder';

const qb = new QueryBuilder('users');

// Build filter from query string
const where = qb.filter('name=%John%,age=gt:18');

// Build include for relations
const include = qb.include('posts.comments', user);

// Build sort
const orderBy = qb.sort('createdAt', 'desc');
```

### Access Control (ACL)

ACL provides model-level permission control. Rules are defined in `src/config/acl.ts` and enforced automatically on all CRUD operations and relation includes.

```typescript
// src/config/acl.ts
import type { AclConfig, RapiddUser } from '../types';

const acl: AclConfig = {
    model: {
        posts: {
            // Who can create?
            canCreate(user: RapiddUser): boolean {
                return ['ADMIN', 'AUTHOR'].includes(user.role);
            },

            // Filter for read access
            getAccessFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};  // Full access
                return {
                    OR: [
                        { authorId: user.id },
                        { published: true }
                    ]
                };
            },

            // Filter for update access
            getUpdateFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { authorId: user.id }; // Only own posts
            },

            // Filter for delete access
            getDeleteFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return false; // Others can't delete
            },

            // Fields to hide based on role
            getOmitFields(user: RapiddUser): string[] {
                if (user.role !== 'ADMIN') {
                    return ['internalNotes', 'adminComments'];
                }
                return [];
            }
        }
    }
};

export default acl;
```

#### ACL Filter Return Values

| Return Value | Meaning |
|-------------|---------|
| `{}` | Allow all (no filter applied) |
| `{ field: value }` | Scope access to matching records |
| `false` | Deny all access (returns 403) |

### Row-Level Security (RLS)

RLS enforces security at the database level using session variables.

**PostgreSQL Setup:**
```sql
-- Create policy
CREATE POLICY user_isolation ON posts
    USING (author_id = current_setting('app.current_user_id')::int);

-- Enable RLS
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
```

**MySQL Setup:**
```sql
-- Use @app_current_user_id variable in views/procedures
CREATE VIEW user_posts AS
SELECT * FROM posts WHERE author_id = @app_current_user_id;
```

**Configuration:**
```env
RLS_NAMESPACE=app
RLS_USER_ID=current_user_id
RLS_USER_ROLE=current_user_role
```

The framework automatically sets these variables on each request based on the authenticated user.

### Model Middleware

Register hooks to intercept Model operations.

```typescript
import { Model } from './src/orm/Model';

// Auto-add timestamps on create (all models)
Model.middleware.use('before', 'create', async (ctx) => {
    ctx.data.createdAt = new Date();
    ctx.data.createdBy = ctx.user?.id;
    return ctx;
});

// Auto-add timestamps on update (all models)
Model.middleware.use('before', 'update', async (ctx) => {
    ctx.data.updatedAt = new Date();
    ctx.data.updatedBy = ctx.user?.id;
    return ctx;
});

// Soft delete for specific model
Model.middleware.use('before', 'delete', async (ctx) => {
    ctx.softDelete = true;
    ctx.data = {
        deletedAt: new Date(),
        deletedBy: ctx.user?.id
    };
    return ctx;
}, 'posts'); // Only for 'posts' model

// Transform response
Model.middleware.use('after', 'get', async (ctx) => {
    if (ctx.result?.firstName && ctx.result?.lastName) {
        ctx.result.fullName = `${ctx.result.firstName} ${ctx.result.lastName}`;
    }
    return ctx;
}, 'users');
```

#### Middleware Context

| Property | Type | Description |
|----------|------|-------------|
| `model` | string | Model name |
| `operation` | string | Operation being performed |
| `user` | Object | Current user |
| `timestamp` | Date | Operation start time |
| `data` | Object | Data for create/update (mutable) |
| `id` | any | Record ID for get/update/delete |
| `query` | Object | Filter for getMany/count |
| `options` | Object | Additional Prisma options |
| `result` | any | Result (only in 'after' hooks) |
| `abort` | boolean | Set true to abort operation |
| `softDelete` | boolean | Set true to convert delete to update |

#### Available Hooks

| Hook | Operations |
|------|------------|
| `before` | `create`, `update`, `upsert`, `upsertMany`, `delete`, `get`, `getMany`, `count` |
| `after` | `create`, `update`, `upsert`, `upsertMany`, `delete`, `get`, `getMany`, `count` |

---

## Query API

### Filtering

The framework supports a powerful filtering syntax via query strings.

#### Basic Filters

```
GET /api/users?filter=name=John
GET /api/users?filter=age=25
GET /api/users?filter=active=true
```

#### Wildcard Patterns

```
GET /api/users?filter=name=%John%     # Contains "John"
GET /api/users?filter=name=John%      # Starts with "John"
GET /api/users?filter=name=%John      # Ends with "John"
```

#### Numeric Operators

| Operator | Example | Description |
|----------|---------|-------------|
| `lt:` | `age=lt:30` | Less than |
| `lte:` | `age=lte:30` | Less than or equal |
| `gt:` | `age=gt:18` | Greater than |
| `gte:` | `age=gte:18` | Greater than or equal |
| `eq:` | `age=eq:25` | Equal |
| `ne:` | `age=ne:25` | Not equal |
| `between:` | `age=between:18;30` | Between (inclusive) |

#### Date Operators

| Operator | Example | Description |
|----------|---------|-------------|
| `before:` | `createdAt=before:2024-01-01` | Before date |
| `after:` | `createdAt=after:2024-01-01` | After date |
| `from:` | `createdAt=from:2024-01-01` | From date (inclusive) |
| `to:` | `createdAt=to:2024-12-31` | To date (inclusive) |
| `on:` | `createdAt=on:2024-06-15` | On specific date |
| `between:` | `createdAt=between:2024-01-01;2024-12-31` | Between dates |

#### Array Filters

```
GET /api/users?filter=status=[active,pending]     # IN array
GET /api/users?filter=status=not:[banned,deleted] # NOT IN array
```

#### NULL Handling

```
GET /api/users?filter=deletedAt=#NULL      # IS NULL
GET /api/users?filter=deletedAt=not:#NULL  # IS NOT NULL
```

#### Negation

```
GET /api/users?filter=status=not:banned
GET /api/users?filter=name=not:%test%
```

#### Multiple Conditions

```
GET /api/users?filter=age=gt:18,status=active,role=[admin,moderator]
```

#### Nested Relation Filters

```
GET /api/posts?filter=author.name=%John%
GET /api/orders?filter=customer.address.city=Berlin
```

### Relations

Include related data using dot notation.

```
# Single relation
GET /api/users?include=posts

# Nested relations
GET /api/users?include=posts.comments

# Multiple relations
GET /api/posts?include=author,comments.user

# All relations
GET /api/users?include=ALL
```

ACL rules are automatically enforced on included relations. If a user doesn't have access to a related model, that relation is excluded from the response.

### Sorting

```
# Ascending (default)
GET /api/users?sortBy=name&sortOrder=asc

# Descending
GET /api/users?sortBy=createdAt&sortOrder=desc

# Sort by nested field
GET /api/posts?sortBy=author.name&sortOrder=asc
```

### Pagination

```
GET /api/users?limit=10&offset=0   # First 10
GET /api/users?limit=10&offset=10  # Next 10
GET /api/users?limit=10&offset=20  # Page 3
```

**Response format:**
```json
{
    "data": [...],
    "meta": {
        "take": 10,
        "skip": 0,
        "total": 150
    }
}
```

---

## Authentication

### Built-in Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/register` | POST | Register new user |
| `/api/v1/login` | POST | Login with email/password |
| `/api/v1/logout` | POST | Logout (invalidate session) |
| `/api/v1/refresh` | POST | Refresh access token |
| `/api/v1/me` | GET | Get current user |

### Registration

```bash
POST /api/v1/register
Content-Type: application/json

{
    "email": "user@example.com",
    "password": "securePassword123"
}
```

### Login

```bash
POST /api/v1/login
Content-Type: application/json

{
    "email": "user@example.com",
    "password": "securePassword123"
}
```

**Response:**
```json
{
    "user": {
        "id": "uuid",
        "email": "user@example.com"
    },
    "accessToken": "eyJhbG...",
    "refreshToken": "eyJhbG..."
}
```

### Using Tokens

```bash
GET /api/users
Authorization: Bearer eyJhbG...
```

### Token Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_ACCESS_TOKEN_EXPIRY` | 1d | Access token lifetime |
| `AUTH_REFRESH_TOKEN_EXPIRY` | 7d | Refresh token lifetime |
| `AUTH_SESSION_TTL` | 86400 | Session TTL in seconds |
| `AUTH_SESSION_STORAGE` | redis | `redis` or `memory` |

---

## API Reference

### ErrorResponse

```typescript
import { ErrorResponse } from './src/core/errors';

// Throw standardized errors
throw new ErrorResponse(400, 'validation_error', { field: 'email' });
throw new ErrorResponse(404, 'not_found');

// Or use factory methods
throw ErrorResponse.badRequest('validation_error', { field: 'email' });
throw ErrorResponse.unauthorized('invalid_credentials');
throw ErrorResponse.forbidden('no_permission');
throw ErrorResponse.notFound('record_not_found');
throw ErrorResponse.conflict('duplicate_entry', { modelName: 'users' });
throw ErrorResponse.tooManyRequests('rate_limit_exceeded');
```

### Prisma Clients

```typescript
import { prisma, authPrisma } from './src/core/prisma';

// prisma - User context with RLS
const posts = await prisma.posts.findMany();

// authPrisma - Admin context (bypasses RLS)
const allPosts = await authPrisma.posts.findMany();
```

### Transactions

```typescript
import { prismaTransaction } from './src/core/prisma';

const [users, posts] = await prismaTransaction([
    (tx) => tx.users.findMany(),
    (tx) => tx.posts.findMany()
]);
```

### DMMF Utilities

```typescript
import dmmf from './src/core/dmmf';

// Get model definition
const model = dmmf.getModel('users');

// Get fields
const fields = dmmf.getFields('users');

// Get primary key
const pk = dmmf.getPrimaryKey('users');

// Get relations
const relations = dmmf.getRelations('users');

// Check if list relation
const isList = dmmf.isListRelation('users', 'posts');
```

---

## Docker

### Build

```bash
docker build -t rapidd .
```

### Run

```bash
docker run -p 3000:3000 --env-file .env rapidd
```

The Dockerfile uses a multi-stage build:
1. **Builder** - Installs all dependencies and compiles TypeScript
2. **Deps** - Installs production dependencies and generates Prisma client
3. **Runtime** - Minimal Alpine image with only compiled output and production deps

---

## Examples

### Custom Route with Model

```typescript
// routes/api/v1/posts.ts
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { Posts, QueryBuilder } from '../../../src/models/Posts';

const postsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', async (request, reply) => {
        if (!request.user) {
            return reply.sendError(401, 'no_valid_session');
        }
        (request as any).Posts = new Posts({ user: request.user });
    });

    // GET /api/v1/posts
    fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { q = {}, include = '', limit = '25', offset = '0', sortBy = 'createdAt', sortOrder = 'desc' } = request.query as Record<string, string>;
            const model = (request as any).Posts as Posts;
            const results = await model.getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder as 'asc' | 'desc');
            return reply.sendList(results.data, results.meta);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error);
            return reply.code(response.status_code).send(response);
        }
    });

    // POST /api/v1/posts
    fastify.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
        const payload = request.body as Record<string, unknown>;
        try {
            const model = (request as any).Posts as Posts;
            const response = await model.create({
                ...payload,
                authorId: request.user!.id
            });
            return reply.code(201).send(response);
        } catch (error: any) {
            const response = QueryBuilder.errorHandler(error, payload);
            return reply.code(response.status_code).send(response);
        }
    });
};

export default postsRoutes;
```

### Custom ACL Rules

```typescript
// src/config/acl.ts
const acl: AclConfig = {
    model: {
        posts: {
            canCreate(user: RapiddUser): boolean {
                return user.role !== 'GUEST';
            },

            getAccessFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                // Users see published posts + their own drafts
                return {
                    OR: [
                        { published: true },
                        { authorId: user.id }
                    ]
                };
            },

            getUpdateFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return { authorId: user.id };
            },

            getDeleteFilter(user: RapiddUser) {
                if (user.role === 'ADMIN') return {};
                return false;
            },

            getOmitFields(user: RapiddUser): string[] {
                if (user.role !== 'ADMIN') {
                    return ['adminNotes', 'internalMetrics'];
                }
                return [];
            }
        }
    }
};
```

### Model Middleware for Audit Log

```typescript
// middleware/model.ts
import { Model } from '../src/orm/Model';
import { prisma } from '../src/core/prisma';

// Log all mutations to audit_logs table
(['create', 'update', 'delete'] as const).forEach(operation => {
    Model.middleware.use('after', operation, async (ctx) => {
        await prisma.audit_logs.create({
            data: {
                model: ctx.model,
                operation: ctx.operation,
                recordId: String(ctx.result?.id || ctx.id),
                userId: ctx.user?.id,
                changes: JSON.stringify(ctx.data || {}),
                timestamp: new Date()
            }
        });
        return ctx;
    });
});
```

---

## Project Structure

```
rapidd/
├── src/
│   ├── app.ts                 # Fastify app factory + route loader
│   ├── index.ts               # Framework barrel exports
│   ├── types.ts               # Shared TypeScript types
│   ├── auth/                  # Authentication system
│   │   ├── Auth.ts            # Auth class (login, register, etc.)
│   │   └── stores/            # Session stores (Redis, memory)
│   ├── config/
│   │   └── acl.ts             # Access control rules (generated)
│   ├── core/
│   │   ├── prisma.ts          # Prisma clients, RLS, transactions
│   │   ├── dmmf.ts            # Schema introspection (DMMF)
│   │   ├── env.ts             # Environment validation & typed access
│   │   ├── errors.ts          # ErrorResponse, Response classes
│   │   ├── i18n.ts            # Language dictionary (LanguageDict)
│   │   └── middleware.ts      # Model middleware registry
│   ├── models/                # Generated model subclasses
│   ├── orm/
│   │   ├── Model.ts           # Base ORM model class
│   │   └── QueryBuilder.ts    # REST→Prisma query translation
│   ├── plugins/               # Fastify plugins
│   │   ├── auth.ts            # Auth middleware + routes
│   │   ├── language.ts        # Accept-Language resolution
│   │   ├── rateLimit.ts       # Rate limiting (Redis + memory)
│   │   ├── response.ts        # Reply decorators + error handler
│   │   ├── rls.ts             # Row-Level Security context
│   │   ├── security.ts        # Security headers (CSP, HSTS)
│   │   └── upload.ts          # Multipart file upload
│   └── utils/
│       ├── ApiClient.ts       # Config-driven HTTP client
│       └── Mailer.ts          # SMTP email client
├── routes/
│   └── api/
│       └── v1/                # API v1 routes (auto-loaded)
├── config/
│   ├── app.json               # App config (languages, services, etc.)
│   └── rate-limit.json        # Per-path rate limit rules
├── locale/                    # i18n translation files (10 languages)
├── prisma/
│   ├── schema.prisma          # Database schema
│   └── client/                # Generated Prisma client
├── public/static/             # Static assets (favicon, logo)
├── main.ts                    # Application entry point
├── tsconfig.json              # TypeScript config
├── dockerfile                 # Multi-stage Docker build
└── package.json
```

---

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `npm run dev` | Development server with hot reload (tsx) |
| `build` | `npm run build` | Compile TypeScript to `dist/` |
| `start` | `npm start` | Run compiled production server |
| `test` | `npm test` | Run test suite (Jest) |
| `typecheck` | `npm run typecheck` | Type-check without emitting |

---

## Database Support

### PostgreSQL

```env
DATABASE_URL="postgresql://user:pass@localhost:5432/db"
```

Uses `@prisma/adapter-pg` with native `pg` driver.

### MySQL / MariaDB

```env
DATABASE_URL="mysql://user:pass@localhost:3306/db"
```

Uses `@prisma/adapter-mariadb`.

### Provider Detection

The framework auto-detects the provider from the connection string:
- URLs starting with `postgresql://` or `postgres://` → PostgreSQL
- URLs starting with `mysql://` or `mariadb://` → MySQL

Override with `DATABASE_PROVIDER` environment variable if needed.

---

## Security

### Built-in Security Features

- **Rate Limiting** - Configurable per-endpoint limits (Redis or in-memory)
- **Security Headers** - Strict CSP, HSTS, Permissions-Policy
- **Password Hashing** - bcrypt with configurable rounds
- **JWT Authentication** - Signed tokens with expiration and refresh rotation
- **RLS** - Database-level row security
- **ACL** - Application-level access control with relation filtering
- **Input Sanitization** - SQL injection prevention via Prisma

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure strong `JWT_SECRET` and `JWT_REFRESH_SECRET`
- [ ] Set up Redis for rate limiting and sessions
- [ ] Configure `ALLOWED_ORIGINS` for CORS
- [ ] Enable HTTPS (reverse proxy or load balancer)
- [ ] Set up RLS policies in database
- [ ] Review and customize ACL rules in `src/config/acl.ts`

---

## License

ISC

---

Built with ❤️ by [Mert Dalbudak](https://github.com/MertDalbudak)
