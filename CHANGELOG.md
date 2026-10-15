# Changelog

All notable changes to `@rapidd/core` are documented here. This project follows
[Semantic Versioning](https://semver.org/). Because Rapidd is a
[vendored framework](https://github.com/MertDalbudak/rapidd/wiki/Getting-Started#architecture--updates)
(the framework source is copied into your project rather than installed), framework fixes below
do **not** reach existing projects via `npm update` — see the linked section for how to adopt them.

## [Unreleased]

Access control is code only, and Rapidd no longer assumes a role: users with roles in a column,
in their own table, in directory groups or as flags all work the same way.

> **Read before upgrading — breaking changes:**
> 1. **`config/acl.json` is removed** (the setup wizard's access rules) — its rules no longer
>    apply. Move them into `src/config/acl.ts`: a model without an entry there follows
>    `ACL_DEFAULT` (unrestricted by default; the boot log lists such models). While acl.ts has
>    no entry, `npx rapidd build --only acl` writes a starting one.
> 2. **`AUTH_ROLE_MAP` / `AUTH_DEFAULT_ROLE` and the `roles` option** (in `src/config/auth.ts`
>    and per provider) are removed. Users without a user-table row carry the identity
>    provider's `groups` and `roles` as data — check them in `src/config/acl.ts`. A leftover
>    variable is reported at startup.
> 3. **`fastify.requireRole()` is removed** — guard routes with a preHandler of your own.
> 4. **`RapiddUser` has no `role`.** The anonymous user is `{ id: null }` (was `role: 'anonymous'`),
>    the system user `{ id: null }`, a token with only `sub` is `{ id }` (was `role: 'user'`).
>    `ResolveUserHelpers.mapRole` and `RoleMappingConfig` are gone.
> 5. **ApiClient retries POST and PATCH again by default.** Set `"retry": false` in
>    `config/app.json` for services or endpoints whose calls must not run twice.
> 6. **`RLS_ENABLED=true` no longer does anything on MySQL / MariaDB.** It set the RLS
>    variables as `@app_<name>` session variables for views or triggers of your own; they are not
>    set any more (a startup warning names a leftover setting). Row-level security is PostgreSQL's.

### Added — SAML 2.0 single sign-on

- `AUTH_PROVIDERS=saml`: browser sign-in through a SAML identity provider — Entra ID, ADFS, Okta,
  Keycloak, Shibboleth, Google Workspace. The IdP's metadata comes from a URL (read again daily)
  or a file; `GET /auth/saml/metadata` is this API's metadata for the IdP. Needs the
  `@node-saml/node-saml` package (`npm install @node-saml/node-saml`), loaded only when SAML is
  configured.
- A response must carry a valid IdP signature (on the response or the assertion), answer a
  request this API sent — each once, also across instances with Redis — be for this API, from
  this IdP and within its validity period, and is bound to the browser that started the sign-in.
  IdP-initiated logins are refused; single logout is not supported.
- Attributes for email, name, username, groups and roles are found under the names the common
  IdPs use (`SAML_ATTRIBUTE_*` to set them); groups and roles are data for
  `src/config/acl.ts`. An optional key and certificate sign requests and decrypt encrypted
  assertions.
- The callback accepts the IdP's form POST from any origin — production's CORS check would have
  refused it (a route opts out with `config: { anyOrigin: true }`).
- Setup wizard: a SAML section on *Sign-in* — upload the IdP's metadata (or give its URL), see its
  entity id, sign-on URL and certificates, the values to register this API there, and test it.

### Added — setup wizard: indexes

- *Data model & API* checks the lookups the API makes for an index: foreign keys (includes,
  nested routes, deletes — PostgreSQL does not index them by itself; MySQL only lacks them with
  `relationMode = "prisma"`), the columns `src/config/acl.ts` filters every read by, and sign-in.
  With the database readable it decides what exists, lists the indexes the schema has but the
  database lacks, and ranks by table size. *Indexes* adds the chosen ones with Prisma's SQL
  (`prisma migrate diff`): as a deployed migration when `prisma/migrations` exists, else built in
  the database (PostgreSQL: `CREATE INDEX CONCURRENTLY`) — and as `@@index` in the schema.

### Changed — access control

- `src/config/acl.ts` is the only access control. One that does not load — a syntax error, a
  broken import — stops the API; it used to be logged and its entries dropped, and a missing
  import inside it was mistaken for no acl.ts at all.
- `rapidd build` (`@rapidd/build`, same release) writes `src/config/acl.ts` while it has no entry:
  one entry per model, credential columns hidden with `getOmitFields`, and the user table's
  password column (`DB_USER_TABLE` / `DB_USER_PASSWORD_FIELD`, else detected by name) left out
  of `getWritableFields` — hiding it alone kept a required password writable, so any user could
  set any user's. A user table without a password column gets no such rule. An acl.ts with
  entries is never changed — check yours for the same gap.
- Setup wizard: the Access control page is gone. *Data model & API* shows per model whether
  acl.ts has an entry — warning when credential columns would be returned — and generates
  acl.ts; the RLS page offers the user's columns as variable sources and no role preset.

### Changed — ORM: keys, links, order

- **Lists come in the order of the model's key** when no `sort` is given — offset pages could
  repeat or skip rows without one.
- **Nested writes:** foreign keys inside nested items link (`{ orders: [{ customer_id: 3 }] }`
  connects the customer, held to its access rule — see Security); the foreign key back to the
  parent is the nesting's, a client's copy of it is ignored; the create half of a nested upsert
  creates its own nested rows (it used `upsert` there, which Prisma refuses). A nested create that
  links relations leaves an autoincrement key to the database — Prisma takes such a key only
  without relations.
- **A requested sort is tie-broken by the key** — rows that tie (`sort=status`) had no order of
  their own and could repeat or go missing across offset pages.
- **Nested rows whose key includes the parent's** — tenant-first composite keys, join tables like
  `org_members (org_id, user_ref)` — take the parent's part from the parent and are addressed by
  their whole key: upserted, linked when there and created when they can be (join rows). They
  were always created — a `409` for every existing one.
- **In a create, a nested item with its key and data is created** with that key (`409` when it is
  taken). It was linked when the key existed — moving the row under the new parent and dropping
  the data sent.
- **A nested item with its key and data is upserted only when it can be a new row** (every
  required column and relation) — otherwise it is an update. Prisma checks an upsert's create half
  even when the row exists: a partial update of a nested row failed with "Argument … is missing".
- **Composite foreign keys that share a column** (`tenant_id` in `(tenant_id, project_no)` and
  `(tenant_id, assignee_no)`): a relation is named by a column only it has; the shared column is
  completed from the parent, or in an update from the row's key, and written in an update it
  moves every link through it. Unlinking such a relation sets its own columns null — `disconnect`
  nulled the shared `tenant_id` too. Together with a link in the same request it is
  `400 foreign_key_unlink_conflict`.
- **A required foreign key set null, or missing from a create**, is `400 foreign_key_required`
  naming its columns (was Prisma's "Unknown argument `disconnect`" / "Argument `…` is missing").
- **Update and delete outside the update / delete rule answer 403**, as documented — Prisma's "not
  found" made them 404. A row that doesn't exist is `404 record_not_found`.
- **Fields a before-hook sets are written.** The requesting user's `getWritableFields` and
  `getOmitFields` stripped them; they now apply to the client's data before the hooks run.
- Filters: Decimal values keep their digits; enum values are checked; Json `#NULL` matches the
  database's NULL and JSON's null; Json wildcards and an unclosed `OR(` are 400s with Rapidd's
  keys; the same field twice (`id=gt:3,id=lt:6`, or repeated `q=`) applies both — the last won.
- Errors: a duplicate names the model and fields behind the database's index name (`posts_pkey`,
  MySQL's `PRIMARY`, a legacy unique index), with the values the request sent;
  `no_permission_to_create` names the model; a BigInt sent as a JSON number past 2^53 — its
  digits lost on the way — is `400 unsafe_integer`. Lists in messages read `a, b`.

### Changed — ApiClient

- **Every method is retried again by default** — POST and PATCH too, as before 3.0.0.
  `config/app.json` decides where that must not happen: `"retry": false` on a service turns it
  off for its endpoints, `"retry"` on an endpoint overrides its service (setup wizard: *Services*).
  A `retries` count passed in code wins over both.

### Security
- **A relation named alone in `fields=` skipped its model's access rule.** `?fields=id,author`
  returned the author row whole — password hashes and other omitted fields included — and lists
  without their row filter or the include row cap. It now comes under the rule as
  `include=author` does.
- **Filters through a relation probed rows the user can't read** —
  `GET /users?q=posts.body=%secret%` found the author of someone else's draft, `price=gt:500`
  could binary-search a hidden price. A relation filter counts only the related rows the user
  can read; a model the rule denies can't be filtered or sorted through (403). A sort through a
  restricted relation still orders by all its rows — Prisma takes no filter in `orderBy`.
- **Linking existing rows through a parent moved rows the user may not update.**
  `PATCH /posts/2 { comments: [{ id: 9 }] }` rewrote another user's comment's `post_id`, held only
  to the read rule — so did raw `connect` / `set` / `connectOrCreate` / `disconnect`. Linking rows
  that hold the foreign key now needs the related model's update rule too (implicit
  many-to-many links are rows of their own and don't).
- **A plain object for a to-one relation ignored the related update rule** —
  `PATCH /tasks/1 { project: { name } }` renamed a project the user may not update. It is held
  to the rule (`false`: 403); with a rule it updates the linked row only.
- **Foreign keys inside nested writes skipped the related model's access rule.**
  `POST /shops { orders: [{ customer_id: 6 }] }` linked any customer, while a top-level foreign
  key was held to the customer rule. Nested ones are now too.

- **Includes dropped part of the related model's access rule.** Conditions that went through
  the relation back to the parent were removed — a comment rule `{ post: { authorId: user.id } }`
  did not apply to `GET /posts?include=comments`, which returned every comment of every
  readable post. The rule now applies as it is.
- **A deny was ignored when Rapidd built a link.** A foreign key in a write payload
  (`{ categoryId: 3 }`) linked to a model whose access rule returns `false`, and a nested update
  went through an update rule that returns `false`. Both now answer 403, as raw `connect`
  operations already did.
- **A user table whose key isn't called `id`** left `user.id` undefined: a rule such as
  `{ author_id: user.id }` matched every row (Prisma ignores undefined), and sessions and "log
  out everywhere" were filed under nothing. `user.id` is now the row's key, whatever the column
  is called (composite keys as `"a~b"`). Independently, a rule filter with an `undefined` value
  now denies and is logged.
- **The whole user row reached clients**: in the access token (readable by anyone holding it),
  the login and ticket-exchange responses and `/auth/me` — secrets and reset tokens included.
  They now show what the user model's `getOmitFields` lets the user read; the session keeps the
  row for access control.
- Setup wizard: the RLS preset that took the tenant from the client-controlled `X-Tenant-Id`
  header is gone, and a variable read from any header is flagged — clients choose its value.

### Fixed
- **Keys and links that assumed a column `id`:**
  - A model identified by `@unique` / `@@unique` alone (`prisma db pull` makes them from tables
    with a unique index but no primary key) was looked up by a column `id` — get, update,
    delete, `upsertMany` and a user table like that failed. Its unique is its key now.
  - Composite foreign keys linked their first column only (`{ orgId: 1, userId: 2 }` became
    `connect: { orgId: 1 }` next to a stray `userId`). They link through the compound selector,
    with all columns — half a key is `400 incomplete_foreign_key`.
  - Nested writes two levels deep: creates left the second list level unconverted, and items
    that only name a record were linked by `id` instead of their key. Rows with a composite key
    were addressed with plain fields instead of the compound selector.
  - `@rapidd/build` generates routes for keys of three or more columns (`/:id` = `a~b~c`) — they
    were skipped — and finds the key of a model without `@id` as the core does.

- `file.saveTo()` failed in the Docker image: the temporary file and the uploads volume are on
  different filesystems, which `rename` can't cross. It copies there instead.
- `buildApp({ routesPath })` mounted the routes under prefixes computed from `ROUTES_PATH`.
- `upsertMany` never updated rows whose key is a DateTime (the database returns a Date, the
  request ISO text), a Decimal written differently (`1.50` / `1.5`) or an upper-case UUID —
  they were only counted as skipped.
- A foreign key of `0` was dropped on create.
- Two browser tabs signing in at the same time both failed: the second sign-in replaced the
  first's state cookie, and a failed callback deleted it. Each sign-in has a state cookie of its
  own now (`rapidd_auth_state_<id>`), which only its callback takes.
- `POST /auth/login` on an API with only redirect sign-in (OIDC, SAML) answered 500 and logged an
  error — it is `400 auth_provider_not_found`.
- Readiness reported sessions `ok` while Redis was down once they had fallen back to memory —
  `degraded` until Redis is back.
- ApiClient: a non-numeric `API_MAX_RETRIES` (or `REQUEST_TIMEOUT`) or a negative `retries` made
  no request and threw `null`. Invalid settings fall back to the default with a warning; a
  negative count is 0.
- A DateTime key part was read leniently — `10` as 2001-10-01, a time without a zone in the
  server's timezone. ISO 8601 only; without a zone, UTC.
- The boot log names the models `ACL_DEFAULT=deny` denies (they appeared at `LOG_LEVEL=fine`
  only), and warns when `src/config/acl.ts` returns the user table's password column or lets it
  be written (no `getWritableFields` for the user table — as acl.ts files written by earlier
  builds have).
- SAML messages (`SAMLRequest`, `SAMLResponse`, `RelayState` — in URLs, also on the way to the
  identity provider, and in logged bodies) and the callback's `response` key are redacted in
  request logs.
- Setup wizard:
  - With `prisma/migrations`, adding indexes deployed with the API's `DATABASE_URL`: a role that
    doesn't own the tables failed, leaving a failed migration that blocked every later deploy
    (P3009) and an `@@index` the database lacked. `migrate deploy` and `db push` run with
    `DATABASE_URL_ADMIN` when set; a failed index migration is rolled back and removed, the
    indexes its first statements had built are dropped, and the schema is restored.
  - The database check, and the guard that lets *Create tables* (`db push`) run only on a
    database without the schema's tables, listed tables through `information_schema` — which
    shows a role only the tables it may use. With the API's own role an existing database looked
    empty. They read PostgreSQL's catalog now, through the connection that pushes.
  - Two index additions at once failed with `EEXIST` (500) — they run one after the other.
  - A suggestion took over the reason of a narrower lookup an existing index already served.
  - A service test named an internal cache key instead of the service.
- `@rapidd/build`:
  - A join table added after its parent route was generated got a sub-route nothing loaded.
    New parent routes register every `_<name>` sub-route next to them by themselves; for an
    existing one, the build prints the line to add.
  - Models whose names become the same class (`user_role` and `UserRole`) shared one model
    file, so one route served the other table — the build now stops and names them. A model
    named like the template's imports (`model Model`) no longer fails to compile.
  - The delete response names the model, not its class (`TaskLabels successfully deleted`).

## [3.0.1] - 2026-10-11

### Changed — ORM

- **`upsertMany` updates are up to 3× faster on MySQL / MariaDB** (~10 % on PostgreSQL). An
  existing record whose payload is only the model's own columns is written with one `updateMany`
  statement; `update` also reads the row back — on MySQL/MariaDB, without `RETURNING`, a second
  query per record. `update` remains for records with foreign keys (connects checked against the
  related model's ACL) or nested writes, keys that aren't an `@id`/`@unique` field or the fields
  of the `@@id`/an `@@unique`, calls with Prisma options, and records `updateMany` doesn't find —
  so a missing or forbidden row fails with the same error as before. Results, error mappings and
  stored data are unchanged (old and new compared on PostgreSQL 17, MariaDB 12.3 and MySQL 8.4,
  including RLS); Prisma's error message header now names `updateMany()` instead of `update()`,
  and a custom Prisma client extension hooking `update` (rather than `$allOperations`) no longer
  sees these writes. 10 000 existing records: MariaDB 5.8 s → 1.9 s, MySQL 6.9 s → 2.3 s,
  PostgreSQL 1.9 s → 1.7 s.

### Documentation
- README comparison table: "Multi-database" read as connecting several databases at once. The
  row is now "Multiple database engines", with a note that Rapidd supports PostgreSQL and
  MySQL/MariaDB, one database per app.

## [3.0.0] - 2026-10-10

Enterprise sign-in (LDAP / Active Directory, OpenID Connect / OAuth2, WebDAV), hardened sessions,
and the operational basics production deployments need: health checks, graceful shutdown, request
ids, structured logs. A setup wizard in the browser shows and configures everything on first
start. The built-in Mailer is removed — apps use the mail library of their choice.

> **Read before upgrading — breaking or client-visible changes:**
> 1. **Mailer removed** (`src/utils/Mailer.ts`, `templates/`, `config/app.json` → `emails`, and the
>    `nodemailer`/`ejs` dependencies). Projects that use it keep their vendored copy, or switch to
>    nodemailer / their provider's SDK directly.
> 2. **Refresh tokens rotate and are bound to their session.** Every `/auth/refresh` returns a new
>    refresh token — clients must store it. Replaying an already-used refresh token is treated as
>    theft and revokes the session. Refresh tokens issued by 2.x keep working until they expire.
> 3. **`AUTH_SESSION_STORAGE` defaults to `memory` unless `REDIS_URL`/`REDIS_HOST` is set** (was
>    `redis`, which then failed over to memory). Production without Redis now logs a warning.
> 4. **ApiClient no longer retries POST/PATCH by default** (a retry could create twice). Pass
>    `retries` to opt in.
> 5. `/health` and `/health/ready` are registered unless the app defines them (`HEALTH_ENABLED=false`).
> 6. ApiClient's `AuthConfig` type is exported from the package index as `ApiAuthConfig` (the name
>    now belongs to the auth configuration).
> 7. Rate limiting now runs **before** authentication, and `config/rate-limit.json` gained an `/auth`
>    bucket (60/min) for the SSO, exchange and refresh routes.
> 8. **Ids are parsed by the key's type**: `/items/abc` for an `Int` key is `400 invalid_id` (was a
>    Prisma validation error or, for malformed UUIDs, a 500). Lenient parses are gone — composite
>    parts like `12abc` were read as `12`.
> 9. **Raw Prisma nested writes follow the related model's ACL** (`connect`, `deleteMany`, ...; see
>    Access Control). Payloads that relied on bypassing it now get 403 or are narrowed.
>    `delete` is now recognized as a raw operation too.
> 10. **Date-only filters** (`on:2024-06-15`, `createdAt=2024-06-15`) select the calendar day of the
>     string. Servers west of UTC previously matched the day before. New `API_TIMEZONE` fixes the
>     zone the day is read in (default: server timezone, as before).
> 11. `upsertMany` results gained `skipped`, and `totalFailed` counts records (a failed bulk insert
>     counts all of its rows, not 1).
> 12. Client errors (4xx) are logged at `warn` instead of `error`.
> 13. **`main.ts` serves the setup wizard while the API cannot start** (no `DATABASE_URL`, Prisma
>     client not generated, ...) instead of exiting — adopt the new `main.ts` to get it, and set
>     `SETUP_WIZARD=off` where a missing setting should still fail fast. Only problems that already
>     stopped the API open it, so a deployment that starts today keeps starting. For
>     `npm run setup`, add `"setup": "tsx main.ts setup"` to the scripts of `package.json`.
> 14. The Docker image sets `ENV_FILE=/app/data/.env` and declares `/app/data` a volume (where the
>     wizard saves its settings). It installs the driver of one database only (see *Changed —
>     Docker image*).
> 15. **Write responses are the record**: create, update and upsert returned every first-level
>     relation (a `PATCH` of a user with many posts answered 63 KB). They return the record alone
>     now; `?include=` adds relations, as on reads, with the same access rules. Routes generated
>     by `@rapidd/build` after 2.3.0 pass `?include=` on `POST`/`PATCH`; older routes return the
>     record alone. Code that passes an `include` option to `create`/`update` keeps getting it.
> 16. **Unknown relations are a 400**: `include=` and `fields=` naming something that is not a
>     relation of the model answer `400 relation_not_exist` (an unknown `include` was ignored, so
>     a typo went unnoticed).

### Added — authentication

- **Identity providers**, selected with `AUTH_PROVIDERS` (env-only setup) or `src/config/auth.ts`:
  - `local` — the user table (as before).
  - `ldap` — LDAP / Active Directory: search-then-bind or direct bind, failover across servers,
    StartTLS/LDAPS, `memberOf`, AD nested groups or group search. Requires `npm install ldapts`
    (optional peer dependency). Empty passwords are rejected (unauthenticated-bind trap); input is
    escaped for filters (RFC 4515) and DNs (RFC 4514); outages answer 503, not 401.
  - `oidc` — OpenID Connect / OAuth2 (Entra ID, Keycloak, Okta, Auth0, Google, ADFS, GitHub via
    explicit endpoints). **Resource server**: IdP access tokens accepted as bearer tokens — JWKS
    signature (asymmetric algorithms only), issuer, audience, expiry, required scopes; opaque tokens
    via RFC 7662 introspection. **Browser login**: authorization code + PKCE, state bound to the
    browser, nonce, full id_token validation; tokens reach SPAs through a single-use 60 s ticket
    (`POST /auth/exchange`), never in URLs. Verified end-to-end against Keycloak 26.
  - `webdav` — credentials validated with an authenticated PROPFIND (Nextcloud, ownCloud, ...).
  - Custom providers implementing `AuthProvider`.
- **No sign-in** (`AUTH_PROVIDERS=none`, or `providers: []` in `src/config/auth.ts`): no `/auth`
  routes, tokens or JWT secrets; every request runs as the anonymous user (`{ id: null, role:
  "anonymous" }`, or the default user of `src/config/user.ts`) — not a system user: access rules
  apply (role `anonymous`, else `*`). The setup wizard offers it as *none — no sign-in*.
- JWT secrets are required (in production) only when auth is on — a project without a user table
  no longer fails to start without them.
- **Identity mapping**: link external identities to user-table rows (`AUTH_LINK`, default email,
  case-insensitive on PostgreSQL, ambiguous matches rejected), `provision` rows on first login,
  claims-only users with `AUTH_ROLE_MAP` role mapping, or full control via `resolveUser`.
- **Hooks**: `validateUser` (login, refresh, first use of an external token — reject deactivated
  accounts; a rejected refresh revokes the session) and `onLogin` (audit, last-login).
- **Revocation**: `auth.revokeSession()`, `auth.revokeUserSessions(userId)` (per-user index — no
  keyspace scans), `getAuth()` for code outside requests. `AUTH_SESSION_MAX_AGE` absolute lifetime.
- Routes: `GET /auth/providers`, `GET /auth/:provider/login`, `GET /auth/:provider/callback`,
  `POST /auth/exchange`. `/auth/login` accepts an optional `provider`.
- Cookie mode: refresh cookie `<name>_refresh` (path `/auth`) — cookie-only clients can refresh.

### Added — operations

- `startServer()` (`src/server.ts`, used by `main.ts`): graceful shutdown on SIGTERM/SIGINT —
  readiness turns 503, optional `SHUTDOWN_DELAY_MS`, in-flight requests finish, connections and
  pools close, exit within `SHUTDOWN_TIMEOUT_MS`.
- `GET /health` (liveness) and `GET /health/ready` (database; session store reported as
  `degraded` without failing readiness, since sessions fall back to memory).
- Request ids: `X-Request-Id` (incoming value reused when log-safe) on every response and stamped on
  every log line written during the request.
- `LOG_FORMAT=json` structured logs.
- `buildApp`/`startServer` options: `plugins`, `errorReporter` (every 5xx + process crashes),
  `health`, `auth`, `processHandlers`. Route configs `rateLimit: false` and `accessLog: false`.
- `ACL_DEFAULT=deny` (models without an ACL entry are closed) and a startup audit listing models
  without an entry.
- `${ENV_VAR}` / `${ENV_VAR:-default}` substitution in `config/app.json` — secrets out of the file.
- `REDIS_URL` (`rediss://`), `REDIS_USERNAME`, `REDIS_TLS` — shared by sessions and rate limiting.
- `TRUST_PROXY` accepts the proxies' addresses (IPs, CIDRs, `private`, `cloudflare`, `loopback`,
  ...) and hop counts. A hop is trusted only from a proxy address — private, or the listed ones
  (`1,203.0.113.0/24`) — as Fastify 5.12+ requires: a client that reaches the server directly
  cannot set its own IP. Invalid values stop the start with what is wrong.
- Unset `TRUST_PROXY` trusts every proxy outside production too (2.x: none) — a development
  server behind a tunnel or proxy sees the visitor's IP. Production keeps its default and warning.
- **Behind Cloudflare** a hop count gives every visitor a Cloudflare address (its servers are
  public): `TRUST_PROXY=private,cloudflare` trusts Cloudflare's published ranges and the proxies
  on the machine or network. The setup wizard recognises Cloudflare (on its own request, or
  `PUBLIC_URL` resolving to it), shows whom the API takes the visitor for and proposes the value —
  filled in while unset; the API logs once when Cloudflare traffic arrives untrusted.
- `CORS_ALLOWED_HEADERS`; `BODY_LIMIT`; `DEFAULT_LANGUAGE`; `PUBLIC_URL`; enumerated env vars are
  validated at startup.
- `ctx.state` in model middleware: one object shared by an operation's before and after hooks.

### Security — hardening from an adversarial review of the new auth layer

Each item was a working exploit against the first version of the provider layer (proven by tests,
now regression tests in `__test__/auth/AuthSecurity.test.ts` and the provider suites):

- **Account linking matched with wildcards** on PostgreSQL (`mode: insensitive` compiles to an
  unescaped `ILIKE`, so `a_ice@` linked to `alice@`) and with accent/padding-insensitive collations on
  MySQL. Links are now decided by an exact (case-insensitive) comparison in code.
- **A refresh in flight could undo a revocation**: refresh now writes conditionally (`SET … XX`) and
  re-checks after recreating the session.
- **Revocations during a Redis outage came back when Redis recovered**: they are recorded and
  replayed against Redis before switching back from memory.
- **`revokeUserSessions` now also ends tokens that aren't session-bound** (legacy refresh tokens —
  now single-use — tokens minted without a session, IdP bearer tokens issued earlier).
