# Flash — Plan 2: Stream Capture

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture live HLS video streams from verkeerscentrum.be using yt-dlp + FFmpeg, extract JPEG frames, and distribute them in real-time to connected browser clients via Socket.io. After this plan the Dashboard shows live camera feeds.

**Architecture:** A `StreamExtractor` resolves the real HLS URL from the camera's page URL using yt-dlp. A `FrameCapturer` uses FFmpeg to decode the stream and emit JPEG frames at 2fps. A `CameraWorker` orchestrates one extractor + capturer per active camera. A Socket.io server broadcasts frames to all connected clients. The frontend `LiveFeed` component renders incoming frames on a `<canvas>`.

**Tech Stack:** yt-dlp (Docker binary), fluent-ffmpeg, ffmpeg-static, socket.io (server + client), React canvas

**Prerequisites:** Plan 1 complete (Docker Compose, Prisma, Camera CRUD, React shell)

---

## File Map

```
backend/src/
├── stream/
│   ├── extractor.ts        # yt-dlp: camera page URL → HLS m3u8 URL
│   └── capturer.ts         # FFmpeg: m3u8 → JPEG frame buffers at 2fps
├── socket/
│   └── server.ts           # Socket.io server, per-camera rooms
└── camera-worker.ts        # Manages one stream pipeline per camera

frontend/src/
├── lib/
│   └── socket.ts           # Socket.io client singleton
├── hooks/
│   └── useCameraFeed.ts    # Subscribe to frames for one cameraId
└── components/
    └── LiveFeed.tsx         # <canvas> that renders JPEG frames
```

---

## Task 1: yt-dlp stream extractor

**Files:**
- Create: `backend/src/stream/extractor.ts`
- Create: `backend/tests/stream/extractor.test.ts`

- [ ] **Step 1: Add yt-dlp to backend dependencies**

Add to `backend/package.json` dependencies:
```json
"yt-dlp-exec": "^1.0.2"
```

Then run:
```bash
cd backend && npm install
```

- [ ] **Step 2: Write failing test**

```typescript
// backend/tests/stream/extractor.test.ts
import { describe, it, expect, vi } from 'vitest'
import { extractStreamUrl } from '../../src/stream/extractor'

vi.mock('yt-dlp-exec', () => ({
  default: vi.fn().mockResolvedValue({
    url: 'https://streams.example.com/camera1/playlist.m3u8',
  }),
}))

describe('extractStreamUrl', () => {
  it('returns the HLS stream URL for a camera page', async () => {
    const url = await extractStreamUrl('https://www.verkeerscentrum.be/camerabeelden/123')
    expect(url).toBe('https://streams.example.com/camera1/playlist.m3u8')
  })

  it('throws if yt-dlp returns no url', async () => {
    const ytdlp = await import('yt-dlp-exec')
    vi.mocked(ytdlp.default).mockResolvedValueOnce({})
    await expect(extractStreamUrl('https://example.com')).rejects.toThrow('No stream URL found')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd backend && npm test tests/stream/extractor.test.ts
```

Expected: FAIL — `extractStreamUrl` not found

- [ ] **Step 4: Create backend/src/stream/extractor.ts**

```typescript
import ytdlp from 'yt-dlp-exec'

export async function extractStreamUrl(cameraPageUrl: string): Promise<string> {
  const result = await ytdlp(cameraPageUrl, {
    getUrl: true,
    noPlaylist: true,
    format: 'best',
  }) as { url?: string }

  if (!result.url) {
    throw new Error(`No stream URL found for ${cameraPageUrl}`)
  }

  return result.url
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd backend && npm test tests/stream/extractor.test.ts
```

Expected: 2 tests pass

- [ ] **Step 6: Commit**

```bash
git add backend/src/stream/extractor.ts backend/tests/stream/extractor.test.ts backend/package.json backend/package-lock.json
git commit -m "feat: add yt-dlp stream URL extractor"
```

