# Stage 1: Install all dependencies and build TypeScript
FROM node:current-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY main.ts ./
COPY src ./src
COPY routes ./routes

RUN npx tsc

# Stage 2: Production dependencies + Prisma client
FROM node:current-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY prisma ./prisma
RUN npx prisma generate --generator client

# Stage 3: Runtime
FROM node:24-alpine

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && \
    adduser -S rapidd -u 1001

# Production node_modules with Prisma client
COPY --from=deps --chown=rapidd:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=rapidd:nodejs /app/package.json ./package.json

# Prisma schema + generated client
COPY --from=deps --chown=rapidd:nodejs /app/prisma ./prisma

# Compiled TypeScript output
COPY --from=builder --chown=rapidd:nodejs /app/dist ./dist

# Runtime assets
COPY --chown=rapidd:nodejs config ./config
COPY --chown=rapidd:nodejs locales ./locales
COPY --chown=rapidd:nodejs templates ./templates
COPY --chown=rapidd:nodejs public ./public

RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*

USER rapidd

EXPOSE 3000

ENTRYPOINT ["node", "dist/main.js"]
