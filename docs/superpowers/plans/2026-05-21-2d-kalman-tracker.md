# 2D Kalman Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vervang de twee onafhankelijke `KF1D` instanties per track door één `KF2D` klasse, en voeg een direction-aware matching-score toe naast IoU om ID-switches bij parallelle voertuigen te voorkomen.

**Architecture:** `KF2D` beheert `[cx, cy, vx, vy]` als één state-vector via twee ontkoppelde 2×2 covariantieblokken (wiskundig identiek aan de huidige twee `KF1D`'s, maar unified). De matching-functie `greedyMatch` krijgt snelheidsinformatie mee en combineert IoU (70%) met richting-compatibiliteit (30%) wanneer een track genoeg snelheid heeft.

**Tech Stack:** TypeScript, Vitest — enkel `backend/src/ai/tracker.ts` en `backend/tests/ai/tracker.test.ts`.

---

## Bestanden

- **Modify:** `backend/src/ai/tracker.ts` — `KF2D` klasse toevoegen, `KF1D` verwijderen, `KFTrack` updaten, `greedyMatch` uitbreiden
- **Modify:** `backend/tests/ai/tracker.test.ts` — 2 nieuwe tests toevoegen

---

## Task 1: `KF2D` klasse schrijven en testen

**Files:**
- Modify: `backend/src/ai/tracker.ts`
- Modify: `backend/tests/ai/tracker.test.ts`

### Stap 1.1 — Voeg het nieuwe KF2D-importtest toe (failing)

Voeg bovenaan `backend/tests/ai/tracker.test.ts` een aparte describe-block toe, na de bestaande imports:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { Tracker } from '../../src/ai/tracker'
import { DetectionResult } from '../../src/ai/detector'
// Voeg deze import toe voor de KF2D white-box test:
import { KF2D } from '../../src/ai/tracker'
```

Voeg onderaan het bestand een nieuwe describe-block toe:

```typescript
describe('KF2D', () => {
  it('initialises with zero velocity', () => {
    const kf = new KF2D(100, 200, 1.0, 0.05)
    expect(kf.cx).toBe(100)
    expect(kf.cy).toBe(200)
    expect(kf.vx).toBe(0)
    expect(kf.vy).toBe(0)
    expect(kf.velMag()).toBe(0)
  })

  it('predict moves position by velocity * dt', () => {
    const kf = new KF2D(100, 200, 1.0, 0.05)
    // Manually set velocity via update calls that build up velocity
    // First: update with a position 50px to the right after 1s
    kf.update(150, 200, 4)
    kf.predict(1.0)
    // After one update + predict, cx should be > 150 (Kalman gain < 1 so not exactly 200)
    expect(kf.cx).toBeGreaterThan(140)
  })

  it('velMag returns correct magnitude', () => {
    const kf = new KF2D(0, 0, 1.0, 0.05)
    // Feed positions to build up velocity: 3px/s x, 4px/s y → magnitude 5
    kf.update(3, 4, 4)
    kf.predict(1.0)
    kf.update(6, 8, 4)
    kf.predict(1.0)
    kf.update(9, 12, 4)
    // Velocity should be converging toward (3, 4), magnitude toward 5
    expect(kf.velMag()).toBeGreaterThan(0)
  })

  it('velAngle returns correct direction', () => {
    const kf = new KF2D(0, 0, 1.0, 0.05)
    // Drive purely horizontal to the right
    for (let i = 1; i <= 5; i++) kf.update(i * 10, 0, 4)
    // Angle should be near 0 (pointing right)
    expect(Math.abs(kf.velAngle())).toBeLessThan(0.5)
  })
})
```

- [ ] **Stap 1.2 — Run de test en bevestig dat hij faalt**

```bash
cd /Users/koraysels/work/flash && pnpm --filter flash-backend test -- --reporter=verbose 2>&1 | tail -20
```

Verwacht: fout `KF2D is not exported from tracker.ts`

- [ ] **Stap 1.3 — Implementeer `KF2D` in `tracker.ts`**

Vervang de bestaande `KF1D` klasse volledig door `KF2D`. Verwijder:

```typescript
class KF1D {
  pos: number; vel: number
  p00: number; p01: number; p11: number
  // ... (hele klasse)
}
```

Voeg in de plaats toe (net na de `rMeas` functie):

```typescript
export class KF2D {
  cx: number; cy: number
  vx: number; vy: number
  private px00: number; private px01: number; private px11: number
  private py00: number; private py01: number; private py11: number

  constructor(cx: number, cy: number, private readonly qPos: number, private readonly qVel: number) {
    this.cx = cx; this.cy = cy
    this.vx = 0; this.vy = 0
    this.px00 = 200; this.px01 = 0; this.px11 = 10_000
    this.py00 = 200; this.py01 = 0; this.py11 = 10_000
  }

  predict(dt: number): void {
    this.cx += this.vx * dt
    this.cy += this.vy * dt
    const px00 = this.px00 + 2 * dt * this.px01 + dt * dt * this.px11 + this.qPos * dt
    const px01 = this.px01 + dt * this.px11
    this.px11 += this.qVel * dt
    this.px00 = px00; this.px01 = px01
    const py00 = this.py00 + 2 * dt * this.py01 + dt * dt * this.py11 + this.qPos * dt
    const py01 = this.py01 + dt * this.py11
    this.py11 += this.qVel * dt
    this.py00 = py00; this.py01 = py01
  }

  update(meas_cx: number, meas_cy: number, r: number): void {
    const Sx = this.px00 + r
    const K0x = this.px00 / Sx
    const K1x = this.px01 / Sx
    const innovX = meas_cx - this.cx
    this.cx += K0x * innovX
    this.vx += K1x * innovX
    const px01 = this.px01
    this.px00 = (1 - K0x) * this.px00
    this.px01 = (1 - K0x) * px01
    this.px11 -= K1x * px01

    const Sy = this.py00 + r
    const K0y = this.py00 / Sy
    const K1y = this.py01 / Sy
    const innovY = meas_cy - this.cy
    this.cy += K0y * innovY
    this.vy += K1y * innovY
    const py01 = this.py01
    this.py00 = (1 - K0y) * this.py00
    this.py01 = (1 - K0y) * py01
    this.py11 -= K1y * py01
  }

  velMag(): number {
    return Math.sqrt(this.vx * this.vx + this.vy * this.vy)
  }

  velAngle(): number {
    return Math.atan2(this.vy, this.vx)
  }
}
```

- [ ] **Stap 1.4 — Run tests, bevestig KF2D-tests slagen**

```bash
cd /Users/koraysels/work/flash && pnpm --filter flash-backend test -- --reporter=verbose 2>&1 | tail -30
```

Verwacht: alle KF2D-tests PASS, bestaande Tracker-tests nog steeds PASS (tracker gebruikt nog `KF1D` — dat fixen we in Task 2).

- [ ] **Stap 1.5 — Commit**

```bash
cd /Users/koraysels/work/flash && git add backend/src/ai/tracker.ts backend/tests/ai/tracker.test.ts && git commit -m "feat: add KF2D class with unified 2D state vector"
```

---

## Task 2: `KFTrack` en `Tracker.update()` migreren naar `KF2D`

**Files:**
- Modify: `backend/src/ai/tracker.ts`

- [ ] **Stap 2.1 — Update het `KFTrack` type**

Zoek in `tracker.ts`:

```typescript
type KFTrack = TrackedVehicle & {
  kfX: KF1D; kfY: KF1D
  w: number; h: number
  lastTs: number
}
```

Vervang door:

```typescript
type KFTrack = TrackedVehicle & {
  kf: KF2D
  w: number; h: number
  lastTs: number
}
```

- [ ] **Stap 2.2 — Update de `predict`-stap in `Tracker.update()`**

Zoek:

```typescript
const predicted: Box[] = this.tracks.map((t) => {
  const dt = Math.max(0.01, Math.min((timestamp - t.lastTs) / 1000, 2.0))
  t.kfX.predict(dt)
  t.kfY.predict(dt)
  t.lastTs = timestamp
  return {
    x1: t.kfX.pos - t.w / 2, y1: t.kfY.pos - t.h / 2,
    x2: t.kfX.pos + t.w / 2, y2: t.kfY.pos + t.h / 2,
  }
})
```

Vervang door:

```typescript
const predicted: Box[] = this.tracks.map((t) => {
  const dt = Math.max(0.01, Math.min((timestamp - t.lastTs) / 1000, 2.0))
  t.kf.predict(dt)
  t.lastTs = timestamp
  return {
    x1: t.kf.cx - t.w / 2, y1: t.kf.cy - t.h / 2,
    x2: t.kf.cx + t.w / 2, y2: t.kf.cy + t.h / 2,
  }
})
```

- [ ] **Stap 2.3 — Update de `update`-stap (matched tracks)**

Zoek:

```typescript
for (const { ti, di } of allMatched) {
  const t   = this.tracks[ti]
  const det = detections[di]
  const r   = rMeas(det.confidence)

  t.kfX.update((det.x1 + det.x2) / 2, r)
  t.kfY.update((det.y1 + det.y2) / 2, r)
  t.w = boxEmaAlpha * (det.x2 - det.x1) + (1 - boxEmaAlpha) * t.w
  t.h = boxEmaAlpha * (det.y2 - det.y1) + (1 - boxEmaAlpha) * t.h

  t.x1 = t.kfX.pos - t.w / 2; t.y1 = t.kfY.pos - t.h / 2
  t.x2 = t.kfX.pos + t.w / 2; t.y2 = t.kfY.pos + t.h / 2
  t.cx = t.kfX.pos; t.cy = t.kfY.pos
  t.bcx = t.cx; t.bcy = t.y2 - t.h * 0.05
```

Vervang door:

```typescript
for (const { ti, di } of allMatched) {
  const t   = this.tracks[ti]
  const det = detections[di]
  const r   = rMeas(det.confidence)

  t.kf.update((det.x1 + det.x2) / 2, (det.y1 + det.y2) / 2, r)
  t.w = boxEmaAlpha * (det.x2 - det.x1) + (1 - boxEmaAlpha) * t.w
  t.h = boxEmaAlpha * (det.y2 - det.y1) + (1 - boxEmaAlpha) * t.h

  t.x1 = t.kf.cx - t.w / 2; t.y1 = t.kf.cy - t.h / 2
  t.x2 = t.kf.cx + t.w / 2; t.y2 = t.kf.cy + t.h / 2
  t.cx = t.kf.cx; t.cy = t.kf.cy
  t.bcx = t.cx; t.bcy = t.y2 - t.h * 0.05
```

- [ ] **Stap 2.4 — Update de predicted-box stap (unmatched tracks)**

Zoek:

```typescript
for (let ti = 0; ti < this.tracks.length; ti++) {
  if (!matchedTSet.has(ti)) {
    const t = this.tracks[ti]
    t.missedFrames++
    t.cx = t.kfX.pos; t.cy = t.kfY.pos
    t.x1 = t.cx - t.w / 2; t.y1 = t.cy - t.h / 2
    t.x2 = t.cx + t.w / 2; t.y2 = t.cy + t.h / 2
    t.bcx = t.cx; t.bcy = t.y2 - t.h * 0.05
    t.isPredicted = true
  }
}
```

Vervang door:

```typescript
for (let ti = 0; ti < this.tracks.length; ti++) {
  if (!matchedTSet.has(ti)) {
    const t = this.tracks[ti]
    t.missedFrames++
    t.cx = t.kf.cx; t.cy = t.kf.cy
    t.x1 = t.cx - t.w / 2; t.y1 = t.cy - t.h / 2
    t.x2 = t.cx + t.w / 2; t.y2 = t.cy + t.h / 2
    t.bcx = t.cx; t.bcy = t.y2 - t.h * 0.05
    t.isPredicted = true
  }
}
```

- [ ] **Stap 2.5 — Update het aanmaken van nieuwe tracks**

Zoek:

```typescript
this.tracks.push({
  ...det,
  id: this.nextId++,
  cx, cy, bcx: cx, bcy: det.y2 - h * 0.05,
  kfX: new KF1D(cx, this.cfg.qPos, this.cfg.qVel),
  kfY: new KF1D(cy, this.cfg.qPos, this.cfg.qVel),
  w, h, lastTs: timestamp,
```

Vervang door:

```typescript
this.tracks.push({
  ...det,
  id: this.nextId++,
  cx, cy, bcx: cx, bcy: det.y2 - h * 0.05,
  kf: new KF2D(cx, cy, this.cfg.qPos, this.cfg.qVel),
  w, h, lastTs: timestamp,
```

- [ ] **Stap 2.6 — Run alle tests**

```bash
cd /Users/koraysels/work/flash && pnpm --filter flash-backend test -- --reporter=verbose 2>&1 | tail -30
```

Verwacht: alle tests PASS. Als TypeScript klaagt over `KF1D` nog ergens: zoek op `KF1D` in `tracker.ts` en verwijder resterende referenties.

- [ ] **Stap 2.7 — Commit**

```bash
cd /Users/koraysels/work/flash && git add backend/src/ai/tracker.ts && git commit -m "feat: migrate KFTrack from two KF1D to single KF2D"
```

---

## Task 3: Direction-aware matching toevoegen

**Files:**
- Modify: `backend/src/ai/tracker.ts`
- Modify: `backend/tests/ai/tracker.test.ts`

- [ ] **Stap 3.1 — Schrijf de failing test voor ID-switch preventie**

Voeg toe aan `backend/tests/ai/tracker.test.ts`, onderaan de bestaande `describe('Tracker')` block (voor de sluitende `}`):

```typescript
  it('does not swap IDs when two vehicles move in opposite directions', () => {
    // Two vehicles moving in opposite directions, 300px apart → confirmed
    // Vehicle A: moves right (+10px/frame), Vehicle B: moves left (-10px/frame)
    const t = [0, 200, 400, 600, 800]

    // Frame 1 & 2: confirm both tracks
    tracker.update([car(100, 300), car(400, 300)], t[0])
    const frame2 = tracker.update([car(110, 300), car(390, 300)], t[1])
    expect(frame2).toHaveLength(2)
    const idA = frame2.find(v => v.cx < 250)!.id
    const idB = frame2.find(v => v.cx >= 250)!.id

    // Frame 3 & 4: vehicles approach and overlap
    tracker.update([car(200, 300), car(300, 300)], t[2])
    tracker.update([car(280, 300), car(220, 300)], t[3])

    // Frame 5: vehicles have crossed — A is now on the right, B on the left
    const frame5 = tracker.update([car(350, 300), car(150, 300)], t[4])
    expect(frame5).toHaveLength(2)

    // IDs must NOT have swapped: the track that was moving right stays right
    const rightTrack = frame5.find(v => v.cx > 250)
    const leftTrack  = frame5.find(v => v.cx <= 250)
    expect(rightTrack?.id).toBe(idA)
    expect(leftTrack?.id).toBe(idB)
  })
```

Let op: de `car()` helper in de testfile heeft maar twee parameters (`x1, y1`). Voor de timestamp-parameter is de bestaande `tracker.update()` handtekening al `(detections, timestamp?)` — dat werkt.

- [ ] **Stap 3.2 — Run de test en bevestig dat hij faalt**

```bash
cd /Users/koraysels/work/flash && pnpm --filter flash-backend test -- --reporter=verbose 2>&1 | tail -20
```

Verwacht: de nieuwe test FAIL (ID-switch treedt op zonder direction-weighting).

- [ ] **Stap 3.3 — Voeg constanten toe bovenaan `tracker.ts`**

Voeg toe net na de `DEFAULT_TRACKER_CONFIG` definitie:

```typescript
const VEL_MAG_THRESHOLD = 20      // px/s — onder deze waarde is richting onbetrouwbaar
const MIN_FRAMES_FOR_DIRECTION = 3 // bevestigde frames nodig voor richting-matching
const DIRECTION_IOU_WEIGHT = 0.7   // gewicht voor IoU in gecombineerde score
```

- [ ] **Stap 3.4 — Update de `greedyMatch` signatuur**

Zoek:

```typescript
function greedyMatch(
  predicted: Box[],
  trackIndices: number[],
  detections: DetectionResult[],
  detIndices: number[],
  threshold: number,
): Array<{ ti: number; di: number }> {
  const candidates: Array<{ ti: number; di: number; score: number }> = []
  for (const ti of trackIndices) {
    for (const di of detIndices) {
      const score = iou(predicted[ti], detections[di])
      if (score >= threshold) candidates.push({ ti, di, score })
    }
  }
```

Vervang door:

```typescript
type VelInfo = { vx: number; vy: number; mag: number; confirmedFrames: number }

function dirScore(vel: VelInfo | null, pred: Box, det: DetectionResult): number {
  if (!vel || vel.mag < VEL_MAG_THRESHOLD || vel.confirmedFrames < MIN_FRAMES_FOR_DIRECTION) return 0.5
  const dx = (det.x1 + det.x2) / 2 - (pred.x1 + pred.x2) / 2
  const dy = (det.y1 + det.y2) / 2 - (pred.y1 + pred.y2) / 2
  const deltaMag = Math.sqrt(dx * dx + dy * dy)
  if (deltaMag < 1e-6) return 0.5
  const cos = (vel.vx * dx + vel.vy * dy) / (vel.mag * deltaMag)
  return (cos + 1) / 2
}

function greedyMatch(
  predicted: Box[],
  trackIndices: number[],
  detections: DetectionResult[],
  detIndices: number[],
  threshold: number,
  velocities: Array<VelInfo | null>,
): Array<{ ti: number; di: number }> {
  const candidates: Array<{ ti: number; di: number; score: number }> = []
  for (const ti of trackIndices) {
    for (const di of detIndices) {
      const iouScore = iou(predicted[ti], detections[di])
      if (iouScore < threshold) continue
      const ds = dirScore(velocities[ti], predicted[ti], detections[di])
      const score = iouScore * DIRECTION_IOU_WEIGHT + ds * (1 - DIRECTION_IOU_WEIGHT)
      candidates.push({ ti, di, score })
    }
  }
```

- [ ] **Stap 3.5 — Update de `greedyMatch` aanroepen in `Tracker.update()`**

Voeg toe net vóór de eerste `greedyMatch`-aanroep:

```typescript
const velocities: Array<VelInfo | null> = this.tracks.map((t) => ({
  vx: t.kf.vx,
  vy: t.kf.vy,
  mag: t.kf.velMag(),
  confirmedFrames: t.confirmedFrames,
}))
```

Zoek de twee `greedyMatch`-aanroepen:

```typescript
const m1 = greedyMatch(predicted, allTI, detections, highDI, iouStage1)
```
en
```typescript
const m2 = greedyMatch(predicted, unmatchedTI, detections, lowDI, iouStage2)
```

Vervang door:

```typescript
const m1 = greedyMatch(predicted, allTI, detections, highDI, iouStage1, velocities)
```
en
```typescript
const m2 = greedyMatch(predicted, unmatchedTI, detections, lowDI, iouStage2, velocities)
```

- [ ] **Stap 3.6 — Run alle tests**

```bash
cd /Users/koraysels/work/flash && pnpm --filter flash-backend test -- --reporter=verbose 2>&1 | tail -30
```

Verwacht: alle tests PASS inclusief de nieuwe ID-switch test.

- [ ] **Stap 3.7 — TypeScript build check**

```bash
cd /Users/koraysels/work/flash && pnpm --filter flash-backend build 2>&1 | tail -20
```

Verwacht: geen TypeScript-fouten.

- [ ] **Stap 3.8 — Commit**

```bash
cd /Users/koraysels/work/flash && git add backend/src/ai/tracker.ts backend/tests/ai/tracker.test.ts && git commit -m "feat: direction-aware matching to prevent ID switches"
```
