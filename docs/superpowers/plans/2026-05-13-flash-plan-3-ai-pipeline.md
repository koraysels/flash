# Flash — Plan 3: AI Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add YOLOv8n vehicle detection, ByteTrack multi-object tracking, and direction counting to the stream pipeline. The Socket.io frame event is extended with bounding boxes, vehicle IDs, and per-direction counts. The frontend renders annotated frames with overlaid bounding boxes and counters.

**Architecture:** Each `FrameCapturer` frame is passed through a `Detector` (YOLOv8n ONNX → bounding boxes), then a `Tracker` (ByteTrack → persistent vehicle IDs + trajectories), then a `DirectionCounter` (virtual counting lines → A→B / B→A tallies). The annotated JPEG and metadata are emitted via the existing Socket.io infrastructure.

**Tech Stack:** onnxruntime-node, @aitrans/bytetrack (or custom ByteTrack port), sharp (JPEG manipulation), canvas (Node.js canvas for drawing bounding boxes)

**Prerequisites:** Plan 1 + Plan 2 complete

---

## File Map

```
backend/
├── models/
│   └── yolov8n.onnx          # downloaded by setup script
├── scripts/
│   └── download-model.ts      # one-time model download
└── src/
    ├── ai/
    │   ├── detector.ts         # YOLOv8 ONNX inference → DetectionResult[]
    │   ├── tracker.ts          # ByteTrack wrapper → TrackedVehicle[]
    │   ├── annotator.ts        # draw boxes on JPEG buffer → Buffer
    │   └── pipeline.ts         # orchestrates detector → tracker → annotator
    └── analysis/
        └── counter.ts          # virtual counting lines → direction tallies

frontend/src/
├── hooks/
│   └── useCameraFeed.ts        # extended with vehicles + counts
└── components/
    ├── LiveFeed.tsx             # renders annotated frame (already draws server-side boxes)
    └── CounterDisplay.tsx       # shows A→B, B→A, speeders counts
```

---

## Task 1: Download YOLOv8n ONNX model

**Files:**
- Create: `backend/scripts/download-model.ts`
- Create: `backend/models/.gitkeep`

- [ ] **Step 1: Add download dependencies**

Add to `backend/package.json` scripts:
```json
"download-model": "tsx scripts/download-model.ts"
```

Add to devDependencies:
```json
"node-fetch": "^3.3.2"
```

Run: `cd backend && npm install`

- [ ] **Step 2: Create backend/scripts/download-model.ts**

```typescript
import { createWriteStream, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'

const MODEL_URL = 'https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n.onnx'
const MODEL_PATH = join(__dirname, '../models/yolov8n.onnx')

async function download() {
  if (existsSync(MODEL_PATH)) {
    console.log('Model already exists, skipping download')
    return
  }

  mkdirSync(join(__dirname, '../models'), { recursive: true })
  console.log('Downloading YOLOv8n ONNX model...')

  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(MODEL_PATH))
  console.log('Model downloaded to', MODEL_PATH)
}

download().catch(console.error)
```

- [ ] **Step 3: Create backend/models/.gitkeep**

```bash
mkdir -p backend/models && touch backend/models/.gitkeep
echo "backend/models/*.onnx" >> .gitignore
```

- [ ] **Step 4: Download the model**

```bash
cd backend && npm run download-model
```

Expected: `Model downloaded to .../models/yolov8n.onnx` (file ~6MB)

- [ ] **Step 5: Add model download to backend Dockerfile**

In `backend/Dockerfile`, add after `RUN npm ci`:

```dockerfile
RUN npm run download-model
```

- [ ] **Step 6: Commit**

```bash
git add backend/scripts/ backend/models/.gitkeep backend/package.json .gitignore
git commit -m "feat: add YOLOv8n ONNX model download script"
```

---

## Task 2: YOLOv8 detector

**Files:**
- Create: `backend/src/ai/detector.ts`
- Create: `backend/tests/ai/detector.test.ts`

- [ ] **Step 1: Add onnxruntime-node**

Add to `backend/package.json` dependencies:
```json
"onnxruntime-node": "^1.18.0"
```

Run: `cd backend && npm install`

- [ ] **Step 2: Write failing test**

