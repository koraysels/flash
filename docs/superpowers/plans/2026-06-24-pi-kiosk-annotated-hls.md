# Annotated H.264 Kiosk Stream + Fullscreen Pi Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a per-camera H.264/HLS stream with the AI boxes + a counts/speed HUD burned into the pixels, and play it fullscreen on Raspberry Pi kiosks so boxes track the video perfectly and playback is smooth.

**Architecture:** The AI worker already decodes each frame and tracks vehicles. When annotated output is enabled for a camera, the worker draws boxes + HUD onto the frame (reusing `annotateFrame`) and posts the annotated JPEG back. `MJPEGStreamer` pipes those JPEGs into a per-camera `AnnotatedEncoder` (ffmpeg `h264_nvenc`, `libx264` fallback) that writes HLS segments to tmpfs. New backend routes serve the playlist + segments; the encoder runs on demand and idle-stops. The existing `PiDisplay` page is reworked into a chrome-free fullscreen HLS `<video>`.

**Tech Stack:** Node 22 / TypeScript, fluent-ffmpeg + Homebrew/Debian ffmpeg with NVENC, `@napi-rs/canvas`, Fastify, worker_threads, React 18 + HLS.js, Komodo deploy (Docker, CUDA base, GPU reserved).

## Global Constraints

- Use `pnpm`, never `npm`/`yarn`.
- TypeScript strict; no `any` without reason; comments only for non-obvious WHY.
- ffmpeg path comes from the existing `resolveFfmpegPath()` (Homebrew on macOS, `/usr/bin/ffmpeg` in Docker) — never `ffmpeg-static`.
- Backend tests live in `backend/src/__tests__/`; run with `pnpm --filter flash-backend test`. Test DB is the Neon `test` schema via `backend/.env.test` — never touch `public`.
- Deploy is via Komodo webhook on push to `main` (auto-pull). A manual `komodo_deploy_stack` right after a push fails with "Resource is busy" — watch the webhook-triggered build instead.
- The container sees the GPU via compose `deploy.resources.reservations.devices` (already set) + the `nvidia/cuda:12.8.0-cudnn-runtime` base. NVENC requires `h264_nvenc` in the container ffmpeg.
- Restore point: tag `stable-2026-06-24-pre-kiosk`.

---

## Pre-flight (fold into Task 2, but verify first)

Confirm the container ffmpeg has NVENC. This gates the whole approach.

- [ ] **Check `h264_nvenc` availability in the deployed container**

Run (against the running stack via Komodo or `docker exec`):
```
ffmpeg -hide_banner -encoders | grep -E "h264_nvenc|libx264"
```
Expected: both listed. If `h264_nvenc` is absent, the Debian `nvidia/cuda` base + `apt install ffmpeg` build usually includes it; if not, the plan still works via `libx264` fallback (Task 2) — note it and proceed.

---

## Task 1: Worker produces annotated JPEG frames on demand

**Files:**
- Modify: `backend/src/ai/annotator.ts` (add a compact HUD; keep existing box drawing)
- Modify: `backend/src/stream/ai-worker.ts` (annotate + return JPEG when enabled; accept enable/disable control message)
- Test: `backend/src/__tests__/annotator.test.ts` (create)

**Interfaces:**
- Consumes: existing `annotateFrame(jpegBuffer, vehicles, lineAFraction, lineBFraction)` and the worker's per-frame `tracked` vehicles + `counts`.
- Produces:
  - `annotateFrame(jpegBuffer, vehicles, lineAFraction, lineBFraction, hud?: { ab: number; ba: number; speeders: number })` — same return `Promise<Buffer>` (JPEG), now optionally drawing a corner HUD.
  - Worker control message `{ type: 'set-annotated'; enabled: boolean }`.
  - When enabled, `WorkerResultMsg` gains optional `annotatedJpeg?: Buffer` (the annotated frame as JPEG).

- [ ] **Step 1: Write the failing test for the HUD-enabled annotator**

