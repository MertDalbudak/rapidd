<img width="64" height="64" alt="logo" src="https://github.com/user-attachments/assets/706dd13b-212c-4076-b4d7-94dec4001a06" />

# Rapidd

**Rapidd** is a powerful Node.js framework that automatically generates production-ready REST APIs from your Prisma schema. It eliminates the need to manually write CRUD endpoints, route handlers, and data validation logic by intelligently building them from your database schema.

## Features

- **Schema-Driven API Generation** - Auto-generate REST endpoints from Prisma schema
- **Multi-Database Support** - PostgreSQL and MySQL/MariaDB via Prisma adapters
- **Row-Level Security (RLS)** - Database-enforced security via session variables
- **Access Control Layer (ACL)** - Fine-grained model-level permissions
- **Advanced Query Building** - Filtering, sorting, pagination, and relation loading
- **Model Middleware** - Before/after hooks for all CRUD operations
- **JWT Authentication** - Built-in auth with access/refresh token rotation
- **Rate Limiting** - Redis-backed with memory fallback
- **Internationalization** - Multi-language support (10 languages included)
- **Security Headers** - CSP, HSTS, X-Frame-Options out of the box

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
- [Examples](#examples)

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Your Database

Pull your existing database schema or create a new one:

```bash
npx prisma db pull
# or
npx prisma migrate dev
```

### 3. Generate Prisma Client

```bash
npx prisma generate
```

### 4. Build Your API

Run the Rapidd build command to generate API endpoints and ACL rules:

```bash
npx @rapidd/build
```

### 5. Configure Environment

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

### 6. Start Server

```bash
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
| `NODE_ENV` | No | development | `development` or `production` |
| `ALLOWED_ORIGINS` | No | * | Comma-separated allowed CORS origins |
| `COOKIE_SECRET` | No | - | Secret for signed cookies |
| `SALT_ROUNDS` | No | 10 | bcrypt salt rounds |
| `API_RESULT_LIMIT` | No | 500 | Max results per query |
| `RLS_NAMESPACE` | No | app | RLS variable namespace |
| `RLS_USER_ID` | No | current_user_id | RLS user ID variable name |
| `RLS_USER_ROLE` | No | current_user_role | RLS user role variable name |

### Config Files

- `config/app.js` - Application settings (languages, etc.)
- `config/rate-limit.json` - Rate limiting configuration

---

## Core Concepts

### Model Class

The `Model` class provides a high-level ORM interface with built-in ACL integration.

```javascript
const { Model } = require('./src/Model');

class Users extends Model {
    constructor(options) {
        super('users', options);
    }

    // Add custom methods
    async findByEmail(email) {
        const result = await this.getMany({ email });
        return result.data[0];
    }
}

// Usage
const users = new Users({ user: req.user });
const result = await users.getMany({}, 'posts', 10, 0);
```

#### Model Methods

| Method | Description |
|--------|-------------|
| `getMany(filter, include, limit, offset, sortBy, sortOrder)` | Fetch multiple records |
| `get(id, include, options)` | Fetch single record by ID |
| `create(data, options)` | Create new record |
| `update(id, data, options)` | Update existing record |
| `upsert(data, uniqueKey, options)` | Create or update record |
| `upsertMany(data, uniqueKey, options)` | Batch create or update records |
| `delete(id, options)` | Delete record |
| `count(filter)` | Count matching records |

#### Batch Operations

The `upsertMany` method allows efficient batch create/update operations within a single transaction:

```javascript
const contacts = new Contacts({ user: req.user });

// Batch upsert by unique key
const result = await contacts.upsertMany([
    { contact_id: '1', first_name: 'John', email: 'john@example.com' },
    { contact_id: '2', first_name: 'Jane', email: 'jane@example.com' },
    { contact_id: '3', first_name: 'Bob', email: 'bob@example.com' }
], 'contact_id');

// Returns: { created: 2, updated: 1, total: 3 }
```

The method automatically:
- Checks which records exist by the unique key
- Separates data into creates and updates
- Executes all operations in a single transaction
- Triggers middleware for `upsertMany` operations

### QueryBuilder

The `QueryBuilder` class handles query parsing and Prisma query generation.

```javascript
const { QueryBuilder } = require('./src/QueryBuilder');

const qb = new QueryBuilder('users');

// Build filter from query string
const where = qb.filter('name=%John%,age=gt:18');

// Build include for relations
const include = qb.include('posts.comments', user);

// Build sort
const orderBy = qb.sort('createdAt', 'desc');
```

### Access Control (ACL)

ACL provides model-level permission control.

```javascript
// rapidd/acl.js or generated by @rapidd/build
const { acl } = require('./rapidd/rapidd');

// Register ACL rules for a model
acl.register('posts', {
    // Who can create?
    canCreate: (user) => ['ADMIN', 'AUTHOR'].includes(user.role),

    // Filter for read access
    getAccessFilter: (user) => {
        if (user.role === 'ADMIN') return true; // Full access
        return {
            OR: [
                { authorId: user.id },
                { published: true }
            ]
        };
    },

    // Filter for update access
    getUpdateFilter: (user) => {
        if (user.role === 'ADMIN') return true;
        return { authorId: user.id }; // Only own posts
    },

    // Filter for delete access
    getDeleteFilter: (user) => {
        if (user.role === 'ADMIN') return true;
        return false; // Others can't delete
    },

    // Fields to hide based on role
    getOmitFields: (user) => {
        if (user.role !== 'ADMIN') {
            return ['internalNotes', 'adminComments'];
        }
        return [];
    }
});
```

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

```javascript
const { Model } = require('./src/Model');

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

// Abort operation
Model.middleware.use('before', 'delete', async (ctx) => {
    if (ctx.user?.role !== 'ADMIN') {
        ctx.abort = true;
        throw new Error('Only admins can delete');
    }
    return ctx;
}, 'critical_data');
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

- **Access Token**: Expires in 1 day
- **Refresh Token**: Expires in 7 days
- Sessions stored in database for revocation

---

## API Reference

### ErrorResponse

```javascript
const { ErrorResponse } = require('./src/Api');

// Throw standardized errors
throw new ErrorResponse(400, 'validation_error', { field: 'email' });
throw new ErrorResponse(401, 'unauthorized');
throw new ErrorResponse(403, 'forbidden');
throw new ErrorResponse(404, 'not_found');
```

### Prisma Clients

```javascript
const { prisma, authPrisma } = require('./rapidd/rapidd');

// prisma - User context with RLS
const posts = await prisma.posts.findMany();

// authPrisma - Admin context (bypasses RLS)
const allPosts = await authPrisma.posts.findMany();
```

### Transactions

```javascript
const { prismaTransaction } = require('./rapidd/rapidd');

const [users, posts] = await prismaTransaction([
    (tx) => tx.users.findMany(),
    (tx) => tx.posts.findMany()
]);
```

### DMMF Utilities

```javascript
const dmmf = require('./rapidd/dmmf');

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

## Examples

### Custom Route with Model

```javascript
// routes/api/v1/posts.js
const express = require('express');
const { Model } = require('../../../src/Model');
const { requireAuth } = require('../../../rapidd/auth');

const router = express.Router();

class Posts extends Model {
    constructor(options) {
        super('posts', options);
    }
}

// GET /api/v1/posts
router.get('/', async (req, res) => {
    const posts = new Posts({ user: req.user });
    const { filter, include, limit, offset, sortBy, sortOrder } = req.query;

    const result = await posts.getMany(
        filter,
        include || 'author',
        limit || 25,
        offset || 0,
        sortBy || 'createdAt',
        sortOrder || 'desc'
    );

    res.json(result);
});

// POST /api/v1/posts
router.post('/', requireAuth, async (req, res) => {
    const posts = new Posts({ user: req.user });
    const result = await posts.create({
        ...req.body,
        authorId: req.user.id
    });

    res.status(201).json(result);
});

module.exports = router;
```

### Custom ACL Rules

```javascript
// config/acl/posts.js
module.exports = {
    canCreate: (user) => {
        return user && user.role !== 'GUEST';
    },

    getAccessFilter: (user) => {
        if (!user) {
            // Anonymous: only published posts
            return { published: true };
        }
        if (user.role === 'ADMIN') {
            return true; // Full access
        }
        // Users see published + their own drafts
        return {
            OR: [
                { published: true },
                { authorId: user.id }
            ]
        };
    },

    getUpdateFilter: (user) => {
        if (user.role === 'ADMIN') return true;
        return { authorId: user.id };
    },

    getDeleteFilter: (user) => {
        if (user.role === 'ADMIN') return true;
        return false;
    },

    getOmitFields: (user) => {
        const hidden = [];
        if (user?.role !== 'ADMIN') {
            hidden.push('adminNotes', 'internalMetrics');
        }
        return hidden;
    }
};
```

### Model Middleware for Audit Log

```javascript
// middleware/model.js
const { Model } = require('../src/Model');
const { prisma } = require('../rapidd/rapidd');

// Log all mutations to audit_logs table
['create', 'update', 'delete'].forEach(operation => {
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
├── config/
│   ├── app.js              # Application config
│   └── rate-limit.json     # Rate limiting config
├── lib/
│   ├── ejsRender.js        # EJS template rendering
│   ├── pushLog.js          # Logging utility
│   └── SendMail.js         # Email sending
├── middleware/
│   └── model.js            # Model middleware hooks
├── prisma/
│   ├── schema.prisma       # Database schema
│   └── client/             # Generated Prisma client
├── public/
│   ├── static/             # Static files
│   └── template/           # EJS templates
├── rapidd/
│   ├── rapidd.js           # Core module
│   ├── dmmf.js             # Schema introspection
│   ├── acl.js              # Access control
│   ├── auth.js             # Authentication
│   ├── rls.js              # Row-level security
│   └── modelMiddleware.js  # Middleware system
├── routes/
│   ├── api/
│   │   └── v1/             # API v1 routes
│   └── root.js             # Root routes
├── src/
│   ├── Model.js            # ORM layer
│   ├── QueryBuilder.js     # Query building
│   └── Api.js              # API utilities
├── strings/                # i18n translations
├── main.js                 # Application entry
└── package.json
```

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
- URLs starting with `postgresql://` → PostgreSQL
- URLs starting with `mysql://` or `mariadb://` → MySQL

Override with `DATABASE_PROVIDER` environment variable if needed.

---

## Security

### Built-in Security Features

- **CSRF Protection** - Cookie-based CSRF tokens
- **Rate Limiting** - Configurable per-endpoint limits
- **Security Headers** - CSP, X-Frame-Options, X-XSS-Protection, HSTS
- **Password Hashing** - bcrypt with configurable rounds
- **JWT Authentication** - Signed tokens with expiration
- **RLS** - Database-level row security
- **ACL** - Application-level access control
- **Input Sanitization** - SQL injection prevention

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Configure strong `JWT_SECRET` and `JWT_REFRESH_SECRET`
- [ ] Set up Redis for rate limiting
- [ ] Configure `ALLOWED_ORIGINS` for CORS
- [ ] Enable HTTPS
- [ ] Set up RLS policies in database
- [ ] Review and customize ACL rules
- [ ] Configure proper logging

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

MIT

---

Built with ❤️ by [Mert Dalbudak](https://github.com/MertDalbudak)