```typescript
// backend/tests/ai/detector.test.ts
import { describe, it, expect } from 'vitest'
import { Detector, DetectionResult } from '../../src/ai/detector'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const MODEL_PATH = join(__dirname, '../../models/yolov8n.onnx')

describe.skipIf(!existsSync(MODEL_PATH))('Detector', () => {
  it('initializes and runs inference on a blank image', async () => {
    const detector = new Detector(MODEL_PATH)
    await detector.init()

    // 640x640 black JPEG
    const blankBuffer = Buffer.alloc(640 * 640 * 3, 0)
    const results: DetectionResult[] = await detector.detect(blankBuffer, 640, 640)

    expect(Array.isArray(results)).toBe(true)
    for (const r of results) {
      expect(r).toHaveProperty('x1')
      expect(r).toHaveProperty('y1')
      expect(r).toHaveProperty('x2')
      expect(r).toHaveProperty('y2')
      expect(r).toHaveProperty('confidence')
      expect(r).toHaveProperty('class')
    }
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd backend && npm test tests/ai/detector.test.ts
```

Expected: FAIL — `Detector` not found

- [ ] **Step 4: Create backend/src/ai/detector.ts**

```typescript
import * as ort from 'onnxruntime-node'

export type DetectionResult = {
  x1: number
  y1: number
  x2: number
  y2: number
  confidence: number
  class: string
}

// COCO class indices we care about: 2=car, 3=motorcycle, 5=bus, 7=truck
const VEHICLE_CLASSES: Record<number, string> = {
  2: 'car',
  3: 'motorcycle',
  5: 'bus',
  7: 'truck',
}

const INPUT_SIZE = 640

export class Detector {
  private session: ort.InferenceSession | null = null

  constructor(private readonly modelPath: string) {}

  async init(): Promise<void> {
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
    })
  }

  async detect(rgbBuffer: Buffer, srcWidth: number, srcHeight: number): Promise<DetectionResult[]> {
    if (!this.session) throw new Error('Detector not initialized')

    const inputTensor = this.preprocess(rgbBuffer, srcWidth, srcHeight)
    const feeds = { images: inputTensor }
    const results = await this.session.run(feeds)
    const output = results['output0'].data as Float32Array

    return this.postprocess(output, srcWidth, srcHeight)
  }

  private preprocess(rgbBuffer: Buffer, srcWidth: number, srcHeight: number): ort.Tensor {
    const floatData = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE)
    const scaleX = srcWidth / INPUT_SIZE
    const scaleY = srcHeight / INPUT_SIZE

    for (let y = 0; y < INPUT_SIZE; y++) {
      for (let x = 0; x < INPUT_SIZE; x++) {
        const srcX = Math.min(Math.floor(x * scaleX), srcWidth - 1)
        const srcY = Math.min(Math.floor(y * scaleY), srcHeight - 1)
        const srcIdx = (srcY * srcWidth + srcX) * 3
        floatData[0 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = rgbBuffer[srcIdx] / 255
        floatData[1 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = rgbBuffer[srcIdx + 1] / 255
        floatData[2 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = rgbBuffer[srcIdx + 2] / 255
      }
    }

    return new ort.Tensor('float32', floatData, [1, 3, INPUT_SIZE, INPUT_SIZE])
  }

  private postprocess(output: Float32Array, srcWidth: number, srcHeight: number): DetectionResult[] {
    const numDetections = output.length / 85
    const results: DetectionResult[] = []
    const CONF_THRESHOLD = 0.4

    for (let i = 0; i < numDetections; i++) {
      const offset = i * 85
      const confidence = output[offset + 4]
      if (confidence < CONF_THRESHOLD) continue

      let maxClassScore = 0
      let maxClassIdx = -1
      for (let c = 0; c < 80; c++) {
        const score = output[offset + 5 + c]
        if (score > maxClassScore) {
          maxClassScore = score
          maxClassIdx = c
        }
      }

      if (!VEHICLE_CLASSES[maxClassIdx]) continue
      if (confidence * maxClassScore < CONF_THRESHOLD) continue

      const cx = output[offset] * srcWidth / INPUT_SIZE
      const cy = output[offset + 1] * srcHeight / INPUT_SIZE
      const w = output[offset + 2] * srcWidth / INPUT_SIZE
      const h = output[offset + 3] * srcHeight / INPUT_SIZE

      results.push({
        x1: Math.max(0, cx - w / 2),
        y1: Math.max(0, cy - h / 2),
        x2: Math.min(srcWidth, cx + w / 2),
        y2: Math.min(srcHeight, cy + h / 2),
        confidence,
        class: VEHICLE_CLASSES[maxClassIdx],
      })
    }

    return nms(results, 0.45)
  }
}

function nms(boxes: DetectionResult[], iouThreshold: number): DetectionResult[] {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence)
  const kept: DetectionResult[] = []

  for (const box of sorted) {
    const overlaps = kept.some((k) => iou(box, k) > iouThreshold)
    if (!overlaps) kept.push(box)
  }

  return kept
}

function iou(a: DetectionResult, b: DetectionResult): number {
  const interX1 = Math.max(a.x1, b.x1)
  const interY1 = Math.max(a.y1, b.y1)
  const interX2 = Math.min(a.x2, b.x2)
  const interY2 = Math.min(a.y2, b.y2)
  const interArea = Math.max(0, interX2 - interX1) * Math.max(0, interY2 - interY1)
  const aArea = (a.x2 - a.x1) * (a.y2 - a.y1)
  const bArea = (b.x2 - b.x1) * (b.y2 - b.y1)
  return interArea / (aArea + bArea - interArea)
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd backend && npm test tests/ai/detector.test.ts
```

