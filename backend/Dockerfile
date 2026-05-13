FROM node:20-alpine
RUN npm install -g pnpm
WORKDIR /app

# Copy root workspace files
COPY pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy package.json files for all workspace packages
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy prisma schema
COPY backend/prisma ./backend/prisma

# Generate prisma client
RUN pnpm --filter flash-backend exec prisma generate

# Copy backend source
COPY backend/src ./backend/src
COPY backend/tsconfig.json ./backend/

# Build backend
RUN pnpm --filter flash-backend run build

WORKDIR /app/backend
EXPOSE 3001
CMD ["node", "dist/index.js"]
