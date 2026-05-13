# Flash — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up the Docker Compose stack, PostgreSQL database with Prisma, Camera CRUD REST API (Fastify), and a React frontend shell with routing and camera management UI.

**Architecture:** Monorepo with `backend/` (Node.js/TypeScript, Fastify, Prisma) and `frontend/` (React, Vite, Tailwind, shadcn/ui). Both run as Docker Compose services alongside PostgreSQL. No AI or streaming yet — just camera config management.

**Tech Stack:** Node.js 20, TypeScript 5, Fastify 4, Prisma 5, PostgreSQL 16, React 18, Vite 5, Tailwind CSS 3, shadcn/ui, React Router 6, TanStack Query 5, Vitest

---

## File Map

```
flash/
├── docker-compose.yml
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   ├── prisma/
│   │   └── schema.prisma
│   └── src/
│       ├── index.ts              # Fastify server bootstrap
│       ├── config.ts             # Env var validation
│       ├── db.ts                 # Prisma client singleton
│       └── routes/
│           └── cameras.ts        # GET/POST/PUT/DELETE /api/cameras
│   └── tests/
│       └── routes/
│           └── cameras.test.ts
├── frontend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx               # Router setup
│       ├── lib/
│       │   └── api.ts            # fetch wrapper for /api/*
│       ├── hooks/
│       │   └── useCameras.ts     # TanStack Query hooks
│       └── pages/
│           ├── Dashboard.tsx     # / — placeholder grid
│           └── Cameras.tsx       # /cameras — list + add + delete
```

---

## Task 1: Initialize project structure

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`

- [ ] **Step 1: Create backend package.json**

```json
{
  "name": "flash-backend",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "db:migrate": "prisma migrate dev",
    "db:generate": "prisma generate"
  },
  "dependencies": {
    "@fastify/cors": "^9.0.1",
    "@prisma/client": "^5.14.0",
    "fastify": "^4.28.1"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "prisma": "^5.14.0",
    "tsx": "^4.15.7",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

Save to `backend/package.json`.

- [ ] **Step 2: Create backend tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests"],
  "exclude": ["node_modules", "dist"]
}
```

Save to `backend/tsconfig.json`.

- [ ] **Step 3: Create frontend package.json**

```json
{
  "name": "flash-frontend",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.45.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.24.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.39",
    "tailwindcss": "^3.4.4",
    "typescript": "^5.4.5",
    "vite": "^5.3.1"
  }
}
```

Save to `frontend/package.json`.

- [ ] **Step 4: Create frontend tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Save to `frontend/tsconfig.json`.

- [ ] **Step 5: Create frontend vite.config.ts**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
```

Save to `frontend/vite.config.ts`.

- [ ] **Step 6: Create frontend/index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Flash — Traffic Monitor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Install backend dependencies**

```bash
cd backend && npm install
```

- [ ] **Step 8: Install frontend dependencies**

```bash
cd frontend && npm install
```

- [ ] **Step 9: Commit**

```bash
git add backend/package.json backend/tsconfig.json frontend/package.json frontend/tsconfig.json frontend/vite.config.ts frontend/index.html
git commit -m "feat: initialize backend and frontend project structure"
```

---

## Task 2: Prisma schema + Docker Compose

**Files:**
- Create: `backend/prisma/schema.prisma`
- Create: `backend/.env.example`
- Create: `docker-compose.yml`
- Create: `backend/src/db.ts`

- [ ] **Step 1: Create Prisma schema**

```prisma
// backend/prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Camera {
  id                String    @id @default(cuid())
  name              String
  location          String
  streamUrl         String
  active            Boolean   @default(true)
  maxSpeedKmh       Int?
  homographyMatrix  Float[]
  calibrationPoints Json?
  countingLineA     Float     @default(0.4)
  countingLineB     Float     @default(0.6)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  trafficEvents     TrafficEvent[]
  dailyCounts       DailyCount[]
}

model TrafficEvent {
  id           String   @id @default(cuid())
  cameraId     String
  camera       Camera   @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  timestamp    DateTime @default(now())
  direction    String
  vehicleClass String
  speedKmh     Float?
  isSpeeder    Boolean  @default(false)

  @@index([cameraId, timestamp])
}

model DailyCount {
  id           String   @id @default(cuid())
  cameraId     String
  camera       Camera   @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  date         DateTime
  directionAB  Int      @default(0)
  directionBA  Int      @default(0)
  speeders     Int      @default(0)

  @@unique([cameraId, date])
}
```

