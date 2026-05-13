# Traffic Camera Analysis — Design Spec

**Date:** 2026-05-13  
**Status:** Approved

## Overview

A system that captures live traffic camera streams from verkeerscentrum.be, detects vehicles using YOLOv8, estimates their speed (in km/u), counts them per direction, and displays results in real-time on a central dashboard and per-camera Raspberry Pi displays.

---

## Architecture

```
VPS (Docker Compose)
├── backend/        Node.js + TypeScript — stream capture, AI analysis, WebSocket server
├── frontend/       React + TypeScript — dashboard + Pi display views
└── postgres        persistent storage for camera configs, calibration, traffic counts
```

All components run in Docker Compose on a single VPS. Raspberry Pi devices are thin browser clients — they open the React frontend and display the per-camera view. No code runs on the Pi beyond a browser.

---

## Stream Capture

Traffic camera streams from verkeerscentrum.be are delivered via MediaSource Extensions (blob URLs). The actual underlying stream is HLS (`.m3u8`).

**Approach:** `yt-dlp` (containerized) extracts the real HLS stream URL from the camera page. During implementation this must be verified against verkeerscentrum.be — if yt-dlp cannot resolve the stream, fallback is Playwright headless browser to intercept network requests and capture the m3u8 URL. `fluent-ffmpeg` then captures frames at a configurable interval (default: 2fps) and pipes them as JPEG buffers to the AI pipeline.

If `yt-dlp` cannot resolve a stream, the system logs the failure and retries on a 60-second interval. Camera status is surfaced in the dashboard (live / error / reconnecting).

---

## AI Pipeline

Each frame passes through a two-stage pipeline:

### 1. Detection — YOLOv8n ONNX
- Model: `yolov8n.onnx` (pre-trained COCO, classes filtered to: car, truck, bus, motorcycle)
- Runtime: `onnxruntime-node`
- Output: bounding boxes with class + confidence score
- Runs on CPU (VPS); GPU optional via ONNX execution provider if available

### 2. Tracking — ByteTrack
- Assigns persistent IDs to detected vehicles across frames
- Enables trajectory reconstruction (needed for speed + direction)
- Library: `@aitrans/bytetrack` (JS port) or a Python ByteTrack process called via Node child_process as fallback

### 3. Speed Estimation
- Per-camera calibration: user sets a reference distance in meters (e.g., lane width = 3.5m mapped to N pixels)
- Speed = (pixels moved between frames × meters/pixel) / (frame interval in seconds) × 3.6
- Smoothed over 5 frames to reduce noise
- Speed displayed in km/u

### 4. Direction Counting
- Two virtual counting lines defined per camera (configurable position as % of frame height/width)
- When a tracked vehicle crosses a line, its direction is recorded (A→B or B→A)
- Counts reset daily at midnight; historical counts stored in PostgreSQL

---

## Data Flow

```
verkeerscentrum.be HLS stream
        ↓ yt-dlp extracts m3u8 URL
        ↓ fluent-ffmpeg captures frames @ 2fps
        ↓ YOLOv8n ONNX detects vehicles
        ↓ ByteTrack assigns IDs + trajectories
        ↓ Speed + direction calculated
        ↓ Annotated JPEG + metadata emitted via Socket.io
        ↓
   ┌────┴────┐
Dashboard   Pi display (1 per camera)
```

Backend emits one Socket.io event per camera per frame:
```typescript
{
  cameraId: string,
  frame: string,          // base64 JPEG with bounding boxes drawn
  vehicles: [{
    id: number,
    class: string,
    speed: number,        // km/u, null if not yet estimated
    direction: 'AB' | 'BA' | null
  }],
  counts: { AB: number, BA: number }, // today's totals
  timestamp: number
}
```

---

## REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cameras` | List all cameras |
| POST | `/api/cameras` | Add a camera (name, url, location) |
| PUT | `/api/cameras/:id` | Update camera (name, calibration, counting lines) |
| DELETE | `/api/cameras/:id` | Remove a camera |
| GET | `/api/cameras/:id/stats` | Historical traffic counts |

---

## Database Schema (PostgreSQL via Prisma)

**cameras**
- `id`, `name`, `location`, `streamUrl`, `active`
- `calibrationMeters` — reference distance in meters
- `calibrationPixels` — corresponding pixel distance
- `countingLineA`, `countingLineB` — JSON (line position as fraction 0–1)

**traffic_events**
- `id`, `cameraId`, `timestamp`, `direction`, `vehicleClass`, `speedKmh`

**daily_counts**
- `id`, `cameraId`, `date`, `directionAB`, `directionBA`

---

## Frontend Screens

### 1. Dashboard (`/`)
- Grid of camera cards (configurable columns)
- Each card: live annotated frame, current speed (avg last 30s), today's count (both directions), status indicator
- Top bar: total vehicle count across all cameras today
- Alert if any camera is offline or has errors

### 2. Camera Management (`/cameras`)
- List of cameras with add / edit / delete
- Add form: name, location label, stream URL (from verkeerscentrum.be)
- Edit: calibration wizard — user clicks two known points on the frame and enters real-world distance in meters; counting lines draggable on the frame

### 3. Pi Display View (`/display/:cameraId`)
- Fullscreen, no navigation chrome
- Large annotated live feed
- Prominent counters (direction A and direction B) and current average speed
- Optimized for small screens (min 480px wide)
- Auto-reconnects if WebSocket drops

---

## Error Handling

- **Stream unavailable:** retry every 60s, show "reconnecting" status in dashboard
- **Detection failure:** log frame, skip, continue — never crash the pipeline
- **WebSocket disconnect:** clients auto-reconnect with exponential backoff
- **Database unavailable:** backend queues counts in-memory, flushes on reconnect

---

## Docker Compose Services

```yaml
services:
  backend:    node:20-alpine + yt-dlp + ffmpeg binaries
  frontend:   nginx serving built React app
  postgres:   postgres:16-alpine
```

All services on an internal Docker network. Only the frontend (port 80/443) and backend WebSocket (port 3001) are exposed externally.

---

## Open Source Dependencies

| Package | Purpose |
|---------|---------|
| `fluent-ffmpeg` | HLS frame extraction |
| `onnxruntime-node` | YOLOv8 ONNX inference |
| `bytetrack` (TS port) | Multi-object tracking |
| `socket.io` | Realtime WebSocket |
| `fastify` | REST API |
| `prisma` | PostgreSQL ORM |
| `socket.io-client` | Frontend WebSocket client |
| `react-konva` | Canvas annotations (bounding boxes) |
| `@tanstack/react-query` | API data fetching |
| `recharts` | Traffic history charts |
| `tailwindcss` + `shadcn/ui` | UI components |
| `yt-dlp` | HLS stream URL extraction |

---

## Out of Scope

- License plate recognition
- Authentication / access control (can be added later via reverse proxy)
- Mobile app
- Alerting / notifications (Slack, email)
