# MJPEG Backpressure and Client Stall Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent memory growth when MJPEG clients are slow consumers, and show a visible reconnecting state when the stream silently hangs.

**Architecture:** Two independent fixes. Task 1 adds a `readableLength` watermark check in the MJPEG route handler so frames are dropped per-client instead of buffered indefinitely when the downstream TCP socket is saturated. Task 2 adds a passive socket listener and watchdog interval to `MJPEGStream.tsx`: if no `frame` socket event arrives for 5 s after the stream became active, the component shows a "Reconnecting…" overlay and forces the `<img>` to reload by changing its React key.

**Tech Stack:** Node.js `PassThrough` stream (readableLength), Fastify route handler, React 18 (useEffect, useState, useRef), Socket.io client.

---

## Context you must read first

**`backend/src/routes/cameras.ts` (lines 143–174)** — MJPEG endpoint. Each client gets a `PassThrough` stream. The `onFrame` handler calls `pass.push(buffer)` for every annotated frame emitted by `MJPEGStreamer`. There is no backpressure check: if a client's TCP buffer fills (slow connection, backgrounded tab), Node.js buffers grow without bound.

`pass.readableLength` is the number of bytes sitting in the `PassThrough`'s readable buffer waiting to be consumed by Fastify/the HTTP socket. If it exceeds a threshold, the client is not reading fast enough and the frame should be dropped.

**`frontend/src/components/MJPEGStream.tsx`** — a bare `<img src="/api/cameras/:id/mjpeg">`. No error handling, no stale detection. If the server stops emitting (ffmpeg crash, network drop), the browser just freezes on the last frame silently.

**`frontend/src/hooks/useCameraFeed.ts`** — exports `FrameEvent` type and a `useCameraFeed` hook that listens to `socket.on('frame', handler)` and emits `socket.emit('subscribe', cameraId)`. **Do not call `subscribe`/`unsubscribe` inside `MJPEGStream`** — the parent component already subscribes. `MJPEGStream` should only call `socket.on` / `socket.off` (passive listener).

**`frontend/src/lib/socket.ts`** — exports the singleton `socket` instance.

Run after every task:
```bash
cd /Users/koraysels/work/flash/backend
pnpm tsc --noEmit   # must produce no output
pnpm test           # must stay 33/33 passing
```

For frontend TypeScript:
```bash
cd /Users/koraysels/work/flash/frontend
pnpm tsc --noEmit
```

---

## File structure

- Modify: `backend/src/routes/cameras.ts` — add readableLength drop check
- Modify: `frontend/src/components/MJPEGStream.tsx` — add watchdog + overlay

---

## Task 1: Drop MJPEG frames when client is a slow consumer

**Files:**
- Modify: `backend/src/routes/cameras.ts` (lines 143–174)

**What:** Add a module-level constant `MJPEG_DROP_WATERMARK` (200 KB = roughly 4–5 annotated frames). In `onFrame`, before pushing, check `pass.readableLength > MJPEG_DROP_WATERMARK` and return early if true. This silently drops the frame for that client only — other clients are unaffected, and `MJPEGStreamer` continues emitting normally.

- [ ] **Step 1: Add the watermark constant and backpressure check**

In `backend/src/routes/cameras.ts`, locate the MJPEG endpoint (around line 143):

```typescript
  // MJPEG stream — multipart/x-mixed-replace; server annotates every frame server-side
  app.get<{ Params: { id: string } }>('/api/cameras/:id/mjpeg', (req, reply) => {
    const streamer = getStreamer(req.params.id)
    if (!streamer) {
      reply.code(503).send({ error: 'Camera stream not available yet' })
      return
    }

    reply.header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
    reply.header('Cache-Control', 'no-cache, no-store')
    reply.header('Access-Control-Allow-Origin', '*')

    const pass = new PassThrough()

    const onFrame = (jpeg: Buffer) => {
      if (pass.destroyed) return
      const hdr = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`)
      pass.push(Buffer.concat([hdr, jpeg, Buffer.from('\r\n')]))
    }

    streamer.on('frame', onFrame)

    const cleanup = () => {
      streamer.off('frame', onFrame)
      if (!pass.destroyed) pass.destroy()
    }

    req.socket?.once('close', cleanup)
    pass.once('close', cleanup)

    reply.send(pass)
  })
