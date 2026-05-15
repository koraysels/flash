# Frame Time and Tracker Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate speed-calculation drift caused by wall-clock timestamps being captured inside async analysis callbacks, and widen the tracker's eviction window to survive multi-lane occlusions.

**Architecture:** Two independent fixes. Task 1 threads a `frameTime` (captured at dequeue) through `onRawFrame → analyse → speedCalc.addPosition`, replacing the `Date.now()` call that sits inside a Promise chain 30–80 ms after the frame was actually produced. Task 2 raises `maxMissedFrames` from 8 to 12 in `Tracker`, which at 17 fps gives a vehicle ~700 ms to reappear after passing behind another object before its ID is recycled.

**Tech Stack:** TypeScript strict mode, `@napi-rs/canvas` Image, vitest.

---

## Context you must read first

**`backend/src/stream/mjpeg-streamer.ts`** — `startDequeue()` fires a `setInterval` at 17 fps; it calls `onRawFrame(frame, isNewFrame)`. Inside `onRawFrame`, `loadImage(jpeg)` is awaited, then `analyse(img, width, height)` is called. Inside `analyse`, `this.speedCalc.addPosition(v.id, v.bcx, v.bcy, Date.now())` uses wall-clock time at the moment the async chain resolves — typically 30–80 ms later than the frame was dequeued. This drift accumulates across frames and inflates computed speeds.

**`backend/src/ai/tracker.ts`** — `maxMissedFrames = 8` (line 22). A track is evicted if it misses 8 consecutive `update()` calls. At 17 fps (AI analysis rate with `isNewFrame` guard), 8 frames = ~470 ms. For multi-lane roads where a vehicle can be fully occluded for 500–900 ms, this causes ID switches and double-counting.

Run after every task:
```bash
cd /Users/koraysels/work/flash/backend
pnpm tsc --noEmit   # must produce no output
pnpm test           # must stay 33/33 passing
```

---

## File structure

- Modify: `backend/src/stream/mjpeg-streamer.ts` — thread dequeue timestamp through to `analyse`
- Modify: `backend/src/ai/tracker.ts` — raise `maxMissedFrames`
- Modify: `backend/tests/ai/tracker.test.ts` — update eviction test to match new threshold

---

## Task 1: Thread dequeue timestamp into speed calculations

**Files:**
- Modify: `backend/src/stream/mjpeg-streamer.ts`

**What:** Capture `Date.now()` at the top of the `setInterval` callback — before any async work — and thread it as `frameTime` through `onRawFrame` → `analyse` → `speedCalc.addPosition`. This replaces the current `Date.now()` call deep inside the resolved Promise, eliminating async-pipeline drift.

- [ ] **Step 1: Update `startDequeue` to capture and forward `frameTime`**

In `startDequeue()`, replace:
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
with:
```typescript
    this.dequeueTimer = setInterval(() => {
      const frameTime = Date.now()
      const isNewFrame = this.frameQueue.length > 0
      const frame = this.frameQueue.shift() ?? this.latestRawFrame
      if (!frame) return
      this.latestRawFrame = frame

      this.videoFpsCount++
      if (frameTime - this.videoFpsLastTime >= 1000) {
        this.videoFps = this.videoFpsCount
        this.videoFpsCount = 0
        this.videoFpsLastTime = frameTime
      }

      this.onRawFrame(frame, isNewFrame, frameTime)
    }, 1000 / OUTPUT_FPS)
```

- [ ] **Step 2: Update `onRawFrame` to accept and forward `frameTime`**

Replace:
```typescript
  private onRawFrame(jpeg: Buffer, isNewFrame: boolean): void {
    this.frameIdx++

    loadImage(jpeg).then((img) => {
      const { width, height } = img

      if (isNewFrame && !this.analysisRunning) {
        this.analysisRunning = true
        this.analyse(img, width, height).finally(() => { this.analysisRunning = false })
      }
```
with:
```typescript
  private onRawFrame(jpeg: Buffer, isNewFrame: boolean, frameTime: number): void {
    this.frameIdx++

    loadImage(jpeg).then((img) => {
      const { width, height } = img

      if (isNewFrame && !this.analysisRunning) {
        this.analysisRunning = true
        this.analyse(img, width, height, frameTime).finally(() => { this.analysisRunning = false })
      }
```

