# MJPEG Streamer Pipeline Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five correctness and performance bugs in `MJPEGStreamer` — filler-frame AI analysis, annotation jitter, double JPEG decode, oversized queue, and incomplete dimension check.

**Architecture:** All changes are confined to `backend/src/stream/mjpeg-streamer.ts`. Tasks are ordered so each produces a clean, working, committable intermediate state. Tasks 3 and 4 are a coupled refactor (decode-once + annotation coalescing) and must land together.

**Tech Stack:** Node.js, `@napi-rs/canvas` (`loadImage`, `createCanvas`, `Image`), `onnxruntime-node` (via `Detector`), fluent-ffmpeg, TypeScript strict mode.

---

## Context you must read first

File: `backend/src/stream/mjpeg-streamer.ts`

Key facts:
- `OUTPUT_FPS = 17` — `setInterval` dequeues one frame every ~59 ms.
- `MAX_QUEUE = 500` — capped at ~30 s of frames; too large for a live feed.
- `startDequeue()` (line 118): if `frameQueue` is empty it re-uses `latestRawFrame` as a filler, then calls `onRawFrame(frame)` — which currently runs analysis on the filler too.
- `onRawFrame()` (line 197): fires both `analyse(jpeg)` and `annotate(jpeg)` — each internally calls `loadImage(jpeg)`, decoding the same JPEG twice.
- `analyse()` (line 216): dimension-change check at line 220 only compares `height`; width change is silently ignored.
- `annotate()` (line 275): ends with `canvas.encode('jpeg', 80)` (async, good).

Run after every task:
```bash
cd backend
pnpm tsc --noEmit   # must produce no output
pnpm test           # must stay 33/33 passing
```

---

## Task 1: Fix dimension-change check + tighten queue

**Files:**
- Modify: `backend/src/stream/mjpeg-streamer.ts:18,220`

**What:** Two one-line fixes with no side-effects.
1. `MAX_QUEUE 500 → 51` — at 17 fps this is a 3-second live buffer; enough to absorb a segment burst while keeping latency bounded.
2. The `DirectionCounter` and size fields must rebuild when either `width` or `height` changes, not just height.

- [ ] **Step 1: Change MAX_QUEUE**

In `mjpeg-streamer.ts` replace:
```typescript
const MAX_QUEUE = 500
```
with:
```typescript
const MAX_QUEUE = 51   // ~3 s at OUTPUT_FPS; bounds live latency under burst
```

- [ ] **Step 2: Fix dimension-change guard**

In `analyse()` replace:
```typescript
    if (height !== this.actualHeight) {
      this.counter = new DirectionCounter(height, this.lineA, this.lineB)
      this.actualWidth = width
      this.actualHeight = height
    }
```
with:
```typescript
    if (width !== this.actualWidth || height !== this.actualHeight) {
      this.counter = new DirectionCounter(height, this.lineA, this.lineB)
      this.actualWidth = width
      this.actualHeight = height
    }
```

- [ ] **Step 3: Verify**

```bash
pnpm tsc --noEmit && pnpm test
```
Expected: no output from tsc, 33 tests pass.

- [ ] **Step 4: Commit**

```bash
git add backend/src/stream/mjpeg-streamer.ts
git commit -m "fix: tighten mjpeg queue to 3s live window; check both dims on resize"
```

---

## Task 2: Skip AI analysis on filler/repeat frames

**Files:**
- Modify: `backend/src/stream/mjpeg-streamer.ts:119-133,197-213`

**What:** When `frameQueue` is empty the dequeue loop re-uses `latestRawFrame` to keep video flowing. Running `analyse()` on that repeated frame is wrong — it feeds the same pixel data to the tracker again, inflating missed-frame counters and biasing speed/count state. Fix: track whether the dequeued frame is genuinely new, and only call `analyse()` for new frames.

- [ ] **Step 1: Propagate `isNewFrame` through the dequeue loop**