`backend/src/__tests__/annotator.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { annotateFrame } from '../ai/annotator'

// A tiny valid JPEG fixture already used elsewhere, or generate one with canvas.
import { createCanvas } from '@napi-rs/canvas'

function makeJpeg(w: number, h: number): Buffer {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#222'
  ctx.fillRect(0, 0, w, h)
  return c.toBuffer('image/jpeg')
}

describe('annotateFrame', () => {
  it('returns a JPEG larger than 0 bytes with HUD enabled', async () => {
    const src = makeJpeg(640, 480)
    const out = await annotateFrame(
      src,
      [{ id: 1, class: 'car', x1: 10, y1: 10, x2: 100, y2: 80 } as any],
      0.4,
      0.6,
      { ab: 3, ba: 5, speeders: 1 },
    )
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out.length).toBeGreaterThan(0)
    // JPEG SOI marker
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
  })

  it('works without HUD arg (backward compatible)', async () => {
    const src = makeJpeg(320, 240)
    const out = await annotateFrame(src, [], 0.4, 0.6)
    expect(out.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter flash-backend test annotator`
Expected: FAIL — `annotateFrame` doesn't accept the 5th `hud` arg / current signature mismatch or returns nothing for the HUD path.

- [ ] **Step 3: Extend `annotateFrame` to draw the HUD and return JPEG**

In `backend/src/ai/annotator.ts`, update the signature and, after drawing boxes, draw a compact corner HUD, then return a JPEG (`canvas.toBuffer('image/jpeg')`). Add at the end of the function (before/replacing the existing return):
```ts
export async function annotateFrame(
  jpegBuffer: Buffer,
  vehicles: TrackedVehicle[],
  lineAFraction: number,
  lineBFraction: number,
  hud?: { ab: number; ba: number; speeders: number },
): Promise<Buffer> {
  // ... existing image load, line + box drawing unchanged ...

  if (hud) {
    const text = `A→B ${hud.ab}   B→A ${hud.ba}   spd ${hud.speeders}`
    ctx.font = 'bold 16px sans-serif'
    const w = ctx.measureText(text).width + 16
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(8, 8, w, 26)
    ctx.fillStyle = '#fff'
    ctx.fillText(text, 16, 26)
  }

  return canvas.toBuffer('image/jpeg')
}
```
(If the existing function already returned `canvas.toBuffer(...)`, keep that — just add the `hud` param + HUD block before it.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm --filter flash-backend test annotator`
Expected: PASS (both cases).

- [ ] **Step 5: Make the worker annotate + return JPEG when enabled**

In `backend/src/stream/ai-worker.ts`:

Add module state near the other lets:
```ts
let annotatedEnabled = false
```

Handle a control message (in the `parentPort!.on('message', ...)` handler, alongside `reset-counts`):
```ts
if (msg.type === 'set-annotated') {
  annotatedEnabled = msg.enabled
  return
}
```

Add the message type near `WorkerResetMsg`:
```ts
export type WorkerSetAnnotatedMsg = { type: 'set-annotated'; enabled: boolean }
```
and widen the handler param type to include it (and update the `on('message', (msg: WorkerAnalyseMsg | WorkerResetMsg | WorkerSetAnnotatedMsg) => ...)`).

In the success path, after `boxes` is built and before `parentPort!.postMessage({ type: 'result', ... })`, compute the annotated JPEG when enabled. Reuse the confirmed, non-predicted `tracked` set already used for boxes:
```ts
let annotatedJpeg: Buffer | undefined
if (annotatedEnabled) {
  // msg.jpeg is the original frame; reuse line fractions from init.
  annotatedJpeg = await annotateFrame(
    msg.jpeg,
    tracked.filter((v) => !v.isPredicted),
    lineA,
    lineB,
    { ab: counts.AB, ba: counts.BA, speeders },
  )
}
```
Add `annotatedJpeg` to the `WorkerResultMsg` type as optional and include it in the posted message:
```ts
export type WorkerResultMsg = {
  // ...existing fields...
  annotatedJpeg?: Buffer
}
```
Import `annotateFrame` at the top: `import { annotateFrame } from '../ai/annotator'`.

- [ ] **Step 6: Build to typecheck the worker changes**

Run: `pnpm --filter flash-backend build`
Expected: tsc passes (no type errors).

- [ ] **Step 7: Commit**

```bash
git add backend/src/ai/annotator.ts backend/src/stream/ai-worker.ts backend/src/__tests__/annotator.test.ts
git commit -m "feat(annotate): worker emits HUD-annotated JPEG frames on demand"
```

---

## Task 2: AnnotatedEncoder — ffmpeg NVENC→HLS, on-demand, libx264 fallback

**Files:**
- Create: `backend/src/stream/annotated-encoder.ts`
- Test: `backend/src/__tests__/annotated-encoder.test.ts` (create — tests the pure lifecycle/path logic, not ffmpeg)

**Interfaces:**
- Consumes: `resolveFfmpegPath()` (export it from `mjpeg-streamer.ts` if not already exported, or duplicate the small helper into a shared `ffmpeg-path.ts`).
- Produces:
  ```ts
  export class AnnotatedEncoder {
    constructor(cameraId: string, outDir: string)   // outDir e.g. /tmp/flash-hls/<cameraId>
    pushFrame(jpeg: Buffer): void                    // feed one annotated JPEG
    touch(): void                                    // mark a client pulled a segment (resets idle timer)
    isActive(): boolean
    start(): void                                    // spawn ffmpeg (idempotent)
    stop(): void                                     // kill ffmpeg, clear timers
    readonly playlistPath: string                    // `${outDir}/index.m3u8`
  }
  ```
  Idle behaviour: if `touch()` not called for `IDLE_MS` (e.g. 15_000), `stop()` automatically.

- [ ] **Step 1: Write the failing test for lifecycle/path logic**

`backend/src/__tests__/annotated-encoder.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnnotatedEncoder } from '../stream/annotated-encoder'

