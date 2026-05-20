FROM nvidia/cuda:12.8.0-cudnn-runtime-ubuntu22.04

# Node.js 22 + ffmpeg for HLS capture + openssl for Prisma
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates ffmpeg openssl python-is-python3 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

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

# Model weights (gitignored — download from GitHub release)
RUN mkdir -p /app/backend/models && \
    curl -fsSL -o /app/backend/models/traffic_detector.onnx \
    https://github.com/koraysels/flash/releases/download/v0.1.0-models/traffic_detector.onnx

# Generate Prisma client for debian-openssl-3.0.x (already in binaryTargets)
RUN pnpm --filter flash-backend exec prisma generate

WORKDIR /app/backend

EXPOSE 3001

# Migrate then start. DATABASE_URL must be set at runtime.
# tsx is used at runtime because the AI worker is spawned as a .ts file.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm exec tsx src/index.ts"]