---

## Task 2: FFmpeg frame capturer

**Files:**
- Create: `backend/src/stream/capturer.ts`
- Create: `backend/tests/stream/capturer.test.ts`

- [ ] **Step 1: Add fluent-ffmpeg to dependencies**

Add to `backend/package.json`:
```json
"fluent-ffmpeg": "^2.1.3",
"ffmpeg-static": "^5.2.0",
"@types/fluent-ffmpeg": "^2.1.24"
```

Run: `cd backend && npm install`

- [ ] **Step 2: Write failing test**

```typescript
// backend/tests/stream/capturer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fluent-ffmpeg', () => {
  const mockFfmpeg = vi.fn(() => ({
    inputOptions: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
    outputOptions: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    run: vi.fn(),
    kill: vi.fn(),
  }))
  return { default: mockFfmpeg }
})

import { FrameCapturer } from '../../src/stream/capturer'

describe('FrameCapturer', () => {
  it('emits frame events when started', async () => {
    const capturer = new FrameCapturer('https://example.com/stream.m3u8', 'cam1')
    const frames: Buffer[] = []
    capturer.on('frame', (buf: Buffer) => frames.push(buf))
    capturer.start()
    expect(capturer.isRunning()).toBe(true)
    capturer.stop()
    expect(capturer.isRunning()).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd backend && npm test tests/stream/capturer.test.ts
```

Expected: FAIL — `FrameCapturer` not found

- [ ] **Step 4: Create backend/src/stream/capturer.ts**

```typescript
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

ffmpeg.setFfmpegPath(ffmpegStatic!)

export class FrameCapturer extends EventEmitter {
  private process: ReturnType<typeof ffmpeg> | null = null
  private running = false

  constructor(
    private readonly streamUrl: string,
    private readonly cameraId: string,
    private readonly fps = 2,
  ) {
    super()
  }

  start(): void {
    if (this.running) return
    this.running = true

    const passThrough = new PassThrough()
    const chunks: Buffer[] = []

    passThrough.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })

    this.process = ffmpeg(this.streamUrl)
      .inputOptions(['-re'])
      .outputOptions([
        `-vf fps=${this.fps}`,
        '-f image2pipe',
        '-vcodec mjpeg',
        '-q:v 5',
      ])
      .output(passThrough as unknown as string)
      .on('error', (err) => {
        if (this.running) {
          this.emit('error', err)
          setTimeout(() => this.start(), 5000)
        }
      })

    passThrough.on('data', (chunk: Buffer) => {
      const jpegStart = chunk.indexOf(Buffer.from([0xff, 0xd8]))
      const jpegEnd = chunk.lastIndexOf(Buffer.from([0xff, 0xd9]))
      if (jpegStart !== -1 && jpegEnd !== -1) {
        this.emit('frame', chunk.slice(jpegStart, jpegEnd + 2))
      }
    })

    this.process.run()
  }

  stop(): void {
    this.running = false
    this.process?.kill('SIGTERM')
    this.process = null
  }

  isRunning(): boolean {
    return this.running
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd backend && npm test tests/stream/capturer.test.ts
```

Expected: 1 test passes

- [ ] **Step 6: Commit**

```bash
git add backend/src/stream/capturer.ts backend/tests/stream/capturer.test.ts backend/package.json backend/package-lock.json
git commit -m "feat: add FFmpeg frame capturer"
```

---

## Task 3: Socket.io server

**Files:**
- Create: `backend/src/socket/server.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Add socket.io to dependencies**

Add to `backend/package.json`:
```json
"socket.io": "^4.7.5"
```

Run: `cd backend && npm install`

- [ ] **Step 2: Create backend/src/socket/server.ts**

```typescript
import { Server as HttpServer } from 'http'
import { Server as SocketServer } from 'socket.io'

export type FrameEvent = {
  cameraId: string
  frame: string        // base64 JPEG
  timestamp: number
}