- **Users from `resolveUser` were never re-validated**: refresh re-runs `resolveUser`; LDAP sessions
  re-check the directory entry (deleted / disabled / locked accounts end at the next refresh).
- **Role mapping**: exact matches only; LDAP groups are full DNs (a "Domain Admins" CN in another OU no
  longer matches); `role:` / `group:` key prefixes keep IdP roles and groups apart.
- Claims-only user ids are namespaced (`<provider>:<subject>`), so they cannot collide with
  user-table ids.
- WebDAV identities are the server-confirmed principal (`current-user-principal`), not the typed
  alias; unconfirmable logins are rejected.
- OIDC: id_tokens are refused as bearer tokens; introspected tokens without `aud` must be issued to
  one of our clients; `email_verified: "false"` counts as unverified; several providers may share an
  issuer.
- Redirects: control characters rejected (`/<TAB>/evil.com`), https required in production,
  scheme/port of `ALLOWED_ORIGINS` entries enforced; production SSO requires `PUBLIC_URL` instead of
  trusting the Host header.
- Refresh tokens are never accepted as access tokens (even with `JWT_REFRESH_SECRET == JWT_SECRET`);
  JWT secrets are enforced even when schema loading fails; an empty `COOKIE_SECRET` no longer breaks
  every cookie request; memory sessions return copies (mutating `request.user` no longer rewrites the
  session) and are capped; login tickets and OAuth codes are redacted from logged URLs.