describe('AnnotatedEncoder', () => {
  afterEach(() => vi.useRealTimers())

  it('exposes a playlist path under the out dir', () => {
    const enc = new AnnotatedEncoder('camA', '/tmp/flash-hls/camA')
    expect(enc.playlistPath).toBe('/tmp/flash-hls/camA/index.m3u8')
  })

  it('idle-stops after IDLE_MS without touch', () => {
    vi.useFakeTimers()
    const enc = new AnnotatedEncoder('camA', '/tmp/flash-hls/camA')
    enc.start()
    expect(enc.isActive()).toBe(true)
    vi.advanceTimersByTime(20_000)
    expect(enc.isActive()).toBe(false)
    enc.stop()
  })

  it('touch resets the idle timer', () => {
    vi.useFakeTimers()
    const enc = new AnnotatedEncoder('camA', '/tmp/flash-hls/camA')
    enc.start()
    vi.advanceTimersByTime(10_000)
    enc.touch()
    vi.advanceTimersByTime(10_000)
    expect(enc.isActive()).toBe(true)  // 10s after touch < 15s idle
    enc.stop()
  })
})
```
Note: `start()` must not actually require a GPU to set `active=true` and arm the idle timer; the ffmpeg spawn is best-effort and its failure is logged, not thrown (so the unit test runs without ffmpeg).

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm --filter flash-backend test annotated-encoder`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `AnnotatedEncoder`**

`backend/src/stream/annotated-encoder.ts`:
```ts
import { spawn, ChildProcess } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { resolveFfmpegPath } from './ffmpeg-path'

const IDLE_MS = 15_000
const OUT_FPS = 20

export class AnnotatedEncoder {
  private proc: ChildProcess | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private active = false
  readonly playlistPath: string

  constructor(private readonly cameraId: string, private readonly outDir: string) {
    this.playlistPath = join(outDir, 'index.m3u8')
  }

  isActive(): boolean { return this.active }

  start(): void {
    if (this.active) { this.armIdle(); return }
    this.active = true
    this.armIdle()
    try {
      mkdirSync(this.outDir, { recursive: true })
      const ff = resolveFfmpegPath()
      const args = [
        '-f', 'image2pipe', '-framerate', String(OUT_FPS), '-i', 'pipe:0',
        '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-pix_fmt', 'yuv420p',
        '-g', String(OUT_FPS * 2),
        '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+append_list+omit_endlist',
        '-hls_segment_filename', join(this.outDir, 'seg_%05d.ts'),
        this.playlistPath,
      ]
      this.proc = spawn(ff, args, { stdio: ['pipe', 'ignore', 'pipe'] })
      this.proc.stderr?.on('data', () => { /* swallow; NVENC may warn */ })
      this.proc.on('exit', () => { this.proc = null })
      // If NVENC fails immediately, restart once with libx264.
      this.proc.on('error', () => this.fallbackToLibx264())
    } catch {
      this.fallbackToLibx264()
    }
  }

  private fallbackToLibx264(): void {
    if (!this.active) return
    try {
      const ff = resolveFfmpegPath()
      const args = [
        '-f', 'image2pipe', '-framerate', String(OUT_FPS), '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-g', String(OUT_FPS * 2),
        '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+append_list+omit_endlist',
        '-hls_segment_filename', join(this.outDir, 'seg_%05d.ts'),
        this.playlistPath,
      ]
      this.proc = spawn(ff, args, { stdio: ['pipe', 'ignore', 'pipe'] })
      this.proc.on('exit', () => { this.proc = null })
    } catch { /* give up; routes will 404 until restart */ }
  }

  pushFrame(jpeg: Buffer): void {
    if (this.active && this.proc?.stdin?.writable) {
      this.proc.stdin.write(jpeg)
    }
  }

  touch(): void { if (this.active) this.armIdle() }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS)
  }

  stop(): void {
    this.active = false
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    this.proc?.stdin?.end()
    this.proc?.kill('SIGTERM')
    this.proc = null
  }
}
```