let io: SocketServer | null = null

export function initSocketServer(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 5e6,
  })

  io.on('connection', (socket) => {
    socket.on('subscribe', (cameraId: string) => {
      socket.join(`camera:${cameraId}`)
    })
    socket.on('unsubscribe', (cameraId: string) => {
      socket.leave(`camera:${cameraId}`)
    })
  })

  return io
}

export function emitFrame(event: FrameEvent): void {
  io?.to(`camera:${event.cameraId}`).emit('frame', event)
}
```

- [ ] **Step 3: Update backend/src/index.ts to attach Socket.io**

Replace the existing `buildApp` with:

```typescript
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { createServer } from 'http'
import { cameraRoutes } from './routes/cameras'
import { initSocketServer } from './socket/server'
import { CameraWorkerManager } from './camera-worker'
import { config } from './config'

export async function buildApp() {
  const app = Fastify({ logger: true })
  await app.register(cors, { origin: true })
  await app.register(cameraRoutes)
  return app
}

if (require.main === module) {
  buildApp().then((app) => {
    const httpServer = createServer(app.server)
    initSocketServer(httpServer)
    const workerManager = new CameraWorkerManager()
    workerManager.start()

    httpServer.listen(config.port, '0.0.0.0', () => {
      console.log(`Server running on port ${config.port}`)
    })
  })
}
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/socket/ backend/src/index.ts backend/package.json backend/package-lock.json
git commit -m "feat: add Socket.io server with per-camera rooms"
```

---

## Task 4: Camera worker manager

**Files:**
- Create: `backend/src/camera-worker.ts`

- [ ] **Step 1: Create backend/src/camera-worker.ts**

```typescript
import { db } from './db'
import { extractStreamUrl } from './stream/extractor'
import { FrameCapturer } from './stream/capturer'
import { emitFrame } from './socket/server'

type WorkerEntry = {
  capturer: FrameCapturer
  cameraId: string
}

export class CameraWorkerManager {
  private workers = new Map<string, WorkerEntry>()
  private pollInterval: ReturnType<typeof setInterval> | null = null