### Added — setup wizard

- **A setup wizard in the browser** (Rapidd-branded, light and dark): while the API cannot start,
  `npm run dev` / `npm start` serve it instead (link with a setup password in the console) and
  start the API in the same process when it is done. **`npm run setup`** (in the image:
  `docker run … <image> setup`) opens it any time — finishing saves and ends the command, also
  while something is still missing. `SETUP_WIZARD=on` opens it at every start, before the API;
  `off` exits as before.
- **Settings**: every setting the API reads — with its real default, help text, source (env file /
  environment / default) and validation — on guided pages (Database, Sign-in, …) and complete,
  searchable, by group under *Environment*. LDAP / OIDC / WebDAV appear when enabled.
- **Connection tests**: database (version, tables), Redis, LDAP (each server, the service account,
  a test sign-in showing the mapped identity), OIDC (discovery, signing keys, the redirect URI to
  register), WebDAV — failures explained ("Authentication failed — check user name and password").
- **Data model & API**: the schema's actions (`db pull`, create tables, `migrate deploy`,
  `prisma generate`) — each guarded (no pull over existing models, no push into a database that has
  the tables) — and every model with its generated model class, REST route (own, nested for join
  tables, none) and access rules. Generate model classes, routes and default access rules for the
  selected models; works with older `@rapidd/build` versions (one model per run).