- [ ] **Step 2: Create backend .env.example**

```
DATABASE_URL=postgresql://flash:flash@localhost:5432/flash
PORT=3001
```

Save to `backend/.env.example`. Also copy to `backend/.env` for local dev.

- [ ] **Step 3: Create docker-compose.yml**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: flash
      POSTGRES_PASSWORD: flash
      POSTGRES_DB: flash
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  backend:
    build: ./backend
    environment:
      DATABASE_URL: postgresql://flash:flash@postgres:5432/flash
      PORT: 3001
    ports:
      - "3001:3001"
    depends_on:
      - postgres
    volumes:
      - ./backend/src:/app/src

  frontend:
    build: ./frontend
    ports:
      - "80:80"
    depends_on:
      - backend

volumes:
  postgres_data:
```

Save to `docker-compose.yml`.

- [ ] **Step 4: Create backend/src/db.ts**

```typescript
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const db = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
```

- [ ] **Step 5: Initialize Prisma and run migration**

```bash
cd backend
npx prisma generate
npx prisma migrate dev --name init
```

Expected output: `✔ Generated Prisma Client` and `Database migrations applied`

- [ ] **Step 6: Commit**

```bash
git add backend/prisma/ backend/.env.example backend/src/db.ts docker-compose.yml
git commit -m "feat: add Prisma schema and Docker Compose"
```

---

## Task 3: Fastify server + Camera CRUD API

**Files:**
- Create: `backend/src/config.ts`
- Create: `backend/src/index.ts`
- Create: `backend/src/routes/cameras.ts`
- Create: `backend/tests/routes/cameras.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// backend/tests/routes/cameras.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../../src/index'
import { db } from '../../src/db'