Expected: 1 test passes (or skipped if model not yet downloaded)

- [ ] **Step 6: Commit**

```bash
git add backend/src/ai/detector.ts backend/tests/ai/detector.test.ts backend/package.json backend/package-lock.json
git commit -m "feat: add YOLOv8n ONNX vehicle detector"
```

---

## Task 3: ByteTrack vehicle tracker

**Files:**
- Create: `backend/src/ai/tracker.ts`
- Create: `backend/tests/ai/tracker.test.ts`

- [ ] **Step 1: Add tracking dependency**

Add to `backend/package.json`:
```json
"bytetrack-node": "^0.1.0"
```

Run: `cd backend && npm install`

If `bytetrack-node` is not available on npm, use this minimal IoU-based tracker instead (implemented in Step 3).

- [ ] **Step 2: Write failing test**

```typescript
// backend/tests/ai/tracker.test.ts
import { describe, it, expect } from 'vitest'
import { Tracker, TrackedVehicle } from '../../src/ai/tracker'
import { DetectionResult } from '../../src/ai/detector'

describe('Tracker', () => {
  it('assigns persistent IDs across frames', () => {
    const tracker = new Tracker()

    const frame1: DetectionResult[] = [
      { x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9, class: 'car' },
    ]
    const tracked1 = tracker.update(frame1)
    expect(tracked1).toHaveLength(1)
    expect(tracked1[0].id).toBeDefined()

    const frame2: DetectionResult[] = [
      { x1: 110, y1: 105, x2: 210, y2: 205, confidence: 0.9, class: 'car' },
    ]
    const tracked2 = tracker.update(frame2)
    expect(tracked2).toHaveLength(1)
    expect(tracked2[0].id).toBe(tracked1[0].id)
  })

  it('assigns new ID for new vehicle', () => {
    const tracker = new Tracker()
    const frame1: DetectionResult[] = [
      { x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9, class: 'car' },
    ]
    const tracked1 = tracker.update(frame1)

    const frame2: DetectionResult[] = [
      { x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9, class: 'car' },
      { x1: 400, y1: 400, x2: 500, y2: 500, confidence: 0.9, class: 'truck' },
    ]
    const tracked2 = tracker.update(frame2)
    expect(tracked2).toHaveLength(2)
    const ids = tracked2.map((t) => t.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toContain(tracked1[0].id)
  })
})
```

- [ ] **Step 3: Create backend/src/ai/tracker.ts**

