# Flash — Agent Instructions

This file gives AI coding agents everything they need to work effectively on this codebase. Read it fully before making changes.

## Project summary

Flash monitors road traffic from live HLS camera streams. The backend runs YOLOv8n detection on each frame, tracks vehicles, counts direction crossings, and measures speed. The frontend shows a live dashboard with HLS video and AI-annotated frames.

## Workspace layout

```
flash/
  backend/        — Fastify API + AI pipeline (pnpm package: flash-backend)
  frontend/       — React + Vite SPA (pnpm package: flash-frontend)
  docs/           — Design specs and plans
  docker-compose.yml
  pnpm-workspace.yaml
```

## Always use pnpm

```bash
pnpm install                              # install all workspace deps
pnpm dev                                  # run backend + frontend together
pnpm --filter flash-backend <script>      # run a backend script
pnpm --filter flash-frontend <script>     # run a frontend script
pnpm --filter flash-backend test          # run tests
pnpm --filter flash-backend build         # compile backend TypeScript
pnpm tsc --noEmit                         # type-check without compiling
```

Never use `npm` or `yarn`.

## Ports

- Frontend (Vite dev): **http://localhost:5174** (5173 may be in use by another project)
- Backend API: **http://localhost:3001**

## Backend structure

```
backend/src/
  index.ts              Fastify server + Socket.io init
  config.ts             Reads env vars
  db.ts                 Prisma client singleton
  camera-worker.ts      Spawns ffmpeg + AI pipeline per camera; polls DB every 60s
  stream/
    extractor.ts        URL → playable HLS/RTSP URL (handles verkeerscentrum.be player pages)
    capturer.ts         ffmpeg → PassThrough → JPEG frame events at 2fps
  ai/
    detector.ts         YOLOv8n ONNX — detect(rgbBuffer, width, height) → DetectionResult[]
    tracker.ts          IoU + velocity-prediction tracker; EMA-smoothed boxes; 2-frame confirmation
    pipeline.ts         Orchestrates: JPEG decode → detect → track → count → speed → annotate
    annotator.ts        Draws bounding boxes + counting lines on frames using @napi-rs/canvas
  analysis/
    homography.ts       computeHomography(pairs) → 3×3 matrix; applyHomography(H, px, py) → {wx, wy}
    counter.ts          DirectionCounter — tracks per-vehicle state, counts A→B and B→A crossings
    speed.ts            SpeedCalculator — median speed from world-position history with EMA smoothing
  routes/
    cameras.ts          REST CRUD, HLS proxy (/api/cameras/:id/hls/*), calibration endpoint
  socket/
    server.ts           Socket.io setup; emitFrame(); getLatestFrame()
```

## Frontend structure

```
frontend/src/
  pages/
    Dashboard.tsx       Camera grid — HLS stream + AI view toggle; vehicle counts + tags
    CameraCalibrate.tsx Calibration UI — snapshot picker, satellite map with search, settings
    Cameras.tsx         Camera CRUD list
    PiDisplay.tsx       Minimal display for Raspberry Pi screens
  components/
    HlsPlayer.tsx       HLS.js player with buffering config and status feedback
    LiveFeed.tsx        Canvas-based display for socket.io annotated frames
    CounterDisplay.tsx  AB/BA count display (legacy — Dashboard uses inline now)
    FramePointPicker.tsx  Konva canvas for clicking calibration points on a snapshot
    SpeedDisplay.tsx    Speed display component
  hooks/
    useCameraFeed.ts    Socket.io subscription → lastFrame, fps, counts, vehicles, avgSpeedKmh
    useCameras.ts       TanStack Query wrapper for GET /api/cameras
  lib/
    api.ts              Typed fetch wrappers for all REST endpoints
    socket.ts           Socket.io client singleton
```

## Critical constraints

### JPEG decode before detection
`detector.detect()` takes **raw RGB bytes** (not JPEG). `pipeline.process()` uses `@napi-rs/canvas` `loadImage()` to decode the JPEG frame first, then extracts raw pixels. **Never pass a JPEG buffer directly to the detector.**