- [ ] **Step 4: Extract `resolveFfmpegPath` into a shared module**

Create `backend/src/stream/ffmpeg-path.ts` with the existing helper body (copied verbatim from `mjpeg-streamer.ts`), export it, and change `mjpeg-streamer.ts` to import it:
```ts
// backend/src/stream/ffmpeg-path.ts
import { existsSync } from 'fs'
import ffmpegStatic from 'ffmpeg-static'

export function resolveFfmpegPath(): string {
  if (process.platform === 'darwin') {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (existsSync(p)) return p
    }
  }
  if (existsSync('/usr/bin/ffmpeg')) return '/usr/bin/ffmpeg'
  return ffmpegStatic!
}
```
In `mjpeg-streamer.ts`, delete the local `resolveFfmpegPath` and `import { resolveFfmpegPath } from './ffmpeg-path'`.

- [ ] **Step 5: Run the tests, verify they pass**

Run: `pnpm --filter flash-backend test annotated-encoder && pnpm --filter flash-backend build`
Expected: PASS + tsc clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/stream/annotated-encoder.ts backend/src/stream/ffmpeg-path.ts backend/src/stream/mjpeg-streamer.ts backend/src/__tests__/annotated-encoder.test.ts
git commit -m "feat(stream): AnnotatedEncoder (nvenc->hls, libx264 fallback, on-demand)"
```

---

## Task 3: Wire encoder into the streamer + serve the annotated HLS routes

**Files:**
- Modify: `backend/src/stream/mjpeg-streamer.ts` (own an `AnnotatedEncoder`; enable worker annotation on demand; feed annotated JPEGs)
- Modify: `backend/src/routes/cameras.ts` (serve `/api/cameras/:id/annotated/index.m3u8` + `/.../annotated/:seg`)
- Modify: `frontend/nginx.conf` (proxy `/api/cameras/.../annotated/` like the mjpeg location — no buffering)
- Test: manual (integration) — see verification steps

**Interfaces:**
- Consumes: `AnnotatedEncoder` (Task 2), worker `WorkerResultMsg.annotatedJpeg` + `{ type: 'set-annotated' }` (Task 1).
- Produces on `MJPEGStreamer`:
  ```ts
  enableAnnotated(): void   // start encoder + tell worker to annotate
  annotatedPlaylistPath(): string | null   // path if active, else null
  touchAnnotated(): void    // reset encoder idle timer (called when a client pulls)
  ```

- [ ] **Step 1: Add encoder ownership + control to `MJPEGStreamer`**

Add fields:
```ts
private annotatedEncoder: AnnotatedEncoder | null = null
```
Import: `import { AnnotatedEncoder } from './annotated-encoder'` and `import { tmpdir } from 'os'`.

Add methods:
```ts
enableAnnotated(): void {
  if (!this.annotatedEncoder) {
    this.annotatedEncoder = new AnnotatedEncoder(this.cameraId, join(tmpdir(), 'flash-hls', this.cameraId))
  }
  this.annotatedEncoder.start()
  this.aiWorker?.postMessage({ type: 'set-annotated', enabled: true })
}

annotatedPlaylistPath(): string | null {
  return this.annotatedEncoder?.isActive() ? this.annotatedEncoder.playlistPath : null
}