- **Access control** editor for `config/acl.json`: per model and role create / read / update /
  delete (all rows, no rows, a filter such as `user_id = $user.id`), hidden and writable fields,
  presets (own rows, read-only, administrators only, no access), `ACL_DEFAULT`, the role field.
  Models defined in `src/config/acl.ts` are shown read-only.
- **Row-level security**: whether policies can work (superuser / `BYPASSRLS`, table owners without
  `FORCE`, sign-in without a bypassing `DATABASE_URL_ADMIN`, RLS off with policies, tables without a
  policy), the session variables (`config/rls.json`), and every table with its policies — turn RLS
  on/off, force it, drop policies, and a policy builder (columns equal variables, an optional bypass
  value) that shows the SQL before it runs. SQL is generated on the server from names checked
  against the schema.
- **Rate limits** editor (`config/rate-limit.json`) with route suggestions and a check which rule
  applies to a path. **Services** editor for ApiClient (`config/app.json`): base URL, authorization
  with credentials kept in the environment as `${NAME}`, default headers and parameters, endpoints,
  and a test call per endpoint with the unsaved configuration.
- **Review & start**: settings and config files are staged until saved; the review shows every
  setting change and each file as a diff, then writes them together — nothing while one is invalid.
  **First user** from a form that follows the user model, only while the table is empty.
  **Exports**: `.env`, docker compose, Kubernetes Secret, shell.
