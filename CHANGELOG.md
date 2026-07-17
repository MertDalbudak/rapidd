# Changelog

All notable changes to `@rapidd/core` are documented here. This project follows
[Semantic Versioning](https://semver.org/). Because Rapidd is a
[vendored framework](https://github.com/MertDalbudak/rapidd/wiki/Getting-Started#architecture--updates)
(the framework source is copied into your project rather than installed), framework fixes below
do **not** reach existing projects via `npm update` — see the linked section for how to adopt them.

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
