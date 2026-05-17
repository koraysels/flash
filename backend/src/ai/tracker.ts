import { DetectionResult } from './detector'

export type TrackedVehicle = DetectionResult & {
  id: number
  cx: number; cy: number
  /** Bottom-center x — ground-plane contact point, use for speed/counting */
  bcx: number
  /** Bottom-center y — ground-plane contact point, use for speed/counting */
  bcy: number
  history: Array<{ cx: number; cy: number; timestamp: number }>
  missedFrames: number
  confirmedFrames: number
}

// ── Kalman noise parameters (highway-tuned) ───────────────────────────────────
// Fixed camera + straight-line highway motion → constant-velocity model is very accurate.
// Keep velocity process noise very low so the filter trusts the CV assumption.
const Q_POS  = 1.0   // position process noise (px²/s)
const Q_VEL  = 0.05  // velocity process noise ((px/s)²/s) — low: highway = constant speed

// Measurement noise as a function of detection confidence.
// High confidence → trust the detector. Low confidence → trust the KF prediction more.
const rMeas = (conf: number): number => 4 + (1 - conf) ** 2 * 56  // [4 px² … 60 px²]

// ── ByteTrack matching parameters ────────────────────────────────────────────
const HIGH_CONF  = 0.55   // detections at/above this go into the first association stage
const IOU_STAGE1 = 0.35   // strict IoU minimum — KF prediction is accurate, so we can be choosy
const IOU_STAGE2 = 0.12   // lenient — recover tracks lost to occlusion/low-conf detections

// ── Track lifecycle ───────────────────────────────────────────────────────────
const BOX_EMA       = 0.6   // EMA weight for width/height updates
const MAX_MISSED    = 15    // frames before a track is dropped (~1.5 s at 10 fps AI)
const MIN_CONFIRMED = 2     // frames before a track is reported

// ── 1-D Kalman filter: state = [position, velocity] ──────────────────────────
// The 2×2 covariance matrix is stored as three scalars (symmetric: p00, p01, p11).
// dt is in seconds; position/velocity in pixels.
class KF1D {
  pos: number; vel: number
  p00: number; p01: number; p11: number

  constructor(pos: number) {
    this.pos = pos; this.vel = 0
    // Start uncertain about velocity; moderate uncertainty about position.
    this.p00 = 200; this.p01 = 0; this.p11 = 10_000
  }

  predict(dt: number): void {
    // x = F*x  (constant velocity)
    this.pos += this.vel * dt
    // P = F*P*F' + Q  (where F = [[1,dt],[0,1]])
    const p00 = this.p00 + 2 * dt * this.p01 + dt * dt * this.p11 + Q_POS * dt
    const p01 = this.p01 + dt * this.p11
    this.p11 += Q_VEL * dt
    this.p00 = p00; this.p01 = p01
  }

  update(z: number, r: number): void {
    // K = P*H' / (H*P*H' + R)  where H = [1, 0]
    const S  = this.p00 + r
    const K0 = this.p00 / S   // gain on position
    const K1 = this.p01 / S   // gain on velocity (cross-covariance)
    const innov = z - this.pos
    this.pos += K0 * innov
    this.vel += K1 * innov
    // P = (I - K*H) * P  — save p01 before clobbering
    const p01 = this.p01
    this.p00 = (1 - K0) * this.p00
    this.p01 = (1 - K0) * p01
    this.p11 -= K1 * p01
  }
}

type Box = { x1: number; y1: number; x2: number; y2: number }

type KFTrack = TrackedVehicle & {
  kfX: KF1D; kfY: KF1D
  w: number; h: number   // EMA-smoothed box dimensions
  lastTs: number         // timestamp of last update (ms)
}

function iou(a: Box, b: Box): number {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1)
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2)
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
  const aA = (a.x2 - a.x1) * (a.y2 - a.y1)
  const bA = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (aA + bA - inter + 1e-9)
}

/**
 * Greedy IoU matching — pairs tracks and detections by highest IoU first.
 * trackIndices / detIndices are subsets of the full arrays to consider.
 * Returns {ti, di} pairs where ti indexes this.tracks and di indexes detections.
 */
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
  candidates.sort((a, b) => b.score - a.score)

  const usedT = new Set<number>()
  const usedD = new Set<number>()
  const result: Array<{ ti: number; di: number }> = []
  for (const { ti, di, score: _ } of candidates) {
    if (!usedT.has(ti) && !usedD.has(di)) {
      result.push({ ti, di })
      usedT.add(ti); usedD.add(di)
    }
  }
  return result
}

export class Tracker {
  private tracks: KFTrack[] = []
  private nextId = 1

