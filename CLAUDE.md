# Flash — Claude Code Context

## Project overview

Flash is a traffic monitoring system. It captures live HLS streams from road cameras, runs YOLOv8n object detection on every frame, tracks vehicles across frames, counts them by direction, and measures speed via homography calibration.

## Stack

- **Runtime**: Node.js 22 (via mise)
- **Package manager**: pnpm (always use `pnpm`, never `npm`)
- **Monorepo**: pnpm workspaces — packages are `flash-backend` and `flash-frontend`
- **Backend**: Fastify 4, Socket.io 4, Prisma 5, PostgreSQL (Neon)
- **Frontend**: React 18, Vite 5, Tailwind CSS 3, TanStack Query, HLS.js, React Konva
- **AI**: YOLOv8n ONNX via onnxruntime-node 1.26, @napi-rs/canvas for frame annotation
- **Streaming**: ffmpeg (Homebrew on macOS — ffmpeg-static fails Gatekeeper), HLS proxy

## Dev setup

```bash
pnpm dev          # starts backend (tsx watch) + frontend (vite) concurrently
pnpm --filter flash-backend build   # compile backend TypeScript
pnpm --filter flash-backend test    # run backend tests
```

Frontend runs on port **5174** (port 5173 may be occupied by another project).
Backend API runs on **localhost:3001**.

## Environment files

- `backend/.env` — `DATABASE_URL`, `PORT=3001`
- `frontend/.env` — `VITE_GOOGLE_MAPS_API_KEY` (optional, for calibration map)

## Key architecture decisions

### ffmpeg on macOS
`ffmpeg-static` binaries fail macOS Gatekeeper (SIGKILL/exit 137). Always use Homebrew ffmpeg at `/opt/homebrew/bin/ffmpeg`. The `capturer.ts` handles this automatically via `resolveFfmpegPath()`.

### HLS proxy
Backend proxies HLS segments from verkeerscentrum.be at `/api/cameras/:id/hls/*`. This is necessary because:
1. The streams require a `Referer: https://www.verkeerscentrum.be/` header
2. CORS prevents direct browser access
The proxy rewrites relative playlist URLs to go through itself.

### ONNX model path
Use `process.cwd()` (not `__dirname`) for the model path. When the backend starts from `/app/backend`, the model is at `models/yolov8n.onnx` relative to cwd.

### JPEG decode in pipeline
`detector.detect()` expects **raw RGB bytes**, not JPEG-encoded bytes. `pipeline.process()` decodes JPEG using `@napi-rs/canvas` `loadImage()` before passing to the detector.

### Frame dimensions
The verkeerscentrum stream is **768×576** pixels, not 1280×720. The pipeline uses actual decoded image dimensions (not the hardcoded constructor values) and rebuilds the `DirectionCounter` if dimensions change on first frame.

### Bottom-center for speed/counting
The tracker exposes `bcx`/`bcy` (bottom-center of bounding box = ground contact point). The pipeline uses these — not `cx`/`cy` — when calling `speedCalc.addPosition()` and `counter.updateVehicle()`. This ensures homography projection is accurate to the ground plane.

### Track confirmation
Tracks must appear in at least **2 consecutive frames** before being reported (`minConfirmedFrames = 2`). This suppresses single-frame false positives.

## Database schema

```
Camera         — stream URL, calibration data (homographyMatrix, calibrationPoints), counting lines
TrafficEvent   — individual vehicle crossing events (direction, class, speed)
DailyCount     — aggregated per-camera per-day counts
```

## Socket.io protocol

Clients join a room per camera via `socket.emit('subscribe', cameraId)`.
Server emits `frame` events with detection data only (no video — video comes via HLS):
```typescript
{
  cameraId: string
  timestamp: number
  vehicles: Array<{ id: number; class: string; speedKmh: number | null; direction: null; x1: number; y1: number; x2: number; y2: number }>
  counts: { AB: number; BA: number; speeders: number }
  frameWidth: number   // actual decoded frame width (e.g. 768)
  frameHeight: number  // actual decoded frame height (e.g. 576)
}
```

Raw JPEGs are stored server-side only (for the `/api/cameras/:id/snapshot` endpoint). The annotated JPEG is no longer produced — the frontend canvas overlay handles annotation.

## Video architecture

- **Video**: HLS stream proxied by backend (`/api/cameras/:id/hls/*`) → HLS.js in browser
- **Boxes**: Detection coordinates sent via socket.io → Canvas 2D overlay drawn in `AnnotatedStream.tsx`
- **No annotated JPEG**: `annotateFrame()` is no longer called in the pipeline (saves CPU)
- **AI fps**: 5fps (up from 2fps) — `FrameCapturer` and `CameraPipeline` both use `fps=5`

## Common gotchas

- Always use `pnpm`, never `npm` or `yarn`
- The HLS player buffers for ~30s before smooth playback (segments are ~9s long)
- `onnxruntime-node` requires glibc — use `node:20-slim` (Debian) Docker base, not Alpine
- Prisma binaryTarget must include `debian-openssl-3.0.x` for Docker builds
- `@react-google-maps/api` `useJsApiLoader` must include `libraries: ['places']` when using `StandaloneSearchBox`

## Code style

- TypeScript strict mode everywhere
- No comments except for non-obvious WHY (architectural decisions, workarounds)
- No `any` types without a reason
- Prefer editing existing files over creating new ones
- Tests live in `backend/src/__tests__/`
