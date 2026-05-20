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

## Deploying with Komodo (NVIDIA GPU server)

Flash ships with a Docker Compose setup designed for Komodo + Traefik. The backend runs ONNX inference via the CUDA execution provider; it falls back to CPU if no GPU is present.

### Prerequisites on the target server

**1. NVIDIA Container Toolkit**

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

On WSL2, also generate CDI specs after installing the toolkit:

```bash
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
```

Verify GPU passthrough works:

```bash
docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu22.04 nvidia-smi
```

### Accessing Flash via Tailscale

With the default compose setup Flash binds to port 80 on the host. Once deployed, open `http://<ryzen-tailscale-ip>` from any device on your Tailscale network.

To use a different port set `FLASH_PORT` in the Stack environment, e.g. `FLASH_PORT=8080`.

### Setting up Komodo

**1. Run Komodo Core** (the management UI — can be on the same server)

```yaml
# ~/komodo/compose.yaml
services:
  komodo:
    image: ghcr.io/moghtech/komodo/core:latest
    restart: unless-stopped
    depends_on:
      - mongo
    ports:
      - 9120:9120
    env_file: ./core.env
    volumes:
      - repo-cache:/repo-cache

  mongo:
    image: mongo
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: changeme

volumes:
  repo-cache:
  mongo-data:
```

```
# ~/komodo/core.env
KOMODO_DATABASE_ADDRESS=mongodb://admin:changeme@mongo:27017
KOMODO_PASSKEY=pick-a-strong-passkey
KOMODO_JWT_SECRET=pick-a-jwt-secret
```

```bash
cd ~/komodo && docker compose up -d
```

Open `http://<server-ip>:9120` and create your admin account.

**2. Run Komodo Periphery** on each managed server

```yaml
# ~/komodo-periphery/compose.yaml
services:
  periphery:
    image: ghcr.io/moghtech/komodo/periphery:latest
    restart: unless-stopped
    ports:
      - 8120:8120
    env_file: ./periphery.env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /proc:/proc
      - stacks:/stacks

volumes:
  stacks:
```

```
# ~/komodo-periphery/periphery.env
PERIPHERY_PASSKEY=same-passkey-as-core
PERIPHERY_ROOT_DIRECTORY=/stacks
```

```bash
cd ~/komodo-periphery && docker compose up -d
```

### Deploying Flash as a Komodo Stack

1. In the Komodo UI go to **Servers** → **New Server**, set address to `http://<server-ip>:8120` and the passkey.
2. Go to **Stacks** → **New Stack** and configure:
   - **Server**: the server you just added
   - **Repo**: this repository's URL
   - **Branch**: `main`
   - **Compose file path**: `docker-compose.yml`
3. Under **Environment** add:
   ```
   DATABASE_URL=postgresql://user:pass@host/dbname
   FLASH_DOMAIN=flash.yourdomain.com
   NODE_ENV=production
   VITE_GOOGLE_MAPS_API_KEY=        # optional
   ```
4. Click **Deploy**. Komodo clones the repo, builds both images on the server, and starts the stack.

The backend image is built from `nvidia/cuda:12.8.0-cudnn-runtime-ubuntu22.04` and uses the CUDA execution provider for ONNX inference. GPU utilisation should be visible in `nvidia-smi` while a camera is active.

### Automatic deploys on push

Komodo can redeploy the stack automatically whenever you push to `main`.

**1. Enable webhook in Komodo**

In the Stack settings, open the **Webhooks** tab. Komodo shows you a generated URL in this format:

```
https://<komodo-core-url>/listener/github/<stack-id>?secret=<webhook-secret>
```

Copy that URL and the secret.

**2. Add the webhook in GitHub**

Go to your repo → **Settings** → **Webhooks** → **Add webhook**:

| Field | Value |
|---|---|
| Payload URL | the URL from Komodo |
| Content type | `application/json` |
| Secret | the secret from Komodo |
| Events | Just the **push** event |

**3. Enable auto-redeploy on the Stack**

In the Stack settings, turn on **Auto redeploy**. Komodo will trigger a `docker compose up --build --pull` on every push to the configured branch.

**What happens on each push:**
1. GitHub sends a webhook to Komodo Core (on the VPS)
2. Komodo Core instructs the Periphery on the Ryzen machine
3. Periphery pulls the latest commit, rebuilds both images, and restarts the stack
4. Logs are visible live in the Komodo UI under the Stack's **Logs** tab

**Tip:** if a deploy breaks the app, the **Stack** page has a one-click **Redeploy** that lets you pick any previous commit to roll back to.

---

## Known limitations / next steps

- Speed measurement requires calibration — uncalibrated cameras show "calibrate for speed" in the dashboard
- The YOLOv8n model is fast but small — upgrade to YOLOv8s or YOLOv8m for better accuracy in difficult conditions
- No persistent traffic event storage UI yet (data is stored in `TrafficEvent` table but not shown)
- verkeerscentrum.be HLS segments are ~9s long → ~30s buffering before smooth playback starts