  /**
   * @param timestamp  Frame capture time in milliseconds (from msg.frameTime).
   *                   Defaults to Date.now() for call sites that don't supply it.
   */
  update(detections: DetectionResult[], timestamp: number = Date.now()): TrackedVehicle[] {
    // ── 1. Predict each track forward to the current frame ──────────────────
    const predicted: Box[] = this.tracks.map((t) => {
      const dt = Math.max(0.01, Math.min((timestamp - t.lastTs) / 1000, 2.0))
      t.kfX.predict(dt)
      t.kfY.predict(dt)
      return {
        x1: t.kfX.pos - t.w / 2, y1: t.kfY.pos - t.h / 2,
        x2: t.kfX.pos + t.w / 2, y2: t.kfY.pos + t.h / 2,
      }
    })

    // ── 2. Split detections by confidence ───────────────────────────────────
    const allTI   = this.tracks.map((_, i) => i)
    const highDI  = detections.map((_, i) => i).filter(i => detections[i].confidence >= HIGH_CONF)
    const lowDI   = detections.map((_, i) => i).filter(i => detections[i].confidence < HIGH_CONF)

    // ── 3. Stage 1: associate high-conf dets with all tracks ────────────────
    const m1 = greedyMatch(predicted, allTI, detections, highDI, IOU_STAGE1)
    const matchedT1 = new Set(m1.map(m => m.ti))

    // ── 4. Stage 2: associate low-conf dets with still-unmatched tracks ─────
    // Low-conf detections can keep an existing track alive (occluded vehicle,
    // partial visibility) but cannot initialize new tracks.
    const unmatchedTI = allTI.filter(i => !matchedT1.has(i))
    const m2 = greedyMatch(predicted, unmatchedTI, detections, lowDI, IOU_STAGE2)

    // ── 5. Apply matched updates ─────────────────────────────────────────────
    const allMatched = [...m1, ...m2]
    const matchedTSet = new Set(allMatched.map(m => m.ti))

    for (const { ti, di } of allMatched) {
      const t   = this.tracks[ti]
      const det = detections[di]
      const r   = rMeas(det.confidence)

      t.kfX.update((det.x1 + det.x2) / 2, r)
      t.kfY.update((det.y1 + det.y2) / 2, r)
      t.w  = BOX_EMA * (det.x2 - det.x1) + (1 - BOX_EMA) * t.w
      t.h  = BOX_EMA * (det.y2 - det.y1) + (1 - BOX_EMA) * t.h

      t.x1 = t.kfX.pos - t.w / 2; t.y1 = t.kfY.pos - t.h / 2
      t.x2 = t.kfX.pos + t.w / 2; t.y2 = t.kfY.pos + t.h / 2
      t.cx = t.kfX.pos; t.cy = t.kfY.pos
      t.bcx = t.cx;     t.bcy = t.y2 - t.h * 0.05   // 5% inset: avoids bonnet of car below

      t.confidence = det.confidence
      t.history.push({ cx: t.cx, cy: t.cy, timestamp })
      if (t.history.length > 30) t.history.shift()

      t.missedFrames = 0
      t.confirmedFrames++
      t.lastTs = timestamp
    }

    // ── 6. Increment missed frames for unmatched tracks ──────────────────────
    for (let ti = 0; ti < this.tracks.length; ti++) {
      if (!matchedTSet.has(ti)) this.tracks[ti].missedFrames++
    }

    // ── 7. Drop lost tracks ───────────────────────────────────────────────────
    this.tracks = this.tracks.filter(t => t.missedFrames < MAX_MISSED)

    // ── 8. Spawn new tracks from unmatched high-conf detections ──────────────
    // Low-conf detections are never used to start a new track (ByteTrack rule —
    // avoids creating spurious tracks from background noise).
    const matchedHighDIs = new Set(m1.map(m => m.di))
    for (const di of highDI) {
      if (matchedHighDIs.has(di)) continue
      const det = detections[di]
      const cx = (det.x1 + det.x2) / 2
      const cy = (det.y1 + det.y2) / 2
      const w  = det.x2 - det.x1
      const h  = det.y2 - det.y1
      this.tracks.push({
        ...det,
        id: this.nextId++,
        cx, cy, bcx: cx, bcy: det.y2 - h * 0.05,
        kfX: new KF1D(cx), kfY: new KF1D(cy),
        w, h, lastTs: timestamp,
        history: [{ cx, cy, timestamp }],
        missedFrames: 0, confirmedFrames: 1,
      })
    }

    return this.tracks.filter(t => t.missedFrames === 0 && t.confirmedFrames >= MIN_CONFIRMED)
  }

  reset(): void {
    this.tracks = []
  }
}