### Frame dimensions are dynamic
The verkeerscentrum stream is 768×576 (not 1280×720). Pipeline reads actual dimensions from the decoded image and rebuilds `DirectionCounter` if they change. Hardcoded dimensions anywhere else are bugs.

### Bottom-center for speed/counting
`TrackedVehicle` has `bcx`/`bcy` (bottom-center = ground contact). Use these — not `cx`/`cy` — in `speedCalc.addPosition()` and `counter.updateVehicle()`. The homography was calibrated to the ground plane.

### ffmpeg on macOS
`ffmpeg-static` is killed by Gatekeeper (exit 137). `capturer.ts` prefers `/opt/homebrew/bin/ffmpeg`. Don't add `-re` flag — that throttles live streams.

### HLS proxy headers
Verkeerscentrum.be requires `Referer: https://www.verkeerscentrum.be/` and a browser User-Agent on every request. The proxy in `cameras.ts` sends these; ffmpeg also needs them (via `-headers` input option).

### Track confirmation
Tracks must appear for `minConfirmedFrames = 2` frames before being reported. Single-frame detections are suppressed to prevent ghost vehicles.

### EMA smoothing
- Tracker: bounding boxes are EMA-smoothed (α = 0.55) for display stability
- SpeedCalculator: world positions are EMA-smoothed (α = 0.65 new, 0.35 old) before storage
- Speed is computed as the **median of consecutive-pair instant speeds** — robust to projection outliers

### Docker base image
Use `node:20-slim` (Debian/glibc). Alpine (musl) breaks `onnxruntime-node`. Prisma needs `binaryTargets = ["native", "debian-openssl-3.0.x"]`.

## Database

Prisma schema at `backend/prisma/schema.prisma`. Three models:
- `Camera` — stream config, calibration data, counting line positions
- `TrafficEvent` — individual vehicle crossings (direction, class, speed, isSpeeder)
- `DailyCount` — aggregated per-camera per-day totals

Run migrations: `pnpm --filter flash-backend exec prisma migrate deploy`

## Tests

Backend tests at `backend/src/__tests__/`. Run with `pnpm --filter flash-backend test`.

## Environment

```
backend/.env:
  DATABASE_URL=postgresql://...
  PORT=3001

frontend/.env:
  VITE_GOOGLE_MAPS_API_KEY=...    (optional, enables map on calibration page)
```

## Common tasks

### Add a new API endpoint
1. Add route in `backend/src/routes/cameras.ts` (or a new file registered in `index.ts`)
2. Add typed fetch wrapper in `frontend/src/lib/api.ts`
3. Use `pnpm tsc --noEmit` to verify types

### Add a new frontend page
1. Create `frontend/src/pages/MyPage.tsx`
2. Register route in `frontend/src/App.tsx`
3. Add nav link in the `Layout` component if it should appear in the nav

### Modify detection behaviour
- Confidence threshold: `CONF_THRESHOLD` in `detector.ts`
- Track persistence: `maxMissedFrames` in `tracker.ts`
- Confirmation requirement: `minConfirmedFrames` in `tracker.ts`
- Speed smoothing: EMA alpha in `speed.ts`
- Box smoothing: `BOX_ALPHA` in `tracker.ts`

### Add a new vehicle class
COCO class indices in `VEHICLE_CLASSES` dict in `detector.ts`. Class colors in `CLASS_COLORS` in `annotator.ts`.

## What not to do

- Don't use `npm`, `yarn`, or `npx` — always `pnpm`
- Don't pass JPEG buffers to `detector.detect()` — decode first
- Don't hardcode frame dimensions — read from actual decoded image
- Don't use `__dirname` for model path — use `process.cwd()`
- Don't add `-re` to ffmpeg options for live streams
- Don't use `node:20-alpine` in Docker — use `node:20-slim`
- Don't commit `backend/.env` or `frontend/.env`
