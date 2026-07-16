# Changelog

All notable changes to `@rapidd/core` are documented here. This project follows
[Semantic Versioning](https://semver.org/). Because Rapidd is a
[vendored framework](https://github.com/MertDalbudak/rapidd/wiki/Getting-Started#architecture--updates)
(the framework source is copied into your project rather than installed), framework fixes below
do **not** reach existing projects via `npm update` — see the linked section for how to adopt them.

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

[2.3.1]: https://github.com/MertDalbudak/rapidd/releases/tag/v2.3.1
[2.3.0]: https://github.com/MertDalbudak/rapidd/releases/tag/v2.3.0
