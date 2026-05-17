FROM node:20-slim

# ffmpeg for HLS capture, openssl for Prisma
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg openssl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Workspace manifests — all three needed for pnpm workspace resolution
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Install backend deps only (frontend skipped)
RUN pnpm install --frozen-lockfile --filter flash-backend

# Source + assets
COPY backend/src ./backend/src
COPY backend/tsconfig.json ./backend/
COPY backend/prisma ./backend/prisma
COPY backend/models ./backend/models

# Generate Prisma client for debian-openssl-3.0.x (already in binaryTargets)
RUN pnpm --filter flash-backend exec prisma generate

WORKDIR /app/backend

EXPOSE 3001

# Migrate then start. DATABASE_URL must be set at runtime.
# tsx is used at runtime because the AI worker is spawned as a .ts file.
CMD ["sh", "-c", "npx prisma migrate deploy && node /app/node_modules/.bin/tsx src/index.ts"]
