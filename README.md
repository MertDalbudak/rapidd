<img width="64" height="64" alt="logo" src="https://github.com/user-attachments/assets/706dd13b-212c-4076-b4d7-94dec4001a06" />

# rapidd

**Rapidd** is a powerful Node.js framework that automatically generates production-ready REST APIs from your Prisma schema. It eliminates the need to manually write CRUD endpoints, route handlers, and data validation logic by intelligently building them from your database schema.

## How It Works

Rapidd analyzes your Prisma schema and automatically generates:
- **REST API endpoints** for all models (GET, POST, PUT, DELETE)
- **Query capabilities** with filtering, sorting, pagination, and relations
- **Access Control Layer (ACL)** policies for fine-grained access control
- **Request validation** based on your schema constraints
- **Response formatting** with consistent data structures

This means you can go from a database schema to a fully functional API in minutes, not days. The framework handles all the boilerplate while giving you complete control over security policies and business logic.

## Why Rapidd is Powerful

- **Zero Boilerplate**: No need to write repetitive CRUD operations
- **Type-Safe**: Leverages Prisma's type safety throughout your API
- **Security First**: Built-in ACL policies ensure data access is controlled at the row level
- **Production Ready**: Includes rate limiting, error handling, and Redis caching out of the box
- **Flexible**: Override or extend generated endpoints with custom logic when needed
- **Fast Development**: Build complex APIs in a fraction of the time

## Setup

### 1. Pull Your Database Schema

First, ensure you have a `schema.prisma` file. If you have an existing database, pull the schema:

```bash
npx prisma db pull
```

### 2. Build Your API

Run the Rapidd build command to generate your API endpoints:

```bash
npx rapidd build
```

> **Tip**: Reference the [@rapidd/build](https://www.npmjs.com/package/@rapidd/build) package documentation for advanced build options and configuration.

### 3. Configure Row-Level Security

After building, review the generated ACL (Access Control Layer) policy files in your project. These files define access control rules for each model. Customize them according to your security requirements.

### 4. Configure Your Application

Create an `app.json` file under the `/config` directory. You can use [config/default.json](config/default.json) as a reference example for the configuration structure.
Also create an `.env` file in the root directory of your project. You can use [.env.example](.env.example) as a reference for the environment variables needed.

### 5. Start Your Server

Once your application is configured, start the server:

```bash
npm start
```

Your API is now live and ready to handle requests!

## Example Use Case

With a simple Prisma schema like this:

```prisma
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  posts     Post[]
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String?
  authorId  Int
  author    User     @relation(fields: [authorId], references: [id])
}
```

Rapidd automatically generates endpoints like:
- `GET /api/users` - List all users (with filtering, pagination)
- `GET /api/users/:id` - Get a specific user
- `POST /api/users` - Create a user
- `PUT /api/users/:id` - Update a user
- `DELETE /api/users/:id` - Delete a user

And the same for `Post` and any other models in your schema.

---

Built with ❤️ by [Mert Dalbudak](https://github.com/MertDalbudak)