```

Replace with:
```typescript
  // Drop MJPEG frames when the readable buffer exceeds this — slow consumer, not a push problem
  const MJPEG_DROP_WATERMARK = 200 * 1024

  // MJPEG stream — multipart/x-mixed-replace; server annotates every frame server-side
  app.get<{ Params: { id: string } }>('/api/cameras/:id/mjpeg', (req, reply) => {
    const streamer = getStreamer(req.params.id)
    if (!streamer) {
      reply.code(503).send({ error: 'Camera stream not available yet' })
      return
    }

    reply.header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
    reply.header('Cache-Control', 'no-cache, no-store')
    reply.header('Access-Control-Allow-Origin', '*')

    const pass = new PassThrough()

    const onFrame = (jpeg: Buffer) => {
      if (pass.destroyed) return
      // Client is not reading fast enough — drop this frame rather than buffer indefinitely
      if (pass.readableLength > MJPEG_DROP_WATERMARK) return
      const hdr = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`)
      pass.push(Buffer.concat([hdr, jpeg, Buffer.from('\r\n')]))
    }

    streamer.on('frame', onFrame)

    const cleanup = () => {
      streamer.off('frame', onFrame)
      if (!pass.destroyed) pass.destroy()
    }

    req.socket?.once('close', cleanup)
    pass.once('close', cleanup)

    reply.send(pass)
  })
```

Note: `MJPEG_DROP_WATERMARK` is inside the `cameraRoutes` function (not module-level) because it is only used within this one handler. Place it just above the route registration as shown.

- [ ] **Step 2: Verify backend**

```bash
cd /Users/koraysels/work/flash/backend
pnpm tsc --noEmit && pnpm test
```
Expected: no output from tsc, 33 tests pass.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/cameras.ts
git commit -m "fix: drop mjpeg frames per-client when readable buffer exceeds 200KB watermark"
```

---

## Task 2: Client stall watchdog in MJPEGStream

**Files:**
- Modify: `frontend/src/components/MJPEGStream.tsx`

**What:** Add two effects to `MJPEGStream`:
1. A passive socket listener that records the timestamp of the last `frame` event for this camera into a ref. **No `subscribe`/`unsubscribe`** — the parent already handles that.
2. A 2-second watchdog interval that checks if the last event was more than 5 s ago (and at least one event has been seen). If stale: set `stale = true` and increment `imgKey` to force the `<img>` to reconnect. Reset `lastEventRef.current` to 0 after forcing reload so the watchdog doesn't re-trigger on every tick.

When `stale = true`, show a centered "Reconnecting…" overlay over the video area. When a new socket event arrives, clear `stale`.

Import `useEffect`, `useRef`, `useState` from React. Import `socket` from `../lib/socket`. Import `type FrameEvent` from `../hooks/useCameraFeed`.

- [ ] **Step 1: Rewrite `MJPEGStream.tsx` with watchdog**

Replace the entire file content with:
```tsx
import { useEffect, useRef, useState } from 'react'
import { socket } from '../lib/socket'
import type { FrameEvent } from '../hooks/useCameraFeed'

const STALE_THRESHOLD_MS = 5_000
const WATCHDOG_INTERVAL_MS = 2_000

interface Props {
  cameraId: string
  className?: string
}

export function MJPEGStream({ cameraId, className }: Props) {
  const [stale, setStale] = useState(false)
  const [imgKey, setImgKey] = useState(0)
  const lastEventRef = useRef(0)

  // Passive listener — parent already subscribes; we only track timestamp
  useEffect(() => {
    const handler = (event: FrameEvent) => {
      if (event.cameraId !== cameraId) return
      lastEventRef.current = Date.now()
      setStale(false)
    }
    socket.on('frame', handler)
    return () => { socket.off('frame', handler) }
  }, [cameraId])

  // Watchdog: if stream goes quiet for STALE_THRESHOLD_MS, force img reload
  useEffect(() => {
    const id = setInterval(() => {
      if (lastEventRef.current === 0) return
      if (Date.now() - lastEventRef.current > STALE_THRESHOLD_MS) {
        setStale(true)
        setImgKey((k) => k + 1)
        lastEventRef.current = 0
      }
    }, WATCHDOG_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={`relative overflow-hidden bg-black ${className ?? ''}`}>
      <img
        key={imgKey}
        src={`/api/cameras/${cameraId}/mjpeg`}
        className="w-full h-full object-contain"
        alt=""
      />
      {stale && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <span className="text-white text-sm font-medium">Reconnecting…</span>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify frontend TypeScript**

```bash
cd /Users/koraysels/work/flash/frontend
pnpm tsc --noEmit
```
Expected: no output.

- [ ] **Step 3: Verify backend tests still pass**

```bash
cd /Users/koraysels/work/flash/backend
pnpm tsc --noEmit && pnpm test
```
Expected: 33 tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/MJPEGStream.tsx
git commit -m "feat: add stale-stream watchdog to MJPEGStream with reconnect overlay"
```

---

## Self-Review

**Spec coverage:**
1. ✅ Backpressure — Task 1: `pass.readableLength > MJPEG_DROP_WATERMARK` drops frames per-client
2. ✅ Drop frames not queue — the frame is discarded in the route handler; `MJPEGStreamer` is unaffected
3. ✅ Stall watchdog — Task 2: passive socket listener + 2s watchdog interval
4. ✅ Reconnecting state — overlay shown when `stale = true`
5. ✅ Force reload — `imgKey` increment causes React to remount `<img>`, triggering a new HTTP connection
6. ✅ No double subscribe — Task 2 uses `socket.on`/`socket.off` only, no `subscribe`/`unsubscribe`

**Placeholder scan:** None found.

**Type consistency:**
- `FrameEvent` imported as `type` from `../hooks/useCameraFeed` — matches the export in that file
- `lastEventRef.current` is `number` (0 = never seen) throughout; compared with `Date.now()` (also number)
- `imgKey` is `number` state, used as React `key` prop on `<img>` — valid