In `startDequeue()` replace:
```typescript
    this.dequeueTimer = setInterval(() => {
      const frame = this.frameQueue.shift() ?? this.latestRawFrame
      if (!frame) return
      this.latestRawFrame = frame

      this.videoFpsCount++
      const now = Date.now()
      if (now - this.videoFpsLastTime >= 1000) {
        this.videoFps = this.videoFpsCount
        this.videoFpsCount = 0
        this.videoFpsLastTime = now
      }

      this.onRawFrame(frame)
    }, 1000 / OUTPUT_FPS)
```
with:
```typescript
    this.dequeueTimer = setInterval(() => {
      const isNewFrame = this.frameQueue.length > 0
      const frame = this.frameQueue.shift() ?? this.latestRawFrame
      if (!frame) return
      this.latestRawFrame = frame

      this.videoFpsCount++
      const now = Date.now()
      if (now - this.videoFpsLastTime >= 1000) {
        this.videoFps = this.videoFpsCount
        this.videoFpsCount = 0
        this.videoFpsLastTime = now
      }

      this.onRawFrame(frame, isNewFrame)
    }, 1000 / OUTPUT_FPS)
```

- [ ] **Step 2: Update `onRawFrame` signature and guard**

Replace:
```typescript
  private onRawFrame(jpeg: Buffer): void {
    this.frameIdx++

    // Run analysis on every frame the hardware can keep up with
    if (!this.analysisRunning) {
      this.analysisRunning = true
      this.analyse(jpeg).finally(() => { this.analysisRunning = false })
    }

    // Annotate and push — serialised so frames are never emitted out of order
    if (!this.annotationRunning) {
      this.annotationRunning = true
      this.annotate(jpeg)
        .then((annotated) => this.emit('frame', annotated))
        .catch(() => this.emit('frame', jpeg))
        .finally(() => { this.annotationRunning = false })
    }
  }
```
with:
```typescript
  private onRawFrame(jpeg: Buffer, isNewFrame: boolean): void {
    this.frameIdx++

    // Only run AI on genuinely new frames — filler repeats must not re-feed
    // the tracker (inflates missed-frame counts and biases speed/count state)
    if (isNewFrame && !this.analysisRunning) {
      this.analysisRunning = true
      this.analyse(jpeg).finally(() => { this.analysisRunning = false })
    }

    if (!this.annotationRunning) {
      this.annotationRunning = true
      this.annotate(jpeg)
        .then((annotated) => this.emit('frame', annotated))
        .catch(() => this.emit('frame', jpeg))
        .finally(() => { this.annotationRunning = false })
    }
  }
```

- [ ] **Step 3: Verify**

```bash
pnpm tsc --noEmit && pnpm test
```
Expected: no output from tsc, 33 tests pass.

- [ ] **Step 4: Commit**

```bash
git add backend/src/stream/mjpeg-streamer.ts
git commit -m "fix: skip AI analysis on filler repeat frames between HLS segments"
```

---

## Task 3: Decode JPEG once + single-flight annotation with coalescing

**Files:**
- Modify: `backend/src/stream/mjpeg-streamer.ts` (class fields, `onRawFrame`, `analyse`, `annotate`)

**What:** Two tightly coupled improvements that must land in one commit:

**Decode-once:** Both `analyse()` and `annotate()` currently call `loadImage(jpeg)` independently. For each output frame that also triggers analysis, the same JPEG is decoded twice (~10–15 ms each). Decode once in `onRawFrame`, pass the `Image` object to both.

**Single-flight annotation with coalescing:** The current `annotationRunning` guard drops frames silently. Replace with a coalescing pattern: when annotation is busy, save the latest incoming frame as `pendingAnnotation` (discarding any earlier pending). When annotation finishes, immediately start on the pending frame if one exists. Between annotation cycles, emit the last known annotated JPEG so the MJPEG stream keeps flowing at the full output rate.

- [ ] **Step 1: Add the `Image` type import and new fields**

Change the import line from:
```typescript
import { createCanvas, loadImage } from '@napi-rs/canvas'
```
to:
```typescript
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'
```

Add two new private fields immediately after `private annotationRunning = false`:
```typescript
  private lastAnnotatedJpeg: Buffer | null = null
  private pendingAnnotation: { img: Image; width: number; height: number; fallback: Buffer } | null = null
```

- [ ] **Step 2: Rewrite `onRawFrame` to decode once and use coalescing**

