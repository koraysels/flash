FROM nvidia/cuda:12.8.0-cudnn-runtime-ubuntu22.04

# Node.js 22 + jellyfin-ffmpeg7 (a modern, NVENC-enabled standalone ffmpeg build —
# NOT the media server; installs only ffmpeg/ffprobe under /usr/lib/jellyfin-ffmpeg)
# + openssl for Prisma. Distro ffmpeg (4.4) lacks -fps_mode and has weaker NVENC.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl gnupg ca-certificates openssl python-is-python3 fonts-dejavu-core \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/ubuntu jammy main" > /etc/apt/sources.list.d/jellyfin.list \
    && apt-get update && apt-get install -y --no-install-recommends jellyfin-ffmpeg7 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

# Download onnxruntime-node's CUDA 12 execution-provider binaries (not bundled in
# the npm package — too large for the registry). Without this the backend silently
# runs ONNX on CPU and the requested 'cuda' provider crashes/falls back.
ENV ONNXRUNTIME_NODE_INSTALL=cuda12

# NVENC (h264_nvenc) needs the `video` driver capability; the CUDA base only sets compute,utility.
ENV NVIDIA_DRIVER_CAPABILITIES=all
ENV NVIDIA_VISIBLE_DEVICES=all

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

# Generate Prisma client for debian-openssl-3.0.x (already in binaryTargets)
RUN pnpm --filter flash-backend exec prisma generate

WORKDIR /app/backend

EXPOSE 3001

# models/ is a named volume — download traffic_detector.onnx on first start if absent.
# Migrate then start. DATABASE_URL must be set at runtime.
CMD ["sh", "-c", "\
  mkdir -p models && \
  [ -f models/traffic_detector.onnx ] || curl -fsSL -o models/traffic_detector.onnx \
    https://github.com/koraysels/flash/releases/download/v0.1.0-models/traffic_detector.onnx && \
  pnpm exec prisma migrate deploy && \
  pnpm exec tsx src/index.ts"]
