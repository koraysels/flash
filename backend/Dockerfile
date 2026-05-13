FROM node:20-alpine
RUN apk add --no-cache openssl
RUN npm install -g pnpm
WORKDIR /app

# Copy root workspace files
COPY pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy package.json files for all workspace packages
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy backend scripts for model download
COPY backend/scripts ./backend/scripts
COPY backend/tsconfig.json ./backend/

# Download ML model
RUN pnpm --filter flash-backend run download-model

# Copy prisma schema
COPY backend/prisma ./backend/prisma

# Generate prisma client
RUN pnpm --filter flash-backend exec prisma generate

# Copy backend source
COPY backend/src ./backend/src

# Build backend
RUN pnpm --filter flash-backend run build

WORKDIR /app/backend
EXPOSE 3001
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 && chown -R nodejs:nodejs /app
USER nodejs
CMD ["node", "dist/src/index.js"]
