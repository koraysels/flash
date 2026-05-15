# Flash — Traffic Monitoring System

Flash monitors road traffic from live camera streams. It detects vehicles using AI, counts them by direction, and measures their speed. You see everything in a web dashboard.

## What it does

- **Pulls live HLS streams** from traffic cameras (supports verkeerscentrum.be and any direct HLS/RTSP URL)
- **Detects vehicles** using YOLOv8n — cars, trucks, buses, motorcycles
- **Counts direction** — how many vehicles crossed from line A to line B vs B to A
- **Measures speed** — requires a one-time calibration step that maps camera pixels to real-world metres
- **Flags speeders** — alerts when a vehicle exceeds your configured speed limit
- **Live dashboard** — shows the video stream and AI-annotated view side by side

---

## Running locally (development)

### Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- ffmpeg via Homebrew: `brew install ffmpeg`
- A PostgreSQL database (e.g. [Neon](https://neon.tech) — free tier works)

### 1. Clone and install

```bash
git clone <repo>
cd flash
pnpm install
```

### 2. Configure the backend

Create `backend/.env`:

```env
DATABASE_URL=postgresql://user:pass@host/dbname
PORT=3001
```

Run migrations:

```bash
pnpm --filter flash-backend exec prisma migrate deploy
```

Download the YOLOv8n ONNX model:

```bash
mkdir -p backend/models
curl -L -o backend/models/yolov8n.onnx \
  https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.onnx
```

### 3. Configure the frontend (optional — only needed for calibration map)

Create `frontend/.env`:

```env
VITE_GOOGLE_MAPS_API_KEY=your_key_here
```

Get a key at [Google Cloud Console](https://console.cloud.google.com) → Maps JavaScript API + Places API.

### 4. Start everything

```bash
pnpm dev
```

Opens:
- Frontend: http://localhost:5174
- Backend API: http://localhost:3001

---

## Adding your first camera

1. Go to **Cameras** → **Add camera**
2. Paste a stream URL. Supported formats:
   - `https://players.media.verkeerscentrum.be/?name=WEB_1__...` (verkeerscentrum.be player page)
   - `https://hls.media.verkeerscentrum.be/....stream/playlist.m3u8` (direct HLS)
   - Any `.m3u8`, `.m3u`, `rtsp://`, `rtmp://` URL
3. Save. The camera starts capturing within ~30 seconds.

---

## Calibrating for speed measurement

Speed requires knowing how pixels in the camera image correspond to real-world distances. This one-time calibration step sets that up.

1. Go to **Cameras** → **Calibrate** on the camera
2. A snapshot from the live feed loads automatically (or upload a screenshot)
3. Use the map search bar to navigate to the camera location on satellite view
4. Click a recognisable point in the camera image (road marking, lamp post, etc.)
5. Click the **same physical point** on the satellite map
6. Repeat at least 4 times — spread across the frame
7. Set the speed limit and counting line positions
8. Click **Save calibration**

The more calibration pairs you add, and the more spread across the frame they are, the more accurate the speed readings will be.

### Counting lines

Two horizontal lines (A and B) cross the frame. A vehicle is counted when it crosses from one line to the other:
- **A → B** = moving from the upper line to the lower line
- **B → A** = moving from the lower line to the upper line

Set their position as a fraction of frame height (0 = top, 1 = bottom). Default: A at 0.4, B at 0.6.

---

## Dashboard

Each camera card shows:

| Element | What it means |
|---|---|
| **AI active · N fps** | Backend is processing frames, N per second |
| **📺 Live stream** | Smooth HLS video (~30s buffer, no AI overlay) |
| **🤖 AI view** | 2fps annotated frames with bounding boxes and counting lines |
| **Line A → B** | Vehicles counted moving top-to-bottom through the frame |
| **Line B → A** | Vehicles counted moving bottom-to-top |
| **Currently in frame** | Vehicle tags showing class and speed (if calibrated) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                      │
│  ┌──────────────┐  ┌──────────────────────────────────────┐ │
│  │ React + Vite  │  │ HLS.js player                        │ │
│  │ Dashboard     │  │ (raw smooth stream)                   │ │
│  │ Socket.io     │  └──────────────────────────────────────┘ │
│  │ (AI frames,   │                                            │
│  │  counts)      │                                            │
│  └──────────────┘                                             │
└────────────────┬──────────────────────────────────────────────┘
                 │ HTTP + WebSocket
┌────────────────▼──────────────────────────────────────────────┐
│  Fastify backend                                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ HLS proxy        │  │ Camera workers   │  │ Socket.io    │ │
│  │ /api/cameras/    │  │ ffmpeg → JPEG    │  │ per-camera   │ │
│  │ :id/hls/*        │  │ frames @ 2fps    │  │ rooms        │ │
│  └─────────────────┘  └────────┬─────────┘  └──────────────┘ │
│                                 │                               │
│                        ┌────────▼─────────┐                   │
│                        │  AI Pipeline      │                   │
│                        │  YOLOv8n ONNX     │                   │
│                        │  → detect         │                   │
│                        │  → track (IoU +   │                   │
│                        │     prediction)   │                   │
│                        │  → count (A↔B)    │                   │
│                        │  → speed (m/s →   │                   │
│                        │     km/h)         │                   │
│                        └────────┬─────────┘                   │
│                                 │                               │
│                        ┌────────▼─────────┐                   │
│                        │  PostgreSQL       │                   │
│                        │  (Prisma ORM)     │                   │
│                        └──────────────────┘                   │
└────────────────────────────────────────────────────────────────┘
```

### Key files

```
backend/src/
  index.ts              — Fastify server setup + Socket.io init
  camera-worker.ts      — Manages one ffmpeg+pipeline per active camera
  stream/
    extractor.ts        — Resolves any URL to a playable HLS/RTSP stream
    capturer.ts         — ffmpeg → JPEG frame stream (2fps)
  ai/
    detector.ts         — YOLOv8n ONNX inference
    tracker.ts          — IoU + motion-prediction tracker, EMA box smoothing
    pipeline.ts         — Orchestrates detect → track → count → annotate
    annotator.ts        — Draws bounding boxes and counting lines on frames
  analysis/
    homography.ts       — Pixel ↔ world coordinate mapping
    counter.ts          — Counts direction crossings (A→B / B→A)
    speed.ts            — Median-based speed from world-position history
  routes/
    cameras.ts          — REST CRUD + HLS proxy + calibration endpoint

frontend/src/
  pages/
    Dashboard.tsx       — Live camera grid with toggle between HLS and AI view
    CameraCalibrate.tsx — Homography calibration with map + snapshot picker
    Cameras.tsx         — Camera management (add/edit/delete)
  components/
    HlsPlayer.tsx       — HLS.js video player with buffering and retry logic
    LiveFeed.tsx        — Canvas-based annotated frame display (socket.io)
  hooks/
    useCameraFeed.ts    — Socket.io subscription for frames + counts
```

---

## Production (Docker)

```bash
docker compose up --build
```

Set environment variables in `backend/.env`. The frontend Dockerfile builds a static bundle served by nginx.

The model is downloaded automatically during the Docker build.

---

## Known limitations / next steps

- Speed measurement requires calibration — uncalibrated cameras show "calibrate for speed" in the dashboard
- The YOLOv8n model is fast but small — upgrade to YOLOv8s or YOLOv8m for better accuracy in difficult conditions
- No persistent traffic event storage UI yet (data is stored in `TrafficEvent` table but not shown)
- verkeerscentrum.be HLS segments are ~9s long → ~30s buffering before smooth playback starts