describe('Camera routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    await db.$disconnect()
  })

  beforeEach(async () => {
    await db.camera.deleteMany()
  })

  it('GET /api/cameras returns empty array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/cameras' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('POST /api/cameras creates a camera', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cameras',
      payload: { name: 'Test Cam', location: 'Gent', streamUrl: 'https://example.com/stream' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.name).toBe('Test Cam')
    expect(body.id).toBeDefined()
  })

  it('DELETE /api/cameras/:id removes camera', async () => {
    const camera = await db.camera.create({
      data: { name: 'Del Cam', location: 'Brussel', streamUrl: 'https://example.com' },
    })
    const res = await app.inject({ method: 'DELETE', url: `/api/cameras/${camera.id}` })
    expect(res.statusCode).toBe(204)
    const found = await db.camera.findUnique({ where: { id: camera.id } })
    expect(found).toBeNull()
  })

  it('PUT /api/cameras/:id updates maxSpeedKmh', async () => {
    const camera = await db.camera.create({
      data: { name: 'Speed Cam', location: 'Antwerpen', streamUrl: 'https://example.com' },
    })
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cameras/${camera.id}`,
      payload: { maxSpeedKmh: 50 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).maxSpeedKmh).toBe(50)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npm test
```

Expected: FAIL — `buildApp` is not exported

- [ ] **Step 3: Create backend/src/config.ts**

```typescript
export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  databaseUrl: process.env.DATABASE_URL ?? '',
}
```

- [ ] **Step 4: Create backend/src/routes/cameras.ts**

```typescript
import { FastifyInstance } from 'fastify'
import { db } from '../db'

export async function cameraRoutes(app: FastifyInstance) {
  app.get('/api/cameras', async () => {
    return db.camera.findMany({ orderBy: { createdAt: 'asc' } })
  })

  app.post<{
    Body: { name: string; location: string; streamUrl: string; maxSpeedKmh?: number }
  }>('/api/cameras', async (req, reply) => {
    const camera = await db.camera.create({ data: req.body })
    reply.code(201)
    return camera
  })

  app.put<{
    Params: { id: string }
    Body: Partial<{
      name: string
      location: string
      streamUrl: string
      maxSpeedKmh: number | null
      active: boolean
      homographyMatrix: number[]
      calibrationPoints: unknown
      countingLineA: number
      countingLineB: number
    }>
  }>('/api/cameras/:id', async (req, reply) => {
    const camera = await db.camera.update({
      where: { id: req.params.id },
      data: req.body,
    })
    return camera
  })

  app.delete<{ Params: { id: string } }>('/api/cameras/:id', async (req, reply) => {
    await db.camera.delete({ where: { id: req.params.id } })
    reply.code(204)
  })

  app.get<{ Params: { id: string } }>('/api/cameras/:id/stats', async (req) => {
    const counts = await db.dailyCount.findMany({
      where: { cameraId: req.params.id },
      orderBy: { date: 'desc' },
      take: 30,
    })
    return counts
  })
}
```

- [ ] **Step 5: Create backend/src/index.ts**

```typescript
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { cameraRoutes } from './routes/cameras'
import { config } from './config'

export async function buildApp() {
  const app = Fastify({ logger: true })
  await app.register(cors, { origin: true })
  await app.register(cameraRoutes)
  return app
}

if (require.main === module) {
  buildApp().then((app) => {
    app.listen({ port: config.port, host: '0.0.0.0' }, (err) => {
      if (err) process.exit(1)
    })
  })
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd backend && npm test
```

Expected: 4 tests pass

- [ ] **Step 7: Commit**

```bash
git add backend/src/ backend/tests/
git commit -m "feat: add Fastify server and Camera CRUD API"
```

---

## Task 4: React frontend shell

**Files:**
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/lib/api.ts`
- Create: `frontend/src/hooks/useCameras.ts`
- Create: `frontend/src/pages/Dashboard.tsx`
- Create: `frontend/src/pages/Cameras.tsx`
- Create: `frontend/tailwind.config.js`
- Create: `frontend/postcss.config.js`

- [ ] **Step 1: Create Tailwind config**

```javascript
// frontend/tailwind.config.js
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
```

```javascript
// frontend/postcss.config.js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}
```

- [ ] **Step 2: Create frontend/src/main.tsx**

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './index.css'

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
)
```

- [ ] **Step 3: Create frontend/src/index.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 4: Create frontend/src/App.tsx**

```typescript
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import Dashboard from './pages/Dashboard'
import Cameras from './pages/Cameras'

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-950 text-gray-100">
        <nav className="border-b border-gray-800 px-6 py-3 flex gap-6 items-center">
          <span className="font-bold text-lg tracking-tight">Flash</span>
          <NavLink
            to="/"
            end
            className={({ isActive }) => isActive ? 'text-blue-400' : 'text-gray-400 hover:text-white'}
          >
            Dashboard
          </NavLink>
          <NavLink
            to="/cameras"
            className={({ isActive }) => isActive ? 'text-blue-400' : 'text-gray-400 hover:text-white'}
          >
            Cameras
          </NavLink>
        </nav>
        <main className="p-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/cameras" element={<Cameras />} />
            <Route path="/display/:cameraId" element={<div>Pi Display — Plan 3</div>} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
```

- [ ] **Step 5: Create frontend/src/lib/api.ts**

```typescript
const BASE = '/api'

export type Camera = {
  id: string
  name: string
  location: string
  streamUrl: string
  active: boolean
  maxSpeedKmh: number | null
  homographyMatrix: number[]
  calibrationPoints: unknown
  countingLineA: number
  countingLineB: number
  createdAt: string
  updatedAt: string
}

export async function getCameras(): Promise<Camera[]> {
  const res = await fetch(`${BASE}/cameras`)
  if (!res.ok) throw new Error('Failed to fetch cameras')
  return res.json()
}

export async function createCamera(data: Pick<Camera, 'name' | 'location' | 'streamUrl'>): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to create camera')
  return res.json()
}

export async function updateCamera(id: string, data: Partial<Camera>): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to update camera')
  return res.json()
}

export async function deleteCamera(id: string): Promise<void> {
  const res = await fetch(`${BASE}/cameras/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete camera')
}
```

- [ ] **Step 6: Create frontend/src/hooks/useCameras.ts**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getCameras, createCamera, updateCamera, deleteCamera, Camera } from '../lib/api'

export function useCameras() {
  return useQuery({ queryKey: ['cameras'], queryFn: getCameras })
}

export function useCreateCamera() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: createCamera,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cameras'] }),
  })
}

export function useUpdateCamera() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Camera> }) => updateCamera(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cameras'] }),
  })
}

export function useDeleteCamera() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteCamera,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cameras'] }),
  })
}
```

- [ ] **Step 7: Create frontend/src/pages/Dashboard.tsx**

```typescript
import { useCameras } from '../hooks/useCameras'

export default function Dashboard() {
  const { data: cameras, isLoading } = useCameras()

  if (isLoading) return <div className="text-gray-500">Loading...</div>

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Live Traffic</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {cameras?.map((cam) => (
          <div key={cam.id} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <div className="flex justify-between items-start mb-2">
              <div>
                <p className="font-semibold">{cam.name}</p>
                <p className="text-sm text-gray-400">{cam.location}</p>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full ${cam.active ? 'bg-green-900 text-green-400' : 'bg-red-900 text-red-400'}`}>
                {cam.active ? 'Live' : 'Offline'}
              </span>
            </div>
            <div className="bg-gray-800 rounded-lg aspect-video flex items-center justify-center text-gray-600 text-sm">
              Live feed — Plan 2
            </div>
          </div>
        ))}
        {cameras?.length === 0 && (
          <p className="text-gray-500 col-span-full">No cameras yet. Add one in <a href="/cameras" className="text-blue-400 underline">Cameras</a>.</p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 8: Create frontend/src/pages/Cameras.tsx**

```typescript
import { useState } from 'react'
import { useCameras, useCreateCamera, useDeleteCamera } from '../hooks/useCameras'

export default function Cameras() {
  const { data: cameras, isLoading } = useCameras()
  const createCamera = useCreateCamera()
  const deleteCamera = useDeleteCamera()

  const [form, setForm] = useState({ name: '', location: '', streamUrl: '' })
  const [showForm, setShowForm] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await createCamera.mutateAsync(form)
    setForm({ name: '', location: '', streamUrl: '' })
    setShowForm(false)
  }

  if (isLoading) return <div className="text-gray-500">Loading...</div>

  return (
    <div className="max-w-3xl">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Camera Management</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium"
        >
          + Add camera
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6 space-y-4">
          <h2 className="font-semibold">New camera</h2>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Name</label>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
              placeholder="E17 Kortrijk"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Location</label>
            <input
              required
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
              placeholder="Kortrijk"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Stream URL (from verkeerscentrum.be)</label>
            <input
              required
              value={form.streamUrl}
              onChange={(e) => setForm({ ...form, streamUrl: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono"
              placeholder="https://www.verkeerscentrum.be/camerabeelden/..."
            />
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={createCamera.isPending} className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-medium">
              {createCamera.isPending ? 'Saving...' : 'Save'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {cameras?.map((cam) => (
          <div key={cam.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex justify-between items-center">
            <div>
              <p className="font-medium">{cam.name}</p>
              <p className="text-sm text-gray-400">{cam.location}</p>
              {cam.maxSpeedKmh && (
                <p className="text-xs text-orange-400 mt-1">Max speed: {cam.maxSpeedKmh} km/u</p>
              )}
            </div>
            <div className="flex gap-2">
              <a
                href={`/cameras/${cam.id}/calibrate`}
                className="text-sm text-gray-400 hover:text-white px-3 py-1 rounded-lg border border-gray-700 hover:border-gray-500"
              >
                Calibrate
              </a>
              <button
                onClick={() => deleteCamera.mutate(cam.id)}
                className="text-sm text-red-400 hover:text-red-300 px-3 py-1 rounded-lg border border-red-900 hover:border-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 9: Start dev servers and verify UI works**

```bash
# Terminal 1 — start postgres
docker compose up postgres -d

# Terminal 2 — start backend
cd backend && npm run dev

# Terminal 3 — start frontend
cd frontend && npm run dev
```

Open `http://localhost:5173`. Verify: nav renders, Dashboard shows empty state, Cameras page lets you add and delete a camera.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/ frontend/tailwind.config.js frontend/postcss.config.js
git commit -m "feat: add React shell with Dashboard and Camera management UI"
```

---

## Task 5: Backend Dockerfiles

**Files:**
- Create: `backend/Dockerfile`
- Create: `frontend/Dockerfile`
- Create: `frontend/nginx.conf`

- [ ] **Step 1: Create backend/Dockerfile**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create frontend/nginx.conf**

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location /api/ {
        proxy_pass http://backend:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

- [ ] **Step 3: Create frontend/Dockerfile**

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

- [ ] **Step 4: Test full Docker Compose stack**

```bash
docker compose up --build
```

Expected: all 3 services start, frontend accessible at `http://localhost:80`.

- [ ] **Step 5: Commit**

```bash
git add backend/Dockerfile frontend/Dockerfile frontend/nginx.conf
git commit -m "feat: add production Dockerfiles for backend and frontend"
```