Replace the entire `onRawFrame` method:
```typescript
  private onRawFrame(jpeg: Buffer, isNewFrame: boolean): void {
    this.frameIdx++

    // Only run AI on genuinely new frames — filler repeats must not re-feed
    // the tracker (inflates missed-frame counts and biases speed/count state)
    if (isNewFrame && !this.analysisRunning) {
      this.analysisRunning = true
      this.analyse(jpeg).finally(() => { this.analysisRunning = false })
    }

    if (!this.annotationRunning) {
      this.annotationRunning = true
      this.annotate(jpeg)
        .then((annotated) => this.emit('frame', annotated))
        .catch(() => this.emit('frame', jpeg))
        .finally(() => { this.annotationRunning = false })
    }
  }
```
with:
```typescript
  private onRawFrame(jpeg: Buffer, isNewFrame: boolean): void {
    this.frameIdx++

    loadImage(jpeg).then((img) => {
      const { width, height } = img

      if (isNewFrame && !this.analysisRunning) {
        this.analysisRunning = true
        this.analyse(img, width, height).finally(() => { this.analysisRunning = false })
      }

      if (!this.annotationRunning) {
        this.annotateAndEmit(img, width, height, jpeg)
      } else {
        // Coalesce: latest frame wins, earlier pending is discarded
        this.pendingAnnotation = { img, width, height, fallback: jpeg }
        // Keep MJPEG stream flowing at output fps with the last good frame
        if (this.lastAnnotatedJpeg) this.emit('frame', this.lastAnnotatedJpeg)
      }
    }).catch(() => {
      // If decode fails, emit raw jpeg as fallback and keep going
      if (this.lastAnnotatedJpeg) this.emit('frame', this.lastAnnotatedJpeg)
    })
  }
```

- [ ] **Step 3: Add the `annotateAndEmit` helper**

Add this new private method directly after `onRawFrame`:
```typescript
  private annotateAndEmit(img: Image, width: number, height: number, fallback: Buffer): void {
    this.annotationRunning = true
    this.annotate(img, width, height)
      .then((annotated) => {
        this.lastAnnotatedJpeg = annotated
        this.emit('frame', annotated)
      })
      .catch(() => {
        this.emit('frame', this.lastAnnotatedJpeg ?? fallback)
      })
      .finally(() => {
        const pending = this.pendingAnnotation
        this.pendingAnnotation = null
        if (pending && this.running) {
          this.annotateAndEmit(pending.img, pending.width, pending.height, pending.fallback)
        } else {
          this.annotationRunning = false
        }
      })
  }
```

- [ ] **Step 4: Rewrite `analyse` to accept a decoded `Image`**

Replace the `analyse` method signature and remove its `loadImage` call:
```typescript
  private async analyse(img: Image, width: number, height: number): Promise<void> {
    if (width !== this.actualWidth || height !== this.actualHeight) {
      this.counter = new DirectionCounter(height, this.lineA, this.lineB)
      this.actualWidth = width
      this.actualHeight = height
    }

    const scale = Math.min(640 / width, 640 / height)
    const scaledW = Math.round(width * scale)
    const scaledH = Math.round(height * scale)
    const padX = Math.round((640 - scaledW) / 2)
    const padY = Math.round((640 - scaledH) / 2)
    const canvas640 = createCanvas(640, 640)
    const ctx640 = canvas640.getContext('2d')
    ctx640.fillStyle = '#808080'
    ctx640.fillRect(0, 0, 640, 640)
    ctx640.drawImage(img, padX, padY, scaledW, scaledH)
    const rgba640 = ctx640.getImageData(0, 0, 640, 640).data

    const detections = await this.detector.detect(rgba640, padX, padY, scale, width, height)
    const tracked = this.tracker.update(detections)

    const lost = new Set(this.boxes.map((b) => b.id))
    for (const v of tracked) lost.delete(v.id)
    for (const id of lost) { this.speedCalc?.removeVehicle(id); this.countedSpeeders.delete(id) }

    for (const v of tracked) this.counter.updateVehicle(v.id, v.bcy)
    const counts = this.counter.getCounts()

    const boxes: Box[] = []
    for (const v of tracked) {
      let speedKmh: number | null = null
      if (this.speedCalc) {
        this.speedCalc.addPosition(v.id, v.bcx, v.bcy, Date.now())
        speedKmh = this.speedCalc.getSpeed(v.id)
        if (this.speedCalc.isSpeeder(v.id) && !this.countedSpeeders.has(v.id)) {
          this.countedSpeeders.add(v.id); this.speeders++
        }
      }
      boxes.push({ id: v.id, class: v.class, speedKmh, x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2 })
    }

    this.boxes = boxes
    this.counts = { ...counts, speeders: this.speeders }

    emitFrame({
      cameraId: this.cameraId,
      timestamp: Date.now(),
      vehicles: boxes.map((b) => ({ ...b, direction: null })),
      counts: this.counts,
      frameWidth: width,
      frameHeight: height,
      videoFps: this.videoFps,
    })
  }
```

