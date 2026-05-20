import { DetectionResult } from './detector'

export type TrackedVehicle = DetectionResult & {
  id: number
  cx: number; cy: number
  bcx: number
  bcy: number
  history: Array<{ cx: number; cy: number; timestamp: number }>
  missedFrames: number
  confirmedFrames: number
  isPredicted: boolean
}

export type TrackerConfig = {
  /** Min detector confidence to enter stage-1 matching (0.40–0.75) */
  highConfidence: number
  /** IoU threshold for stage-1 (high-conf dets vs all tracks) (0.20–0.55) */
  iouStage1: number
  /** IoU threshold for stage-2 recovery (low-conf dets vs unmatched) (0.05–0.25) */
  iouStage2: number
  /** Frames to keep emitting a predicted box when detector misses (1–8) */
  maxPredictedGap: number
  /** Frames without any match before the track is permanently dropped (10–60) */
  maxMissedFrames: number
  /** Frames needed before a new track is reported (2–4) */
  minConfirmedFrames: number
  /** EMA alpha for bounding-box width/height smoothing (0.40–0.80) */
  boxEmaAlpha: number
  /** Kalman position process noise px²/s (0.3–3.0) */
  qPos: number
  /** Kalman velocity process noise (px/s)²/s (0.01–0.30) */
  qVel: number
  /** Hard cap on speed outputs — values above this are filtered as outliers (120–180) */
  speedPlausibilityKmh: number
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  highConfidence: 0.55,
  iouStage1: 0.35,
  iouStage2: 0.12,
  maxPredictedGap: 3,
  maxMissedFrames: 30,
  minConfirmedFrames: 2,
  boxEmaAlpha: 0.60,
  qPos: 1.0,
  qVel: 0.05,
  speedPlausibilityKmh: 170,
}

const rMeas = (conf: number): number => 4 + (1 - conf) ** 2 * 56

class KF1D {
  pos: number; vel: number
  p00: number; p01: number; p11: number

  constructor(pos: number, private readonly qPos: number, private readonly qVel: number) {
    this.pos = pos; this.vel = 0
    this.p00 = 200; this.p01 = 0; this.p11 = 10_000
  }

  predict(dt: number): void {
    this.pos += this.vel * dt
    const p00 = this.p00 + 2 * dt * this.p01 + dt * dt * this.p11 + this.qPos * dt
    const p01 = this.p01 + dt * this.p11
    this.p11 += this.qVel * dt
    this.p00 = p00; this.p01 = p01
  }

  update(z: number, r: number): void {
    const S  = this.p00 + r
    const K0 = this.p00 / S
    const K1 = this.p01 / S
    const innov = z - this.pos
    this.pos += K0 * innov
    this.vel += K1 * innov
    const p01 = this.p01
    this.p00 = (1 - K0) * this.p00
    this.p01 = (1 - K0) * p01
    this.p11 -= K1 * p01
  }
}

type Box = { x1: number; y1: number; x2: number; y2: number }

type KFTrack = TrackedVehicle & {
  kfX: KF1D; kfY: KF1D
  w: number; h: number
  lastTs: number
}

function iou(a: Box, b: Box): number {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1)
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2)
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
  const aA = (a.x2 - a.x1) * (a.y2 - a.y1)
  const bA = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (aA + bA - inter + 1e-9)
}

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
  private cfg: TrackerConfig

  constructor(config?: Partial<TrackerConfig>) {
    this.cfg = { ...DEFAULT_TRACKER_CONFIG, ...config }
  }

  update(detections: DetectionResult[], timestamp: number = Date.now()): TrackedVehicle[] {
    const { highConfidence, iouStage1, iouStage2, maxPredictedGap, maxMissedFrames, minConfirmedFrames, boxEmaAlpha } = this.cfg

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

    const allTI  = this.tracks.map((_, i) => i)
    const highDI = detections.map((_, i) => i).filter(i => detections[i].confidence >= highConfidence)
    const lowDI  = detections.map((_, i) => i).filter(i => detections[i].confidence < highConfidence)

    const m1 = greedyMatch(predicted, allTI, detections, highDI, iouStage1)
    const matchedT1 = new Set(m1.map(m => m.ti))
    const unmatchedTI = allTI.filter(i => !matchedT1.has(i))
    const m2 = greedyMatch(predicted, unmatchedTI, detections, lowDI, iouStage2)

    const allMatched = [...m1, ...m2]
    const matchedTSet = new Set(allMatched.map(m => m.ti))

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

      t.confidence = det.confidence
      t.history.push({ cx: t.cx, cy: t.cy, timestamp })
      if (t.history.length > 30) t.history.shift()

      t.missedFrames = 0
      t.confirmedFrames++
      t.isPredicted = false
    }

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

    this.tracks = this.tracks.filter(t => t.missedFrames < maxMissedFrames)

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
        kfX: new KF1D(cx, this.cfg.qPos, this.cfg.qVel),
        kfY: new KF1D(cy, this.cfg.qPos, this.cfg.qVel),
        w, h, lastTs: timestamp,
        history: [{ cx, cy, timestamp }],
        missedFrames: 0, confirmedFrames: 1,
        isPredicted: false,
      })
    }

    return this.tracks.filter((t) => t.confirmedFrames >= minConfirmedFrames && t.missedFrames <= maxPredictedGap)
  }

  reset(): void {
    this.tracks = []
  }
}