```typescript
import { DetectionResult } from './detector'

export type TrackedVehicle = DetectionResult & {
  id: number
  cx: number
  cy: number
  history: Array<{ cx: number; cy: number; timestamp: number }>
  missedFrames: number
}

let nextId = 1

export class Tracker {
  private tracks: TrackedVehicle[] = []
  private readonly maxMissedFrames = 5
  private readonly iouThreshold = 0.3

  update(detections: DetectionResult[]): TrackedVehicle[] {
    const now = Date.now()

    // Match detections to existing tracks by IoU
    const matched = new Set<number>()
    const usedDetections = new Set<number>()

    for (const track of this.tracks) {
      let bestIou = this.iouThreshold
      let bestIdx = -1

      detections.forEach((det, idx) => {
        if (usedDetections.has(idx)) return
        const score = iou(track, det)
        if (score > bestIou) {
          bestIou = score
          bestIdx = idx
        }
      })

      if (bestIdx !== -1) {
        const det = detections[bestIdx]
        const cx = (det.x1 + det.x2) / 2
        const cy = (det.y1 + det.y2) / 2
        track.x1 = det.x1
        track.y1 = det.y1
        track.x2 = det.x2
        track.y2 = det.y2
        track.cx = cx
        track.cy = cy
        track.confidence = det.confidence
        track.history.push({ cx, cy, timestamp: now })
        if (track.history.length > 30) track.history.shift()
        track.missedFrames = 0
        matched.add(track.id)
        usedDetections.add(bestIdx)
      } else {
        track.missedFrames++
      }
    }

    // Remove lost tracks
    this.tracks = this.tracks.filter((t) => t.missedFrames < this.maxMissedFrames)

    // Create new tracks for unmatched detections
    detections.forEach((det, idx) => {
      if (usedDetections.has(idx)) return
      const cx = (det.x1 + det.x2) / 2
      const cy = (det.y1 + det.y2) / 2
      this.tracks.push({
        ...det,
        id: nextId++,
        cx,
        cy,
        history: [{ cx, cy, timestamp: now }],
        missedFrames: 0,
      })
    })

    return this.tracks.filter((t) => t.missedFrames === 0)
  }

  reset(): void {
    this.tracks = []
  }
}

function iou(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }): number {
  const ix1 = Math.max(a.x1, b.x1)
  const iy1 = Math.max(a.y1, b.y1)
  const ix2 = Math.min(a.x2, b.x2)
  const iy2 = Math.min(a.y2, b.y2)
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
  const aArea = (a.x2 - a.x1) * (a.y2 - a.y1)
  const bArea = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (aArea + bArea - inter)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npm test tests/ai/tracker.test.ts
```

Expected: 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add backend/src/ai/tracker.ts backend/tests/ai/tracker.test.ts backend/package.json backend/package-lock.json
git commit -m "feat: add IoU-based multi-object vehicle tracker"
```

---

## Task 4: Direction counter

**Files:**
- Create: `backend/src/analysis/counter.ts`
- Create: `backend/tests/analysis/counter.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// backend/tests/analysis/counter.test.ts
import { describe, it, expect } from 'vitest'
import { DirectionCounter } from '../../src/analysis/counter'