touchAnnotated(): void { this.annotatedEncoder?.touch() }
```

In the worker `result` message handler (where `msg.boxes` etc. are read), feed the encoder:
```ts
if (msg.annotatedJpeg && this.annotatedEncoder?.isActive()) {
  this.annotatedEncoder.pushFrame(msg.annotatedJpeg)
}
```

In `stop()`, also stop the encoder + disable worker annotation:
```ts
this.annotatedEncoder?.stop()
this.annotatedEncoder = null
```
(When the encoder idle-stops on its own, also tell the worker to stop annotating to save CPU — add a small check: if `!this.annotatedEncoder?.isActive()` when a result arrives, post `{ type: 'set-annotated', enabled: false }` once. Keep a `private annotatedOn = false` guard to avoid spamming the message.)

- [ ] **Step 2: Build to typecheck**

Run: `pnpm --filter flash-backend build`
Expected: tsc clean.

- [ ] **Step 3: Add the annotated HLS routes**

In `backend/src/routes/cameras.ts`, near the existing `/api/cameras/:id/hls/*` proxy, add (use the app's streamer registry — the same one `/mjpeg` uses; mirror that lookup):
```ts
import { readFile } from 'fs/promises'
import { join, basename } from 'path'

// Playlist: starts the encoder on demand, waits briefly for first segment.
app.get<{ Params: { id: string } }>('/api/cameras/:id/annotated/index.m3u8', async (req, reply) => {
  const streamer = streamers.get(req.params.id)
  if (!streamer) { reply.code(404).send({ error: 'Camera not running' }); return }
  streamer.enableAnnotated()
  streamer.touchAnnotated()
  const playlist = streamer.annotatedPlaylistPath()
  if (!playlist) { reply.code(503).send({ error: 'Encoder starting' }); return }
  // Wait up to ~3s for ffmpeg to write the first playlist.
  for (let i = 0; i < 30; i++) {
    try {
      const buf = await readFile(playlist)
      reply.header('Content-Type', 'application/vnd.apple.mpegurl')
      reply.header('Cache-Control', 'no-cache')
      reply.send(buf)
      return
    } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  reply.code(503).send({ error: 'Encoder warming up' })
})

// Segments
app.get<{ Params: { id: string; seg: string } }>('/api/cameras/:id/annotated/:seg', async (req, reply) => {
  const streamer = streamers.get(req.params.id)
  if (!streamer) { reply.code(404).send({ error: 'Camera not running' }); return }
  streamer.touchAnnotated()
  const playlist = streamer.annotatedPlaylistPath()
  if (!playlist) { reply.code(404).send(); return }
  const dir = playlist.substring(0, playlist.lastIndexOf('/'))
  const safe = basename(req.params.seg)  // prevent path traversal
  try {
    const buf = await readFile(join(dir, safe))
    reply.header('Content-Type', safe.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t')
    reply.header('Cache-Control', 'no-cache')
    reply.send(buf)
  } catch { reply.code(404).send() }
})
```
(Match the actual streamer-registry variable name used by the existing `/mjpeg` route in this file — read it and reuse the same accessor.)

- [ ] **Step 4: Add the nginx proxy for the annotated path**

In `frontend/nginx.conf`, add a location mirroring the mjpeg one (no buffering, long timeout), above `location /api/`:
```nginx
location ~* ^/api/cameras/[^/]+/annotated {
    proxy_pass http://backend:3001;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_set_header Host $host;
}
```

- [ ] **Step 5: Build, commit, deploy, verify the stream exists**

```bash
pnpm --filter flash-backend build
git add backend/src/stream/mjpeg-streamer.ts backend/src/routes/cameras.ts frontend/nginx.conf
git commit -m "feat(stream): serve on-demand annotated H.264 HLS per camera"
git push origin main
```
Then watch the Komodo webhook build complete. Verify on the box (replace `<id>` with a running camera id):
```
curl -s http://localhost:3001/api/cameras/<id>/annotated/index.m3u8 | head
ls -la /tmp/flash-hls/<id>/
```
Expected: after ~1–3s, an `#EXTM3U` playlist and `seg_*.ts` files appear. Check backend logs for no crashes and that NVENC (or libx264 fallback) started.

---

## Task 4: Rework `PiDisplay` into a fullscreen annotated-HLS kiosk

**Files:**
- Modify: `frontend/src/pages/PiDisplay.tsx` (replace chrome + canvas/useCameraFeed with a fullscreen HLS `<video>`)
- Modify: `frontend/index.html` or a scoped style — ensure no scrollbar on this route
- Reference: `frontend/src/components/HLSVideoStream.tsx` for the HLS.js setup pattern

**Interfaces:**
- Consumes: `/api/cameras/:id/annotated/index.m3u8` (Task 3), HLS.js (already a dependency).

- [ ] **Step 1: Replace `PiDisplay` with a fullscreen HLS player**

`frontend/src/pages/PiDisplay.tsx`:
```tsx
import { useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import Hls from 'hls.js'

export default function PiDisplay() {
  const { cameraId } = useParams<{ cameraId: string }>()
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !cameraId) return
    const src = `/api/cameras/${cameraId}/annotated/index.m3u8`

    let hls: Hls | null = null
    if (Hls.isSupported()) {
      hls = new Hls({ liveSyncDuration: 3, lowLatencyMode: false })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          // Kiosks run unattended — recover by reloading the source.
          setTimeout(() => { hls?.loadSource(src); hls?.startLoad() }, 2000)
        }
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src  // Safari/native HLS
    }
    video.play().catch(() => { /* autoplay may need muted; video is muted below */ })
    return () => { hls?.destroy() }
  }, [cameraId])

  return (
    <div className="fixed inset-0 bg-black">
      <video
        ref={videoRef}
        muted
        autoPlay
        playsInline
        className="w-full h-full"
        style={{ objectFit: 'contain' }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Kill the scrollbar globally on the kiosk route**

In `frontend/src/index.css` (or equivalent global stylesheet) add (does not affect the dashboard layout meaningfully, but verify):
```css
html, body, #root { height: 100%; }
```
And rely on the `fixed inset-0` container + `overflow:hidden` default of a fixed full-viewport element. If the app root forces scroll, add a body class when on `/display` — simplest: the `fixed inset-0` already covers the viewport and hides content beneath; ensure `body { margin: 0 }` (Tailwind preflight already does this).

- [ ] **Step 3: Build the frontend**

Run: `pnpm --filter flash-frontend build`
Expected: vite build succeeds, no TS errors.

- [ ] **Step 4: Commit + deploy**

```bash
git add frontend/src/pages/PiDisplay.tsx frontend/src/index.css
git commit -m "feat(kiosk): fullscreen annotated-HLS PiDisplay, no chrome"
git push origin main
```
Watch the webhook build.

- [ ] **Step 5: Verify in a desktop browser first**

Open `https://flash.cursorpointer.be/display/<cameraId>` (or the Tailscale URL once Task 5 is done).
Expected: fullscreen video, edge-to-edge, no scrollbar, no header/footer, boxes + HUD burned into the video and perfectly tracking (no ghost/freeze/lag). A few seconds of startup latency is expected.

---

## Task 5: Tailscale transport + Raspberry Pi kiosk autostart (ops)

**Files:**
- Create: `docs/pi-kiosk-setup.md` (runbook; no app code)

**Interfaces:** none (deployment/ops).

- [ ] **Step 1: Put the rtx4090 host and the Pis on the tailnet**

On the rtx4090 host and each Pi:
```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```
Note the host's tailnet name/IP (e.g. `rtx4090-win10` MagicDNS name or `100.x.y.z`). Confirm from a Pi: `curl -sI http://<tailnet-host>/display/<id>` returns 200/playlist.

- [ ] **Step 2: Configure Chromium kiosk autostart on each Pi**

Document in `docs/pi-kiosk-setup.md` (and apply on a Pi):
```
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --app="http://<tailnet-host>/display/<cameraId>"
```
Add to the Pi's autostart (e.g. `~/.config/lxsession/LXDE-pi/autostart` or a systemd user service). One Pi → one cameraId.

- [ ] **Step 3: Verify on a real Pi**

Boot the Pi; Chromium should open fullscreen to the camera, play smoothly (H.264 hardware-decoded), boxes synced, no scrollbar, no chrome. If playback stutters, confirm hardware decode is active (`chrome://gpu`) and that the stream is `h264_nvenc`/`libx264` H.264 (not VP9).

- [ ] **Step 4: Commit the runbook**

```bash
git add docs/pi-kiosk-setup.md
git commit -m "docs: Raspberry Pi kiosk + Tailscale setup runbook"
```

---

## Post-implementation cleanup

- [ ] Remove the verbose per-stage AI timing stderr log in `ai-worker.ts` (added commit `c3b8294`) once perf is settled, or gate it behind an env flag.
- [ ] Update `CLAUDE.md` "Video architecture" section: dashboard = MJPEG + canvas overlay (interactive); kiosk = annotated H.264 HLS at `/api/cameras/:id/annotated/index.m3u8`.

## Verification summary (whole feature)

1. `curl .../annotated/index.m3u8` returns a live playlist; `.ts` segments rotate in `/tmp/flash-hls/<id>`.
2. Encoder idle-stops ~15s after the last segment pull (check backend logs / process list).
3. `/display/<id>` is fullscreen, no scrollbar, boxes + HUD burned in and perfectly synced.
4. Smooth on a real Pi over Tailscale.
5. Interactive dashboard/calibration unchanged.
6. Backend tests pass: `pnpm --filter flash-backend test`.