- [ ] **Step 5: Rewrite `annotate` to accept a decoded `Image`**

Replace the `annotate` method signature and remove its `loadImage` call:
```typescript
  private async annotate(img: Image, width: number, height: number): Promise<Buffer> {
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)

    const aY = this.lineA * height
    const bY = this.lineB * height
    ctx.strokeStyle = 'rgba(255,220,0,0.85)'
    ctx.lineWidth = 2
    ctx.setLineDash([10, 5])
    ctx.beginPath(); ctx.moveTo(0, aY); ctx.lineTo(width, aY); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, bY); ctx.lineTo(width, bY); ctx.stroke()
    ctx.setLineDash([])
    ctx.font = 'bold 11px monospace'
    ctx.fillStyle = 'rgba(255,220,0,0.9)'
    ctx.fillText('A', 4, aY - 3)
    ctx.fillText('B', 4, bY - 3)

    for (const v of this.boxes) {
      const color = CLASS_COLORS[v.class] ?? '#fff'
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.strokeRect(v.x1, v.y1, v.x2 - v.x1, v.y2 - v.y1)
      const label = v.speedKmh !== null ? `${v.class} ${Math.round(v.speedKmh)}km/h` : v.class
      ctx.font = '11px monospace'
      const tw = ctx.measureText(label).width + 6
      const ly = Math.max(14, v.y1)
      ctx.fillStyle = color
      ctx.fillRect(v.x1, ly - 14, tw, 14)
      ctx.fillStyle = '#000'
      ctx.fillText(label, v.x1 + 3, ly - 3)
    }

    return canvas.encode('jpeg', 80)
  }
```

- [ ] **Step 6: Clear `lastAnnotatedJpeg` and `pendingAnnotation` on stop**

In `stop()`, add two clears after `this.frameQueue = []`:
```typescript
    this.lastAnnotatedJpeg = null
    this.pendingAnnotation = null
```

Full updated `stop()`:
```typescript
  stop(): void {
    this.running = false
    if (this.dequeueTimer) { clearInterval(this.dequeueTimer); this.dequeueTimer = null }
    this.frameQueue = []
    this.lastAnnotatedJpeg = null
    this.pendingAnnotation = null
    this.ffmpegProc?.kill('SIGTERM')
    this.ffmpegProc = null
  }
```

- [ ] **Step 7: Verify**

```bash
pnpm tsc --noEmit && pnpm test
```
Expected: no output from tsc, 33 tests pass.

- [ ] **Step 8: Commit**

```bash
git add backend/src/stream/mjpeg-streamer.ts
git commit -m "perf: decode jpeg once per frame; single-flight annotation with coalescing"
```

---

## Self-Review

**Spec coverage:**
1. ✅ Skip AI on filler frames — Task 2 (`isNewFrame` guard on `analyse`)
2. ✅ Single-flight annotation + coalescing — Task 3 (`annotateAndEmit` + `pendingAnnotation`)
3. ✅ Decode once — Task 3 (`loadImage` moved to `onRawFrame`, passed as `Image` to both)
4. ✅ Tighten queue — Task 1 (`MAX_QUEUE = 51`)
5. ✅ Fix dimension check — Task 1 (`width !== this.actualWidth || height !== this.actualHeight`)

**Placeholder scan:** None found.

**Type consistency:**
- `Image` imported from `@napi-rs/canvas` and used consistently in `onRawFrame`, `annotateAndEmit`, `analyse`, `annotate`.
- `pendingAnnotation` field type matches the argument shape used in `annotateAndEmit`.
- `lastAnnotatedJpeg: Buffer | null` — used correctly in `.catch()` fallback and filler emit.
