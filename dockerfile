# Stage 1: Builder
FROM node:lts-alpine AS builder

WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm prune --production && npm cache clean --force

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy all files
COPY . .

# Stage 2: Runtime
FROM node:lts-alpine

WORKDIR /app

# Copy everything from builder stage
COPY --from=builder /app /app

# Update packages and clean cache
RUN apk update && apk upgrade --no-cache && rm -rf /var/cache/apk/*

ENTRYPOINT ["npm", "start"]