- Env file handling: `ENV_FILE` (default `.env`), atomic writes with `0600` permissions and a
  `.bak` backup, in-place updates that keep comments and order, quoting verified against dotenv.
  Config files are written atomically too (`0644`, `.bak`).
- Security: a setup password (random per start, or `SETUP_PASSWORD`) exchanged for an `HttpOnly` /
  `SameSite=Strict` cookie, a header required against cross-site requests, lockout after 10 wrong
  passwords, CSP with nonces and no external resources,
  secrets masked in the page, `/health` 200 / `/health/ready` 503 while in setup.
- Internals: `Logger.configure()` re-reads the log settings; `createRedisClient(options, env)`;
  `resetDMMF()`; side-effect-free `core/adapter` (`createAdapter` is still exported from
  `core/prisma`); the settings catalog `src/setup/catalog.ts`, kept in step with the code by a test.

### Added — setup wizard: relation names, MariaDB JSON

- **Relation names**: relations read from a database are named after tables (`other_employees`,
  `Follow_Follow_followerIdToUser`) — and those names are the API's. *Data model & API* links
  each model's relations to a rename dialog with suggestions (from the foreign key: `manager`,
  `employees_by_manager_id`, `parent` / `children`, in the model's naming style). Renaming
  rewrites `prisma/schema.prisma` (validated, `.bak` kept), generates the client, and updates the
  staged access rules that use the relations.
- **MariaDB JSON**: MariaDB stores JSON as LONGTEXT, which Prisma introspects as `String` — the
  API returned JSON as text. *Read from the database* types those columns `Json` (found by their
  `json_valid()` check); for a schema pulled before, the page offers **Type as Json**.

### Added — declarative access rules and RLS variables

- **`config/acl.json`**: access rules per model and role — `create` true/false; `read`, `update`,
  `delete` as `"all"`, `"none"` or `{ "where": … }` with `"$user.<attribute>"` values; `hide` and
  `write` field lists (`"all"`: no restriction); `"*"` for every other role. Applied automatically:
  an entry in `src/config/acl.ts` takes its model over. Fail closed (missing rule, role or user
  attribute grants nothing); an unusable file stops the API instead of failing open.
- **`config/rls.json`**: the RLS session variables from the signed-in user (`user.<attribute>`) or a
  header (`header.<name>`). The default `src/config/rls.ts` loads it (`rlsFromConfig()`); a function
  of your own still replaces it.
- `prepareServiceRequest(name, service, endpoint, options)` (ApiClient): the request of a service
  endpoint — URL, method, headers with authorization — for a service passed in.

### Fixed — found by running PostgreSQL, MySQL 8 and MariaDB projects end to end

- **PostgreSQL schemas other than `public`**: `?schema=` in `DATABASE_URL` was ignored by the
  runtime — every query went to `public`. It now reaches the adapter; `connection_limit` and
  `pool_timeout` size the pool (it was fixed at 10).
- **MySQL 8**: the API could not connect once MySQL's authentication cache was empty (after a
  server restart) — `caching_sha2_password` needs the server's RSA key without TLS, and requests
  failed after a 10 s pool timeout. The key is fetched as Prisma's CLI does
  (`allowPublicKeyRetrieval=false` turns it off). Prisma's MySQL URL parameters apply now —
  `connection_limit`, `connect_timeout`, `socket_timeout`, `socket`, and **TLS** (`sslaccept`,
  `sslcert`, `ssl=true`), which managed MySQL services require.
- **Database errors are client errors**: check-constraint violations, invalid values and writes a
  row-level security policy refuses answered 500 with the database's message. They map to
  `400 database_constraint_failed` / `invalid_value` / `value_too_long` / ..., `403 no_permission`,
  `409 transaction_write_conflict` (PostgreSQL and MySQL).
- **Deletes under row-level security**: a delete a policy refused (row visible, not deletable)
  answered `200 … successfully deleted` while the row stayed. Deletes now return `404` then.
- Duplicate errors name the field again (`409 duplicate_entry`) — the field went missing with
  Prisma 7's driver adapters ("A record with this  already exists").
- **Token lifetimes as bare numbers**: `AUTH_ACCESS_TOKEN_EXPIRY=3600` made tokens that expired
  after 3.6 seconds (jsonwebtoken reads a unitless string as milliseconds; `90` expired at once).
  A bare number is seconds now, as for numbers in code; `15m`, `1d` are unchanged.
