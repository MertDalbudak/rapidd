# Stage 1: Builder
FROM node:lts-alpine AS builder

WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy Prisma schema and generate client for Alpine Linux
COPY prisma ./prisma
RUN npx prisma generate --generator client

# Stage 2: Runtime
FROM node:lts-alpine

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S rapidd -u 1001

# Copy only production dependencies from builder
COPY --from=builder --chown=rapidd:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=rapidd:nodejs /app/package.json ./package.json

# Copy Prisma schema and generated client from builder
COPY --from=builder --chown=rapidd:nodejs /app/prisma ./prisma

# Copy only necessary application files
COPY --chown=rapidd:nodejs main.js ./
COPY --chown=rapidd:nodejs lib ./lib
COPY --chown=rapidd:nodejs src ./src
COPY --chown=rapidd:nodejs routes ./routes
COPY --chown=rapidd:nodejs public ./public
COPY --chown=rapidd:nodejs strings ./strings
COPY --chown=rapidd:nodejs config ./config
COPY --chown=rapidd:nodejs data ./data

# Create logs directory with proper permissions
RUN mkdir -p logs && chown -R rapidd:nodejs logs

# Update packages and clean cache
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*

# Switch to non-root user
USER rapidd

# Expose port (adjust if your app uses a different port)
EXPOSE 80

# Use exec form for proper signal handling
ENTRYPOINT ["node", "main.js"]