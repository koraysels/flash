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
  // Looser IoU gates: a fast car moves a lot between frames and a brand-new track
  // has velocity 0 (prediction doesn't move yet), so a strict gate never lets the
  // track catch its 2nd detection → it dies and re-spawns a new id every frame.
  iouStage1: 0.20,
  iouStage2: 0.08,
  maxPredictedGap: 6,
  maxMissedFrames: 30,
  minConfirmedFrames: 2,
  boxEmaAlpha: 0.60,
  qPos: 1.0,
  qVel: 0.05,
  speedPlausibilityKmh: 170,
}

const VEL_MAG_THRESHOLD = 20
const MIN_FRAMES_FOR_DIRECTION = 3
const IOU_WEIGHT = 0.7   // IoU fraction in combined score; direction gets 1 - IOU_WEIGHT

const rMeas = (conf: number): number => 4 + (1 - conf) ** 2 * 56

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

type Box = { x1: number; y1: number; x2: number; y2: number }

type KFTrack = TrackedVehicle & {
  kf: KF2D
  w: number; h: number
  lastTs: number
  classVotes: Map<string, number>
}

function iou(a: Box, b: Box): number {
  const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1)
  const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2)
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
  const aA = (a.x2 - a.x1) * (a.y2 - a.y1)
  const bA = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (aA + bA - inter + 1e-9)
}

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
      const score = iouScore * IOU_WEIGHT + ds * (1 - IOU_WEIGHT)
      candidates.push({ ti, di, score })
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

// Fraction of frame W/H that counts as "near the edge" (where vehicles exit).
const EDGE_FRAC = 0.08
// Interior tracks (a detector blink while well inside the frame — the vehicle
// almost certainly didn't leave) are kept alive this many × longer so they
// re-attach the SAME id on re-detection instead of flickering to a new one.
const INTERIOR_MISS_MULT = 5

export class Tracker {
  private tracks: KFTrack[] = []
  private nextId = 1
  private cfg: TrackerConfig
  private frameW = 768
  private frameH = 576

  constructor(config?: Partial<TrackerConfig>) {
    this.cfg = { ...DEFAULT_TRACKER_CONFIG, ...config }
  }

  /** Frame dimensions in pixels — used for edge-aware track persistence. */
  setFrameSize(w: number, h: number): void {
    if (w > 0 && h > 0) { this.frameW = w; this.frameH = h }
  }

  update(detections: DetectionResult[], timestamp: number = Date.now()): TrackedVehicle[] {
    const { highConfidence, iouStage1, iouStage2, maxPredictedGap, maxMissedFrames, minConfirmedFrames, boxEmaAlpha } = this.cfg

    const predicted: Box[] = this.tracks.map((t) => {
      const dt = Math.max(0.01, Math.min((timestamp - t.lastTs) / 1000, 2.0))
      t.kf.predict(dt)
      t.lastTs = timestamp
      return {
        x1: t.kf.cx - t.w / 2, y1: t.kf.cy - t.h / 2,
        x2: t.kf.cx + t.w / 2, y2: t.kf.cy + t.h / 2,
      }
    })

    const allTI  = this.tracks.map((_, i) => i)
    const highDI = detections.map((_, i) => i).filter(i => detections[i].confidence >= highConfidence)
    const lowDI  = detections.map((_, i) => i).filter(i => detections[i].confidence < highConfidence)

    const velocities: Array<VelInfo | null> = this.tracks.map((t) => ({
      vx: t.kf.vx,
      vy: t.kf.vy,
      mag: t.kf.velMag(),
      confirmedFrames: t.confirmedFrames,
    }))

    const m1 = greedyMatch(predicted, allTI, detections, highDI, iouStage1, velocities)
    const matchedT1 = new Set(m1.map(m => m.ti))
    const unmatchedTI = allTI.filter(i => !matchedT1.has(i))
    const m2 = greedyMatch(predicted, unmatchedTI, detections, lowDI, iouStage2, velocities)

    const allMatched = [...m1, ...m2]
    const matchedTSet = new Set(allMatched.map(m => m.ti))

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

      t.confidence = det.confidence
      // Majority vote over matched detections — first-frame misclassifications
      // (vehicle still small/far) shouldn't stick for the track's lifetime
      t.classVotes.set(det.class, (t.classVotes.get(det.class) ?? 0) + 1)
      let bestClass = t.class
      let bestVotes = 0
      for (const [cls, votes] of t.classVotes) {
        if (votes > bestVotes) { bestClass = cls; bestVotes = votes }
      }
      t.class = bestClass
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
        t.cx = t.kf.cx; t.cy = t.kf.cy
        t.x1 = t.cx - t.w / 2; t.y1 = t.cy - t.h / 2
        t.x2 = t.cx + t.w / 2; t.y2 = t.cy + t.h / 2
        t.bcx = t.cx; t.bcy = t.y2 - t.h * 0.05
        t.isPredicted = true
      }
    }

    // Edge-aware persistence: a track lost while INTERIOR is a detector blink, not
    // an exit — keep it alive much longer so it re-attaches its id when re-detected.
    // Near a frame edge, vehicles really do leave, so drop on the normal budget.
    const edgeX = this.frameW * EDGE_FRAC
    const edgeY = this.frameH * EDGE_FRAC
    this.tracks = this.tracks.filter(t => {
      const nearEdge = t.bcx < edgeX || t.bcx > this.frameW - edgeX ||
                       t.bcy < edgeY || t.bcy > this.frameH - edgeY
      const limit = nearEdge ? maxMissedFrames : maxMissedFrames * INTERIOR_MISS_MULT
      return t.missedFrames < limit
    })

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
        kf: new KF2D(cx, cy, this.cfg.qPos, this.cfg.qVel),
        w, h, lastTs: timestamp,
        classVotes: new Map([[det.class, 1]]),
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