- The setup wizard says what each setting accepts: units (milliseconds, seconds, bytes),
  separators, the meaning of each option, and — for `DATABASE_URL`, `TRUST_PROXY`, `AUTH_LINK`,
  `AUTH_ROLE_MAP` and `DB_USER_TABLE` — a reference of accepted values, the common ones a click
  away. `AUTH_SALT_ROUNDS` is checked against bcrypt's range (4–31).
- Validation errors say which field and why ("Invalid value for argument `hired_on`: … Expected
  ISO-8601 DateTime."), with `data.field`, instead of a bare "Data validation error".
- **`DATE` columns** (`@db.Date`): date-only filters selected the wrong day on servers outside
  UTC (`hired_on=2015-01-04` matched the 3rd); they are calendar days now. Date-only values
  (`"2026-01-15"`) are accepted on create and update for `DateTime` fields.
- **Array columns** (`String[]`): `q=tags=sale` answered 400 with Prisma internals; it tests
  the elements now (`has`, `[a,b]` → `hasSome`, `not:`).
- The startup line names the address and mode — "Server running on http://localhost:3000
  (production)" — at the default log level it said only "Server running".
- Setup wizard: a user table under another name (e.g. `employees`) is recognised as a candidate
  and offered for `DB_USER_TABLE`, on the sign-in and first-user pages.
- **Prisma 7.10** reports database errors as `P2039` — they answered 500 again; the mapping to
  4xx covers them.

### Changed — dependencies

- Updated: `fastify` 5.12, Prisma 7.10 (`@prisma/client`, adapters, `@prisma/internals`, CLI),
  `pg` 8.23, `@fastify/cookie` / `cors` / `multipart` / `static` (10.1.6), `@fastify/formbody` 9,
  `dotenv` 18, `ioredis` 6, TypeScript 6, jest 30.5, ts-jest 29.4, tsx 4.23 — the version ranges in
  `package.json` (and so in new projects) start there.
- `ioredis` 6 speaks RESP3 by default: Rapidd's clients set `protocol: 2`, so replies — the rate
  limiter's Lua script included — stay as they were and Redis servers before 6 keep working.
- TypeScript 6 deprecates `moduleResolution: "node"`: `tsconfig.json` sets
  `"ignoreDeprecations": "6.0"` (TypeScript 7 drops it — moving to `node16` needs file extensions
  on the dynamic imports) and lists `types`, which TypeScript 6 no longer picks up by itself.
- Not updated: TypeScript 7 (ts-jest supports < 7, and its package no longer has the compiler
  API), Prisma 8 (a release candidate), `@types/node` 25+ (the types follow Node 22 / 24).

### Changed — Docker image

- **One database driver, no build tools.** The image installs the driver of the datasource
  provider in `prisma/schema.prisma` — `@prisma/adapter-pg` + `pg`, or `@prisma/adapter-mariadb` +
  `mariadb` — (`--build-arg DATABASE_PROVIDER=postgresql|mysql` overrides it), no
  `devDependencies`, none of the Prisma CLI, Studio and TypeScript that npm installed as optional
  peers of `@prisma/client`, and the query compiler of that database only. The review projects'
  images went from 712 MB to 432 MB (`node_modules` 342 → 132 MB); both pass their API suites. The
  Prisma client is generated in the build stage.
- An image pointed at the other database says so — the setup wizard reports the mismatch, or with
  `SETUP_WIZARD=off` the server exits with "@prisma/adapter-mariadb is not installed, so
  MySQL/MariaDB databases can't be used" — instead of "Cannot find module".

### Fixed — packaging

- The published package now contains `src/setup/` — `main.ts` imports it, so a project created
  from the package could not start.

### Changed — configuration layout

- `.env.example` is grouped — SERVER, DATA STORES, SECURITY, API, OPERATIONS, AUTHENTICATION.
  Every `AUTH_*`, `JWT_*`, `DB_USER_*`, `LDAP_*`, `OIDC_*` and `WEBDAV_*` variable sits under
  AUTHENTICATION, ordered in subsections: providers, tokens, sessions, session transport, user
  table, external identities, then LDAP / OIDC / WebDAV (`AUTH_LOGIN_REDIRECT` moved next to OIDC).
  Settings that belong elsewhere but matter for sign-in say so (`PUBLIC_URL` for OIDC callbacks,
  `COOKIE_SECRET` for auth cookies). CORS & cookies, rate limiting and access control (ACL and
  row-level security, before in separate places) form SECURITY; the ApiClient's timeouts moved out
  of the API settings into their own section. No variable or value changed.
- The setup wizard and the Configuration wiki follow the same groups;
  the wizard writes new settings into that structure. A test fails when `.env.example` and the
  settings catalog disagree.

### Added — verification

- Opt-in integration tests against real servers (`npm run test:integration`: Redis 7, OpenLDAP,
  Keycloak 26 including its login form), set up by `__test__/integration/setup.sh`. Skipped in `npm test`.

### Fixed

- **Graceful close cut in-flight requests**: Fastify's default (`forceCloseConnections: 'idle'`)
  destroys all sockets on close; requests now finish and keep-alive sockets close with them.
- **Logout did not revoke cookie or custom-header sessions** — only `Authorization: Bearer`.
- **Cookie-only mode could never refresh** (the refresh token was never delivered).
- **Cookie strategy crashed without `COOKIE_SECRET`** (`unsignCookie` is not decorated then), and
  `setCookie` without an explicit `signed` threw for the same reason.
- **`LOG_LEVEL=finest` wrote passwords, tokens and auth headers to the access log** — now redacted.
- Login timing revealed whether an account exists (no bcrypt work for unknown users).
- Refresh looked users up by a hard-coded `id` column; it now uses the user model's primary key.
- After-delete hooks of soft deletes always saw `softDelete: false`.
- Production CORS blocked same-origin requests (pages served by the API posting back).
- Rate limiter gave up reconnecting to Redis after ~10 min (memory until restart) and could throw
  on shutdown; session store `destroy()` left the Redis connection open; timers kept tests alive.
- ApiClient: empty/malformed bodies turned HTTP errors into `SyntaxError`s (and were retried); a
  caller-provided `AbortSignal` disabled the timeout; concurrent OAuth token fetches; no 429 handling.
- `ErrorResponse` now exposes `statusCode` (Fastify, Sentry) and its class `name`; security headers
  respect a CSP the handler set; i18n renders object parameters as JSON; the `lang` cookie is
  validated against the allowed languages; the 404 body carries its `key`.

### Fixed — tooling

- `npx @rapidd/core build` always answered "@rapidd/build is not installed" (it looked for
  `bin/cli.js`; the package ships `dist/bin/cli.js`).
- MySQL / MariaDB connection strings with URL-encoded credentials (`p%40ss` for `p@ss`) failed to
  authenticate — user, password and database name are now decoded.
- `__test__/integration/setup.sh` seeded an empty LDIF into fresh OpenLDAP containers (`docker exec`
  without `-i` passes no stdin); PostgreSQL 16 joins the integration environment.

### Fixed — ORM (QueryBuilder / Model)

- **`upsertMany` on PostgreSQL misreported its result**: one failing record aborted the transaction,
  every later statement failed, and the commit rolled back — while the result reported updates.
  Writes now run under savepoints (one per chunk of records, replayed record by record when a chunk
  fails), so a bad record costs only itself and the report matches the database. Deadlocks,
  serialization conflicts and lost transactions fail the call instead of being reported as one
  record. MySQL/MariaDB are unchanged (they roll back only the failed statement). Verified on
  PostgreSQL: 20 000 mixed records in ~2.5 s.
- `upsertMany`: existence is looked up with one query per 1 000 keys and a Set (was O(n·m));
  composite keys failed outright (a compound selector in `findMany`); the bulk-insert path skipped
  omit / writable-field stripping; a key repeated within a batch was silently dropped (it now
  updates the row the batch created); rows `skipDuplicates` drops are reported as `skipped`.
- **Raw Prisma nested operations bypassed the related model's ACL** — `{ tags: { connect: [...] } }`
  could link records outside the access filter, `{ tags: { deleteMany: {} } }` deleted despite
  `getDeleteFilter: () => false`. They are now scoped or rejected like Rapidd's own shapes.
- Updates whose payload echoes the record's own id failed with "Unknown argument `id`" on models
  with an autoincrement key and a foreign key (Prisma's checked update input has no such id).
- Compound keys with a custom name (`@@id([a, b], name: "pk")`) and `@@unique` with another field
  order couldn't be addressed; models with a composite PK broke `upsert`/`upsertMany` with the
  default key.
- An object `q` (`getMany({ q: { courseId: 5 } })`) was silently ignored — no filter at all. It is
  now a set of field equality conditions, parsed by type and ACL-checked like the string form.
  This also restores the parent scoping of junction sub-routes generated by rapidd-build 2.3.0,
  which listed every parent's rows. Repeated `?q=` parameters were dropped; they are now AND-ed.
- Date-only filters were shifted by a day on servers west of UTC (see above).
- `upsert` passed the key's *name* as the parent id for nested n:m writes.

### Changed — ORM

- `get()` is one query when the record is found and permitted (was two in parallel); the
  existence check for 403-vs-404 only runs on a miss under a restricting access filter.
- `getMany()` runs data and count in parallel outside a transaction (was an interactive
  transaction: four sequential round trips instead of one); with RLS variables active it keeps a
  single transaction.
- Relation processing edits one working copy instead of copying the payload once per key.
- New: `getMany({ where })` — a trusted server-side scope AND-ed with the client filter and ACL;
  `model.parseKey(field, value)`; DMMF helper `compoundKeyName()`.
- `fields=posts.title` includes `posts` by itself — `include=posts` is no longer required (sending
  both is fine).

### Removed

- Mailer (see above) and the unused `luxon` dependency.

## [2.3.2] - 2026-07-17

Repairs rate limiting, which was not enforcing what `config/rate-limit.json` said it was — every
entry in that file was silently dead, including the one meant to protect login. Verified against a
real Redis and a real Fastify router.

> **Read before upgrading — two client-visible changes:**
> 1. Rate limits changed from **per-IP + path** to **per-IP + scope** (see *Rate limiting* below).
>    Limits are now stricter: a client spreading traffic across many endpoints previously got a
>    fresh budget per endpoint and now shares one. Clients relying on that may start seeing `429`s.
>    Review `config/rate-limit.json` before deploying.
> 2. **`X-RateLimit-Reset` now emits Unix seconds, not milliseconds.** If you have a client parsing
>    this header, it needs updating (drop any `/ 1000`).

### Fixed — rate limiting

Every entry in `config/rate-limit.json` was silently dead, and the shipped file left the login
route unprotected. Verified against a real Redis and a real Fastify router.

- **Path configs never matched, so no configured limit was ever applied.** Matching was an exact
  object lookup, so an entry only fired on a byte-identical path — i.e. only for routes that don't
  exist. `/api` never matched `/api/v1/users`; the login entry (`/api/v1/login`) never matched the
  real route (`/auth/login`), leaving login on the generic default of 100/15min instead of 10/15min.
  Matching is now **longest-prefix**: an entry governs its path and everything beneath it, most
  specific first, with a guard so `/api` cannot swallow a sibling like `/apidocs`.
- **A limit could be multiplied by spreading requests across endpoints.** Counting was keyed on the
  full request path, so every endpoint got its own private budget — an attacker enumerating N
  endpoints got N × the limit. Requests are now counted against the **matched entry**, making a
  config entry an aggregate cap over its whole subtree. Paths matching nothing share one default
  bucket per IP. **This is the behavior change called out above.**
- **A percent-encoded path bypassed a strict limit.** Fastify decodes before routing, so
  `POST /auth/log%69n` reaches the login handler (verified: HTTP 200) while the limiter saw the raw
  URL and bucketed it loosely — brute-force at 100/15min instead of 10. The scope now matches the
  decoded path, exactly once, mirroring the router.
- **Every request 500'd while Redis was connecting.** With `REDIS_HOST` set, the in-memory store was
  left `null` until a connection *error* fired, but requests arriving before Redis reached `ready`
  are served from memory — dereferencing null and throwing a `TypeError` on a completely healthy
  boot. The memory store is now always present.
- **A Redis blip 500'd in-flight requests.** An `EVAL` rejected after the `ready` check (failover,
  `MISCONF`, brief partition) escaped as an unhandled error instead of degrading. It now falls back
  to memory for that request.
- **Redis leaked a key per (IP, scope), forever.** The Lua script incremented a sibling `<key>:seq`
  to build unique sorted-set members but only ever set a TTL on the main key, so `:seq` keys
  accumulated without bound (verified: `TTL -1`). The member is now a caller-generated UUID —
  unique across instances, no extra key, and it gives the refund path a specific member to remove.
- **`maxRequests: 0` served 100 requests.** A configured `0` was treated as absent (`||`) and
  replaced by the default, so an entry meant to close a path left it open. `0` now blocks.
- **Options passed to `register()` were silently discarded.** The plugin was typed as accepting
  `{ maxRequests, windowMs, rateLimits }` but never read them — its signature took no options
  argument at all, so `register(plugin, { maxRequests: 2 })` typechecked and did nothing. Options
  are now honoured, and win over `config/rate-limit.json` and the environment.
- **Closing one app disabled another's limiter.** The plugin shared one process-wide limiter, and
  its `onClose` hook closed that shared instance — so building two apps in one process (or one per
  test) and closing either left the other holding a quit Redis connection, silently degrading to
  per-process memory. Each registration now owns its limiter.
- **The distributed limit depended on app servers' clocks agreeing.** Sorted-set scores came from
  each Node process's `Date.now()`, so an instance drifting by a full window had its entries treated
  as already expired by every other instance — its traffic stopped counting toward the limit at all.
  The window is now measured by Redis's own clock (`TIME`), making the limit independent of app
  server clocks. Verified by forcing an instance's clock 10 minutes behind: 0 requests leaked past.
- **`getRateLimiter` is exported** from the package entry. It was documented in the wiki but only
  exported from the plugin module, so the documented import did not resolve.
- **`X-RateLimit-Reset` emitted milliseconds where the convention is seconds.** A client doing the
  conventional `new Date(reset * 1000)` landed roughly 56,000 years in the future, and one backing
  off by `reset - now` waited ~1.8 billion seconds. It now emits Unix seconds. **Client-visible —
  see the upgrade note above.**

### Added — rate limiting
- **`Retry-After` on a 429.** Clients were told they'd been limited but not for how long, leaving
  them to guess or hammer. The response now carries `Retry-After` in delta-seconds (RFC 9110) —
  a duration rather than a date, so a clock difference between server and client can't skew it.
  Under Redis the value is measured by Redis's clock, so it stays correct even when an app
  instance's clock has drifted (verified with a local clock forced 10 minutes behind: still 60s).
- **`ignoreSuccessfulRequests` is implemented** (it was previously read by nothing — declared in the
  type, documented as "reserved for future use", and shipped as `true` in `config/rate-limit.json`,
  which implied a protection that did not exist). A request is charged up front, then refunded in an
  `onResponse` hook if the response was successful (status < 400) — a status code doesn't exist yet
  at `onRequest` time, which is why it could never have worked where it was being read. Only
  failures consume budget, so a login limit caps brute-force attempts without ever locking out a
  user who is signing in successfully.
- **Rate limiter accepts injectable config** (`new RateLimiter({ maxRequests, windowMs, rateLimits })`)
  so limits can be tested without depending on the contents of `config/rate-limit.json` — the gap
  that let all of the above pass a green suite. 8 tests → 22.

### Changed — rate limiting
- **`config/rate-limit.json` corrected.** The login entry is re-keyed from `/api/v1/login` to the
  real route `/auth/login`, and `ignoreSuccessfulRequests` is removed from the `/api` catch-all —
  now that the flag works, leaving it there would refund every successful API request and leave
  successful traffic entirely unmetered.

### Documentation
- **Every documented `@rapidd/core` import was unresolvable.** 15 examples across 10 wiki pages
  (Mailer, Authentication, Model-Middleware, Internationalization, File-Uploads, Access-Control,
  Deployment, Row-Level-Security, ApiClient, Rate-Limiting) told you to
  `import { Auth } from '@rapidd/core'` — but `@rapidd/core` is not a runtime dependency of a
  scaffolded project and does not appear in its `package.json`, so not one of them resolves. They
  now use relative paths into the vendored source (`./src/auth/Auth`, `./src/utils/Mailer`, …),
  matching the convention Getting-Started already used.
- **Rate-Limiting:** rewritten to match the fixed behavior — scope matching, aggregate budgets,
  `ignoreSuccessfulRequests`, the Redis-clock window, and configuring at `register()`.

## [2.3.1] - 2026-07-16

Follow-up to 2.3.0 fixing a scaffold-blocking bug and tightening what gets published. No runtime
API changes.

### Fixed
- **`create-project` produced a project that did not compile (release blocker).** The scaffolder's
  skip-list matched entries by **basename**, so the `user.ts` rule intended to exclude the generated
  `src/config/user.ts` also silently dropped the framework core file `src/core/user.ts`. A fresh
  project failed `tsc` with `Cannot find module './core/user'` (from `src/index.ts`,
  `src/orm/Model.ts`, `src/orm/QueryBuilder.ts`). The skip-list now matches **project-relative
  paths**, so a core file that merely shares a basename with an app-specific artifact is never dropped.

### Changed
- **npm tarball no longer ships the framework's own development application.** The `files` whitelist
  pulled in the dev `routes/` and `src/models/` (Student, Teacher, Course, Invoice, …) — ~60 domain
  files, quadrupling the tarball and leaking an internal domain model. `files` now enumerates the
  framework subtrees of `src/` explicitly (an explicit `files` entry overrides `.gitignore`), and
  `routes/` is dropped. The published package is framework-only (61 files, 0 domain files).
- **`engines.node` relaxed** from `>=24.0.0` to `^22.12.0 || >=24.0.0`. There is no Node 24-only
  dependency; the real floor is Prisma 7's requirement (it uses `require(esm)`, unflagged only
  from Node 22.12), so Node 22 LTS (≥22.12) is now supported. Node 20 is **not** supported — it
  reached end-of-life on 2026-04-30. Generated projects inherit this via `create-project`.

