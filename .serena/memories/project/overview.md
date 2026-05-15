# Flash Backend Project Overview

## Purpose
Flash is a traffic monitoring application that captures live video streams from verkeerscentrum.be (Flemish traffic authority), detects vehicles with YOLOv8, and displays results on a dashboard.

## Tech Stack
- **Runtime**: Node.js with TypeScript
- **Package Manager**: pnpm (v10.28.0) - NOT npm
- **Framework**: Fastify v4.28.1 with CORS support
- **Database ORM**: Prisma v5.14.0 (PostgreSQL)
- **Testing**: Vitest v1.6.0
- **Build**: TypeScript, tsx for development

## Directory Structure
```
backend/
├── src/
│   ├── index.ts          (Fastify app entry point)
│   ├── config.ts         (configuration)
│   ├── db.ts             (Prisma client)
│   └── routes/           (API route handlers)
├── tests/                (test files)
├── prisma/               (schema and migrations)
└── package.json
```

## Code Style & Conventions
- **Language**: TypeScript with strict mode enabled
- **Module System**: CommonJS
- **Target**: ES2022
- **Type Hints**: Full strict TypeScript
- **Naming**: camelCase for functions/variables, PascalCase for types/classes
- **Async Patterns**: Async/await, Promise-based
- **Export Style**: Named exports preferred (e.g., `export async function buildApp`)

## Development Workflow
1. Uses Prisma for database schema management
2. Uses Fastify for HTTP API
3. Routes are modular, organized in `/routes` directory
4. Full TypeScript strict mode compilation

## Important Notes
- Uses **pnpm** exclusively (not npm or yarn)
- Strict TypeScript compilation required
- Project includes Docker setup
- Environment variables loaded from `.env` files