- [ ] **Step 3: Update `analyse` to accept and use `frameTime`**

Change the `analyse` signature and replace the single `Date.now()` call inside it.

Replace the signature line:
```typescript
  private async analyse(img: Image, width: number, height: number): Promise<void> {
```
with:
```typescript
  private async analyse(img: Image, width: number, height: number, frameTime: number): Promise<void> {
```

Then inside `analyse`, replace:
```typescript
        this.speedCalc.addPosition(v.id, v.bcx, v.bcy, Date.now())
```
with:
```typescript
        this.speedCalc.addPosition(v.id, v.bcx, v.bcy, frameTime)
```

The `emitFrame({ timestamp: Date.now(), ... })` call lower in the method stays as `Date.now()` — that field is the socket emission time, not the frame timestamp.

- [ ] **Step 4: Verify**

```bash
pnpm tsc --noEmit && pnpm test
```
Expected: no output from tsc, 33 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/stream/mjpeg-streamer.ts
git commit -m "fix: use dequeue timestamp for speed calculations, not async-resolved wall clock"
```

---

## Task 2: Raise maxMissedFrames from 8 to 12

**Files:**
- Modify: `backend/src/ai/tracker.ts`
- Modify: `backend/tests/ai/tracker.test.ts`

**What:** At 17 fps with the `isNewFrame` guard, 8 missed frames = ~470 ms. Vehicles crossing multi-lane roads can be occluded for 500–900 ms. Raising to 12 gives ~700 ms — enough to bridge a typical occlusion without evicting and recycling the ID. The existing eviction test loops 9 times; it must loop 13 times to exceed the new threshold.

- [ ] **Step 1: Update `maxMissedFrames` in `tracker.ts`**

In `backend/src/ai/tracker.ts` replace:
```typescript
  private readonly maxMissedFrames = 8
```
with:
```typescript
  private readonly maxMissedFrames = 12
```

- [ ] **Step 2: Update the eviction test in `tracker.test.ts`**

In `backend/tests/ai/tracker.test.ts` replace:
```typescript
  it('removes track after maxMissedFrames consecutive misses', () => {
    // Confirm the track first
    tracker.update([car(100, 100)])
    tracker.update([car(100, 100)])

    // Miss enough frames to expire the track
    for (let i = 0; i < 9; i++) tracker.update([])

    expect(tracker.update([])).toHaveLength(0)
  })
```
with:
```typescript
  it('removes track after maxMissedFrames consecutive misses', () => {
    // Confirm the track first
    tracker.update([car(100, 100)])
    tracker.update([car(100, 100)])

    // Miss enough frames to expire the track (maxMissedFrames = 12, so 13 misses evict)
    for (let i = 0; i < 13; i++) tracker.update([])

    expect(tracker.update([])).toHaveLength(0)
  })
```

- [ ] **Step 3: Verify**

```bash
pnpm tsc --noEmit && pnpm test
```
Expected: no output from tsc, 33 tests pass.

- [ ] **Step 4: Commit**

```bash
git add backend/src/ai/tracker.ts backend/tests/ai/tracker.test.ts
git commit -m "fix: raise maxMissedFrames to 12 to bridge multi-lane occlusions (~700ms at 17fps)"
```

---

## Self-Review

**Spec coverage:**
1. ✅ Frame time drift — Task 1 captures `Date.now()` at dequeue, threads as `frameTime` to `addPosition`
2. ✅ Wall-clock `Date.now()` inside async chain — replaced in `analyse` only; `emitFrame` timestamp intentionally kept as emission time
3. ✅ `maxMissedFrames` raised — Task 2, 8→12
4. ✅ Test updated — eviction loop raised from 9 to 13

**Placeholder scan:** None found.

**Type consistency:**
- `frameTime: number` parameter added consistently: `startDequeue` → `onRawFrame` → `analyse`
- `SpeedCalculator.addPosition(id, px, py, timestamp: number)` — fourth arg type is `number`, matches `frameTime`