### Documentation
- **Getting-Started:** added an **Architecture & Updates** section documenting the vendored-framework
  model — what `create-project` copies, why `@rapidd/core` is not a runtime dependency, and how to
  adopt upstream framework fixes (diff against a fresh scaffold; bump `@rapidd/build`). Corrected the
  Node prerequisite to match the relaxed `engines`.
- **README:** the Packages table now describes `@rapidd/core` accurately — a project template plus
  `npx rapidd` CLI that scaffolds the framework **source** into your project, not a "framework
  runtime." Added a short "you own the code" note with the upgrade trade-off.

## [2.3.0] - 2026-07-16

### Added
- **Single sort parameter:** `?sort=field:order` (e.g. `sort=name:desc`), replacing the two-field
  `sortBy` / `sortOrder`. No legacy fallback.
- **Boolean filter groups:** `OR(...)` / `AND(...)`, nestable and case-insensitive, in `?q=` /
  `?filter=`.
- **Field-level write control:** `getWritableFields` ACL method with `strictWrites` — the REST edge
  rejects writes to restricted fields (403), while internal/trusted calls silently strip them.
- **`COOKIE_SAME_SITE`** environment variable (default `strict`).
- **Optional config-defined default user** (`src/config/user.ts`) for trusted internal work.

### Changed
- **System / default user redesigned.** Replaced the hardcoded `{ id: 'system', role: 'application' }`
  — which wrongly assumed a string primary key and a valid role enum value — with a non-forgeable,
  `Symbol`-based, identity-less bypass (both `id` and `role` are `null`). Removed the
  `RAPIDD_SYSTEM_ROLE` environment variable.
- **No implicit default sort.** The previous `id:asc` default is gone (it could break on tables
  whose ordering it didn't suit); results are unordered unless you pass `sort`.

### Fixed
- **Filtering and sorting now respect ACL-omitted fields** — a client can no longer filter or sort
  by a field they're restricted from reading.
- **Write responses apply `omit`** — create / update / upsert no longer echo hidden fields (e.g. a
  hashed password) back to the client.
- **Write-only fields survive create payloads** — a required, read-hidden field (e.g. `password`) is
  no longer stripped before insert.
- **Optional to-one includes enforce ACL** (they resolve to `null` when access is denied).
- **Numeric `between:` with a single value returns 400** (`between_requires_two_values`) instead of
  crashing with a 500.
- **System-user bypass is now consistent** across nested creates and read-side field omission.

[2.3.2]: https://github.com/MertDalbudak/rapidd/releases/tag/v2.3.2
[2.3.1]: https://github.com/MertDalbudak/rapidd/releases/tag/v2.3.1
[2.3.0]: https://github.com/MertDalbudak/rapidd/releases/tag/v2.3.0