  async start(): Promise<void> {
    await this.syncWorkers()
    this.pollInterval = setInterval(() => this.syncWorkers(), 60_000)
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval)
    for (const { capturer } of this.workers.values()) capturer.stop()
    this.workers.clear()
  }

  private async syncWorkers(): Promise<void> {
    const cameras = await db.camera.findMany({ where: { active: true } })
    const activeIds = new Set(cameras.map((c) => c.id))

    for (const [id, worker] of this.workers) {
      if (!activeIds.has(id)) {
        worker.capturer.stop()
        this.workers.delete(id)
      }
    }

    for (const camera of cameras) {
      if (!this.workers.has(camera.id)) {
        this.startWorker(camera.id, camera.streamUrl)
      }
    }
  }

  private async startWorker(cameraId: string, pageUrl: string): Promise<void> {
    try {
      const streamUrl = await extractStreamUrl(pageUrl)
      const capturer = new FrameCapturer(streamUrl, cameraId)

      capturer.on('frame', (frameBuffer: Buffer) => {
        emitFrame({
          cameraId,
          frame: frameBuffer.toString('base64'),
          timestamp: Date.now(),
        })
      })

      capturer.on('error', (err: Error) => {
        console.error(`Camera ${cameraId} stream error:`, err.message)
      })

      capturer.start()
      this.workers.set(cameraId, { capturer, cameraId })
    } catch (err) {
      console.error(`Failed to start worker for camera ${cameraId}:`, err)
      setTimeout(() => this.startWorker(cameraId, pageUrl), 60_000)
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/camera-worker.ts
git commit -m "feat: add camera worker manager for stream lifecycle"
```

---

## Task 5: Frontend live feed

**Files:**
- Create: `frontend/src/lib/socket.ts`
- Create: `frontend/src/hooks/useCameraFeed.ts`
- Create: `frontend/src/components/LiveFeed.tsx`
- Modify: `frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Add socket.io-client to frontend**

Add to `frontend/package.json`:
```json
"socket.io-client": "^4.7.5"
```

Run: `cd frontend && npm install`

- [ ] **Step 2: Create frontend/src/lib/socket.ts**

```typescript
import { io } from 'socket.io-client'

export const socket = io('/', {
  path: '/socket.io',
  reconnectionDelayMax: 5000,
})
```

- [ ] **Step 3: Create frontend/src/hooks/useCameraFeed.ts**

```typescript
import { useEffect, useRef, useState } from 'react'
import { socket } from '../lib/socket'

export type FrameEvent = {
  cameraId: string
  frame: string
  timestamp: number
}

export function useCameraFeed(cameraId: string) {
  const [lastFrame, setLastFrame] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const frameCount = useRef(0)
  const lastFpsTime = useRef(Date.now())

  useEffect(() => {
    socket.emit('subscribe', cameraId)

    const handler = (event: FrameEvent) => {
      if (event.cameraId !== cameraId) return
      setLastFrame(event.frame)

      frameCount.current++
      const now = Date.now()
      if (now - lastFpsTime.current >= 1000) {
        setFps(frameCount.current)
        frameCount.current = 0
        lastFpsTime.current = now
      }
    }

    socket.on('frame', handler)
    return () => {
      socket.off('frame', handler)
      socket.emit('unsubscribe', cameraId)
    }
  }, [cameraId])

  return { lastFrame, fps }
}
```

- [ ] **Step 4: Create frontend/src/components/LiveFeed.tsx**

```typescript
import { useEffect, useRef } from 'react'
import { useCameraFeed } from '../hooks/useCameraFeed'

type Props = {
  cameraId: string
  className?: string
}

export function LiveFeed({ cameraId, className = '' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { lastFrame, fps } = useCameraFeed(cameraId)

  useEffect(() => {
    if (!lastFrame || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const img = new Image()
    img.onload = () => {
      canvas.width = img.width
      canvas.height = img.height
      ctx.drawImage(img, 0, 0)
    }
    img.src = `data:image/jpeg;base64,${lastFrame}`
  }, [lastFrame])

  return (
    <div className={`relative ${className}`}>
      <canvas ref={canvasRef} className="w-full h-full object-contain rounded-lg bg-gray-900" />
      {!lastFrame && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">
          Connecting...
        </div>
      )}
      {lastFrame && (
        <span className="absolute bottom-2 right-2 text-xs text-gray-400 bg-black/50 px-1.5 py-0.5 rounded">
          {fps} fps
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Update Dashboard.tsx to use LiveFeed**

Replace the placeholder div inside the camera card:

```typescript
// In Dashboard.tsx, add import:
import { LiveFeed } from '../components/LiveFeed'

// Replace the placeholder:
// OLD:
// <div className="bg-gray-800 rounded-lg aspect-video flex items-center justify-center text-gray-600 text-sm">
//   Live feed — Plan 2
// </div>

// NEW:
<LiveFeed cameraId={cam.id} className="aspect-video" />
```

- [ ] **Step 6: Update nginx.conf to proxy Socket.io**

Add to the `/api/` location block in `frontend/nginx.conf`:

```nginx
location /socket.io/ {
    proxy_pass http://backend:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

- [ ] **Step 7: Start services and verify live feed works**

```bash
docker compose up --build
```

Open `http://localhost`. Add a camera with a real verkeerscentrum.be URL. Verify frames appear in the dashboard.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/socket.ts frontend/src/hooks/useCameraFeed.ts frontend/src/components/LiveFeed.tsx frontend/src/pages/Dashboard.tsx frontend/nginx.conf frontend/package.json frontend/package-lock.json
git commit -m "feat: add live camera feed via Socket.io and canvas rendering"
```
