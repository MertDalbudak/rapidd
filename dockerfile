# The image holds what the server loads, for one database: the datasource provider in
# prisma/schema.prisma decides the driver (postgresql → @prisma/adapter-pg + pg,
# mysql → @prisma/adapter-mariadb + mariadb). `--build-arg DATABASE_PROVIDER=postgresql|mysql`
# overrides it.

# Stage 1: Install all dependencies, generate the Prisma client, build TypeScript
FROM node:current-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# The Prisma CLI of the lockfile writes the client to prisma/client
COPY prisma ./prisma
RUN npx prisma generate --generator client

COPY tsconfig.json ./
COPY main.ts ./
COPY src ./src
COPY routes ./routes

RUN npx tsc

# Stage 2: Production dependencies — the driver of one database, no build tools
FROM node:current-alpine AS deps

ARG DATABASE_PROVIDER

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma

# Without devDependencies npm also leaves out what @prisma/client lists as optional peers (the
# Prisma CLI with Studio, TypeScript). The generated client carries its own query compiler, so
# the copies in @prisma/client for other databases are removed.
RUN provider="${DATABASE_PROVIDER:-$(sed -n '/^datasource/,/}/s/^[[:space:]]*provider[[:space:]]*=[[:space:]]*"\([a-z]*\)".*/\1/p' prisma/schema.prisma)}" && \
    case "$provider" in \
        postgresql) unused='dependencies.@prisma/adapter-mariadb' ;; \
        mysql) unused='dependencies.@prisma/adapter-pg dependencies.pg' ;; \
        *) echo "Database provider '$provider' is not supported: set the datasource provider in prisma/schema.prisma to postgresql or mysql, or build with --build-arg DATABASE_PROVIDER=postgresql|mysql" >&2; exit 1 ;; \
    esac && \
    echo "Database: $provider" && \
    npm pkg delete devDependencies $unused && \
    npm ci --omit=dev --no-audit --no-fund && \
    npm cache clean --force && \
    find node_modules/@prisma/client/runtime -name 'query_compiler_*' ! -name "*.$provider.*" -delete

# Stage 3: Runtime (minimal)
FROM node:current-alpine AS runtime

RUN apk upgrade --no-cache && rm -rf /var/cache/apk/*

RUN addgroup -g 1001 -S nodejs && \
    adduser -S rapidd -u 1001

WORKDIR /app

# Production node_modules; package.json lists what is installed
COPY --from=deps --chown=rapidd:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=rapidd:nodejs /app/package.json ./package.json

# Prisma schema + generated client
COPY --from=builder --chown=rapidd:nodejs /app/prisma ./prisma

# Compiled TypeScript output
COPY --from=builder --chown=rapidd:nodejs /app/dist ./dist

# Runtime assets
COPY --chown=rapidd:nodejs config ./config
COPY --chown=rapidd:nodejs locales ./locales
COPY --chown=rapidd:nodejs public ./public

RUN mkdir -p /app/uploads /app/temp/uploads /app/logs /app/data && \
    chown -R rapidd:nodejs /app/uploads /app/temp /app/logs /app/data

# The setup wizard (first start without configuration, or `docker run … <image> setup`) saves
# its settings here — keep it on a volume. Orchestrated deployments pass settings as
# environment variables instead (and may set SETUP_WIZARD=off to fail fast when one is missing).
ENV ENV_FILE=/app/data/.env

VOLUME ["/app/uploads", "/app/logs", "/app/data"]

USER rapidd

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "dist/main.js"]