describe('DirectionCounter', () => {
  it('counts AB crossing when vehicle moves downward past lineB', () => {
    // Frame is 100px tall, lineA at 40%, lineB at 60%
    const counter = new DirectionCounter(100, 0.4, 0.6)

    // Vehicle moves from y=30 to y=70 (crosses both lines downward = A→B)
    counter.updateVehicle(1, 30)
    counter.updateVehicle(1, 50)
    counter.updateVehicle(1, 70)

    const counts = counter.getCounts()
    expect(counts.AB).toBe(1)
    expect(counts.BA).toBe(0)
  })

  it('counts BA crossing when vehicle moves upward past lineA', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)

    counter.updateVehicle(2, 70)
    counter.updateVehicle(2, 50)
    counter.updateVehicle(2, 30)

    const counts = counter.getCounts()
    expect(counts.AB).toBe(0)
    expect(counts.BA).toBe(1)
  })

  it('resets counts', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)
    counter.updateVehicle(3, 30)
    counter.updateVehicle(3, 70)
    counter.reset()
    expect(counter.getCounts()).toEqual({ AB: 0, BA: 0 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npm test tests/analysis/counter.test.ts
```

Expected: FAIL — `DirectionCounter` not found

- [ ] **Step 3: Create backend/src/analysis/counter.ts**

```typescript
type VehicleState = {
  lastY: number
  crossedA: boolean
  crossedB: boolean
  direction: 'up' | 'down' | null
}

export type Counts = { AB: number; BA: number }

export class DirectionCounter {
  private vehicles = new Map<number, VehicleState>()
  private counts: Counts = { AB: 0, BA: 0 }
  private readonly lineAY: number
  private readonly lineBY: number

  constructor(frameHeight: number, lineAFraction: number, lineBFraction: number) {
    this.lineAY = frameHeight * lineAFraction
    this.lineBY = frameHeight * lineBFraction
  }

  updateVehicle(vehicleId: number, cy: number): void {
    if (!this.vehicles.has(vehicleId)) {
      this.vehicles.set(vehicleId, { lastY: cy, crossedA: false, crossedB: false, direction: null })
      return
    }

    const state = this.vehicles.get(vehicleId)!
    const direction = cy > state.lastY ? 'down' : 'up'
    state.direction = direction

    if (direction === 'down') {
      if (!state.crossedA && cy > this.lineAY) state.crossedA = true
      if (state.crossedA && !state.crossedB && cy > this.lineBY) {
        state.crossedB = true
        this.counts.AB++
      }
    } else {
      if (!state.crossedB && cy < this.lineBY) state.crossedB = true
      if (state.crossedB && !state.crossedA && cy < this.lineAY) {
        state.crossedA = true
        this.counts.BA++
      }
    }

    state.lastY = cy
  }

  removeVehicle(vehicleId: number): void {
    this.vehicles.delete(vehicleId)
  }

  getCounts(): Counts {
    return { ...this.counts }
  }

  reset(): void {
    this.vehicles.clear()
    this.counts = { AB: 0, BA: 0 }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npm test tests/analysis/counter.test.ts
```

Expected: 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add backend/src/analysis/counter.ts backend/tests/analysis/counter.test.ts
git commit -m "feat: add direction counter with virtual counting lines"
```

---

## Task 5: Frame annotator

**Files:**
- Create: `backend/src/ai/annotator.ts`

- [ ] **Step 1: Add canvas dependency**

Add to `backend/package.json`:
```json
"canvas": "^2.11.2",
"jpeg-js": "^0.4.4",
"@types/jpeg-js": "^0.4.4"
```

Run: `cd backend && npm install`

- [ ] **Step 2: Create backend/src/ai/annotator.ts**

```typescript
import { createCanvas, loadImage } from 'canvas'
import { TrackedVehicle } from './tracker'

const CLASS_COLORS: Record<string, string> = {
  car: '#3b82f6',
  truck: '#f59e0b',
  bus: '#10b981',
  motorcycle: '#8b5cf6',
}

export async function annotateFrame(
  jpegBuffer: Buffer,
  vehicles: TrackedVehicle[],
  lineAFraction: number,
  lineBFraction: number,
): Promise<Buffer> {
  const img = await loadImage(jpegBuffer)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')

  ctx.drawImage(img, 0, 0)

  // Draw counting lines
  const lineAY = img.height * lineAFraction
  const lineBY = img.height * lineBFraction

  ctx.strokeStyle = 'rgba(255,255,0,0.6)'
  ctx.lineWidth = 2
  ctx.setLineDash([8, 4])
  ctx.beginPath()
  ctx.moveTo(0, lineAY)
  ctx.lineTo(img.width, lineAY)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(0, lineBY)
  ctx.lineTo(img.width, lineBY)
  ctx.stroke()
  ctx.setLineDash([])

  // Draw bounding boxes
  for (const v of vehicles) {
    const color = CLASS_COLORS[v.class] ?? '#ffffff'
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.strokeRect(v.x1, v.y1, v.x2 - v.x1, v.y2 - v.y1)

    const label = `#${v.id} ${v.class}`
    ctx.fillStyle = color
    ctx.fillRect(v.x1, v.y1 - 18, ctx.measureText(label).width + 8, 18)
    ctx.fillStyle = '#000'
    ctx.font = '12px monospace'
    ctx.fillText(label, v.x1 + 4, v.y1 - 4)
  }

  return canvas.toBuffer('image/jpeg', { quality: 0.8 })
}
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/ai/annotator.ts backend/package.json backend/package-lock.json
git commit -m "feat: add frame annotator with bounding boxes and counting lines"
```

---

## Task 6: AI pipeline orchestrator + extend socket event

**Files:**
- Create: `backend/src/ai/pipeline.ts`
- Modify: `backend/src/socket/server.ts`
- Modify: `backend/src/camera-worker.ts`

- [ ] **Step 1: Create backend/src/ai/pipeline.ts**

```typescript
import { Detector } from './detector'
import { Tracker } from './tracker'
import { annotateFrame } from './annotator'
import { DirectionCounter } from '../analysis/counter'
import { db } from '../db'
import { join } from 'path'

const MODEL_PATH = join(__dirname, '../../models/yolov8n.onnx')

export type PipelineResult = {
  annotatedFrame: Buffer
  vehicles: Array<{
    id: number
    class: string
    speedKmh: number | null
    direction: 'AB' | 'BA' | null
  }>
  counts: { AB: number; BA: number; speeders: number }
}

export class CameraPipeline {
  private detector: Detector
  private tracker: Tracker
  private counter: DirectionCounter
  private initialized = false
  private speeders = 0

  constructor(
    private readonly cameraId: string,
    private readonly frameWidth: number,
    private readonly frameHeight: number,
    private readonly lineA: number,
    private readonly lineB: number,
    private readonly maxSpeedKmh: number | null,
  ) {
    this.detector = new Detector(MODEL_PATH)
    this.tracker = new Tracker()
    this.counter = new DirectionCounter(frameHeight, lineA, lineB)
  }

  async init(): Promise<void> {
    await this.detector.init()
    this.initialized = true
  }

  async process(jpegBuffer: Buffer): Promise<PipelineResult> {
    if (!this.initialized) throw new Error('Pipeline not initialized')

    const detections = await this.detector.detect(jpegBuffer, this.frameWidth, this.frameHeight)
    const tracked = this.tracker.update(detections)

    for (const v of tracked) {
      this.counter.updateVehicle(v.id, v.cy)
    }

    const counts = this.counter.getCounts()

    const vehicles = tracked.map((v) => {
      const speedKmh = null // filled in Plan 4 after homography calibration
      const isSpeeder = this.maxSpeedKmh !== null && speedKmh !== null && speedKmh > this.maxSpeedKmh
      if (isSpeeder) this.speeders++
      return {
        id: v.id,
        class: v.class,
        speedKmh,
        direction: null as 'AB' | 'BA' | null,
      }
    })

    const annotatedFrame = await annotateFrame(jpegBuffer, tracked, this.lineA, this.lineB)

    return { annotatedFrame, vehicles, counts: { ...counts, speeders: this.speeders } }
  }

  resetDailyCounts(): void {
    this.counter.reset()
    this.speeders = 0
  }
}
```

- [ ] **Step 2: Update backend/src/socket/server.ts FrameEvent type**

Replace the `FrameEvent` type:

```typescript
export type VehicleInfo = {
  id: number
  class: string
  speedKmh: number | null
  direction: 'AB' | 'BA' | null
}

export type FrameEvent = {
  cameraId: string
  frame: string
  timestamp: number
  vehicles: VehicleInfo[]
  counts: { AB: number; BA: number; speeders: number }
}
```

- [ ] **Step 3: Update camera-worker.ts to use pipeline**

Replace the camera worker's `startWorker` method to pipe frames through the AI pipeline:

```typescript
private async startWorker(cameraId: string, pageUrl: string): Promise<void> {
  try {
    const camera = await db.camera.findUniqueOrThrow({ where: { id: cameraId } })
    const streamUrl = await extractStreamUrl(pageUrl)
    const capturer = new FrameCapturer(streamUrl, cameraId)

    const pipeline = new CameraPipeline(
      cameraId,
      1280, 720,
      camera.countingLineA,
      camera.countingLineB,
      camera.maxSpeedKmh,
    )
    await pipeline.init()

    capturer.on('frame', async (frameBuffer: Buffer) => {
      try {
        const result = await pipeline.process(frameBuffer)
        emitFrame({
          cameraId,
          frame: result.annotatedFrame.toString('base64'),
          timestamp: Date.now(),
          vehicles: result.vehicles,
          counts: result.counts,
        })
      } catch (err) {
        console.error(`Pipeline error for camera ${cameraId}:`, err)
      }
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
```

Add imports at top of `camera-worker.ts`:
```typescript
import { CameraPipeline } from './ai/pipeline'
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/ai/pipeline.ts backend/src/socket/server.ts backend/src/camera-worker.ts
git commit -m "feat: integrate AI pipeline into camera worker, emit annotated frames"
```

---

## Task 7: Frontend counter display

**Files:**
- Create: `frontend/src/components/CounterDisplay.tsx`
- Modify: `frontend/src/hooks/useCameraFeed.ts`
- Modify: `frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Update useCameraFeed.ts to expose counts**

Replace the hook return:

```typescript
export type VehicleInfo = {
  id: number
  class: string
  speedKmh: number | null
  direction: 'AB' | 'BA' | null
}

export type FrameEvent = {
  cameraId: string
  frame: string
  timestamp: number
  vehicles: VehicleInfo[]
  counts: { AB: number; BA: number; speeders: number }
}

export function useCameraFeed(cameraId: string) {
  const [lastFrame, setLastFrame] = useState<string | null>(null)
  const [counts, setCounts] = useState({ AB: 0, BA: 0, speeders: 0 })
  const [fps, setFps] = useState(0)
  const frameCount = useRef(0)
  const lastFpsTime = useRef(Date.now())

  useEffect(() => {
    socket.emit('subscribe', cameraId)

    const handler = (event: FrameEvent) => {
      if (event.cameraId !== cameraId) return
      setLastFrame(event.frame)
      setCounts(event.counts)

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

  return { lastFrame, counts, fps }
}
```

- [ ] **Step 2: Create frontend/src/components/CounterDisplay.tsx**

```typescript
type Props = {
  counts: { AB: number; BA: number; speeders: number }
  maxSpeedKmh?: number | null
}

export function CounterDisplay({ counts, maxSpeedKmh }: Props) {
  return (
    <div className="flex gap-4 text-sm mt-2">
      <div className="flex-1 bg-gray-800 rounded-lg p-2 text-center">
        <p className="text-gray-400 text-xs">→</p>
        <p className="text-xl font-bold tabular-nums">{counts.AB}</p>
      </div>
      <div className="flex-1 bg-gray-800 rounded-lg p-2 text-center">
        <p className="text-gray-400 text-xs">←</p>
        <p className="text-xl font-bold tabular-nums">{counts.BA}</p>
      </div>
      {maxSpeedKmh && (
        <div className="flex-1 bg-red-950 border border-red-900 rounded-lg p-2 text-center">
          <p className="text-red-400 text-xs">⚡ &gt;{maxSpeedKmh}</p>
          <p className="text-xl font-bold tabular-nums text-red-400">{counts.speeders}</p>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Update Dashboard.tsx camera card to show counters**

In `Dashboard.tsx`, import and add `CounterDisplay` below `LiveFeed`:

```typescript
import { CounterDisplay } from '../components/CounterDisplay'

// In the camera card, add after <LiveFeed>:
// Note: pass a CameraCardProps component that subscribes to the feed for each camera
```

Replace the entire camera card with a self-contained component that has access to the feed:

```typescript
// Add this component above Dashboard:
function CameraCard({ cam }: { cam: Camera }) {
  const { lastFrame, counts, fps } = useCameraFeed(cam.id)
  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="flex justify-between items-start mb-2">
        <div>
          <p className="font-semibold">{cam.name}</p>
          <p className="text-sm text-gray-400">{cam.location}</p>
        </div>
        <span className={`text-xs px-2 py-1 rounded-full ${lastFrame ? 'bg-green-900 text-green-400' : 'bg-yellow-900 text-yellow-400'}`}>
          {lastFrame ? 'Live' : 'Connecting'}
        </span>
      </div>
      <LiveFeed cameraId={cam.id} className="aspect-video" />
      <CounterDisplay counts={counts} maxSpeedKmh={cam.maxSpeedKmh} />
    </div>
  )
}
```

- [ ] **Step 4: Verify in browser**

Start the stack and verify:
- Annotated frames appear with bounding boxes and counting lines
- Counters increment as vehicles cross the lines
- Speeder counter shows (in red) if `maxSpeedKmh` is set on the camera

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CounterDisplay.tsx frontend/src/hooks/useCameraFeed.ts frontend/src/pages/Dashboard.tsx
git commit -m "feat: add vehicle counters and speeder alert to dashboard"
```
