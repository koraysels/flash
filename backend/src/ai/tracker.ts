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
  /** Use the motion-gated matcher (Kalman covariance gate + direction veto)
   *  instead of the legacy IoU-only matcher. Toggle per camera to A/B test. */
  motionGated: boolean
  /** Log id-swap diagnostics to stderr: every new id spawning within 200px of a
   *  confirmed track, marked SUPPRESS (guard caught it) or SPAWN (slipped through). */
  trackDebug: boolean
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  highConfidence: 0.55,
  // Looser IoU gates: a fast car moves a lot per frame and a brand-new track has
  // velocity 0 (prediction doesn't move yet), so a strict gate never lets it catch
  // its 2nd detection → it re-spawns a new id every frame (count inflation + false
  // MQTT flashes). CONFIG-ONLY change — safe (the static crash was the separate
  // draw-coasted change, not this).
  iouStage1: 0.20,
  iouStage2: 0.08,
  maxPredictedGap: 6,
  maxMissedFrames: 30,
  minConfirmedFrames: 2,
  boxEmaAlpha: 0.60,
  qPos: 1.0,
  qVel: 0.05,
  speedPlausibilityKmh: 170,
  motionGated: false,   // default to the proven legacy IoU matcher
  trackDebug: false,
}

const VEL_MAG_THRESHOLD = 20
const MIN_FRAMES_FOR_DIRECTION = 3
const IOU_WEIGHT = 0.7   // legacy IoU matcher: IoU fraction in combined score

// --- Motion-gated association tuning (SORT Kalman + DeepSORT covariance gate +
// OC-SORT direction consistency). A (track,det) pair is a candidate if the boxes
// overlap (IoU >= stage threshold) OR the detection center is within a
// covariance-scaled gate of the Kalman-predicted center. New/uncertain tracks
// have large position variance → wide gate (a fast car's 2nd detection attaches
// and velocity locks), established tracks have small variance → tight gate.
const GATE_K = 4               // sigma multiplier on the predicted-position std
const GATE_MIN_PX = 36         // floor: re-acquisition after a 1-frame miss is ~16-35px (measured)
const GATE_VEL_FRAMES = 1.5    // also cover this many frames of the track's own motion
const GATE_COAST_PX = 14       // widen the gate this many px per missed frame, so a track occluded behind the gantry can still re-acquire when its box has drifted (esp. shrinking cars driving away, whose own box is too small to gate on)
const GATE_MAX_FRAC = 0.25     // cap gate at this fraction of the smaller frame side (bounded)
const W_IOU = 0.5              // cost weights (sum = 1)
const W_DIST = 0.35
const W_DIR = 0.15
const REVERSE_DIR_SCORE = 0.35 // dirScore below this = against heading → veto unless boxes overlap
const NEW_TRACK_SUPPRESS_IOU = 0.2  // unmatched high-conf det overlapping a confirmed track this much = duplicate/swap, not a new car → don't spawn
const NEW_TRACK_PROX_FRAC = 1.1     // OR: within this many box-sizes of a SAME-ZONE confirmed track = same car re-emerging from occlusion (its coasted box drifted ~1 box away). Re-acquire it instead of spawning a new id.
const COAST_VEL_DAMP = 0.75         // each coasted (unmatched) frame, decay velocity by this — a lost box slows instead of flying ahead at stale speed (perspective decel / occlusion). 0.75^6≈0.18 after a full gap
const RENDER_MEAS_WEIGHT = 0.55     // matched-frame box render: weight toward the raw detection centre vs the Kalman centre. Lower = more KF damping = less frame-to-frame wiggle (yolov8s boxes jitter); the KF is corrected toward the measurement on matched frames so lead stays small. Coasted tracks render off the KF prediction, unaffected.

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

  /** Predicted position variance (px², avg of both axes) — drives the
   *  covariance-scaled association gate: large when the track is new/uncertain,
   *  small once it has locked on. */
  posVar(): number {
    return (this.px00 + this.py00) / 2
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

// Ray-cast point-in-polygon on a flattened normalised polygon [x1,y1,...].
function pointInPoly(nx: number, ny: number, poly: number[]): boolean {
  if (poly.length < 6) return false
  let inside = false
  const n = poly.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1]
    const xj = poly[j * 2], yj = poly[j * 2 + 1]
    if (((yi > ny) !== (yj > ny)) && (nx < ((xj - xi) * (ny - yi)) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

// Per-track zone context for the motion-gated matcher: which zone each track/det
// is in, the zone's fixed heading (unit vector), and the frame size for normalising.
type ZoneInfo = {
  trackZone: number[]
  detZone: number[]
  trackDir: Array<{ x: number; y: number } | null>
  frameW: number
  frameH: number
}

function dirScore(vel: VelInfo | null, pred: Box, det: DetectionResult): number {
  if (!vel || vel.mag < VEL_MAG_THRESHOLD || vel.confirmedFrames < MIN_FRAMES_FOR_DIRECTION) return 0.5
  const dx = (det.x1 + det.x2) / 2 - (pred.x1 + pred.x2) / 2
  const dy = (det.y1 + det.y2) / 2 - (pred.y1 + pred.y2) / 2
  const deltaMag = Math.sqrt(dx * dx + dy * dy)
  if (deltaMag < 1e-6) return 0.5
  const cos = (vel.vx * dx + vel.vy * dy) / (vel.mag * deltaMag)
  return (cos + 1) / 2
}

// Heading score measured from the track's LAST OBSERVED centre (not the Kalman
// prediction). The prediction overshoots a car whose image-speed is dropping
// (e.g. receding), placing the detection "behind" it → a false reverse-direction
// reading. Measuring from the last seen point gives the real motion since then.
function dirScoreRef(vel: VelInfo | null, refCx: number, refCy: number, det: DetectionResult): number {
  if (!vel || vel.mag < VEL_MAG_THRESHOLD || vel.confirmedFrames < MIN_FRAMES_FOR_DIRECTION) return 0.5
  const dx = (det.x1 + det.x2) / 2 - refCx
  const dy = (det.y1 + det.y2) / 2 - refCy
  const m = Math.hypot(dx, dy)
  if (m < 1e-6) return 0.5
  const cos = (vel.vx * dx + vel.vy * dy) / (vel.mag * m)
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

// Motion-gated matcher (opt-in via cfg.motionGated). Same greedy assignment as
// the legacy matcher, but a pair is a candidate when boxes overlap OR the
// detection center is within the track's covariance-scaled gate, and the cost
// blends IoU + (motion-predicted) center distance + direction consistency, with
// a veto on matches that contradict an established heading.
function greedyMatchMotion(
  predicted: Box[],
  trackIndices: number[],
  detections: DetectionResult[],
  detIndices: number[],
  threshold: number,
  velocities: Array<VelInfo | null>,
  gateRadii: number[],
  lastCenters: Array<{ cx: number; cy: number }>,
  zones?: ZoneInfo,
): Array<{ ti: number; di: number }> {
  const candidates: Array<{ ti: number; di: number; score: number }> = []
  for (const ti of trackIndices) {
    const p = predicted[ti]
    const pcx = (p.x1 + p.x2) / 2
    const pcy = (p.y1 + p.y2) / 2
    const gate = gateRadii[ti]
    const vel = velocities[ti]
    const last = lastCenters[ti]
    const established = !!vel && vel.mag >= VEL_MAG_THRESHOLD && vel.confirmedFrames >= MIN_FRAMES_FOR_DIRECTION
    for (const di of detIndices) {
      const det = detections[di]
      const iouScore = iou(p, det)
      const dcx = (det.x1 + det.x2) / 2
      const dcy = (det.y1 + det.y2) / 2
      const centerDist = Math.hypot(dcx - pcx, dcy - pcy)
      const overlaps = iouScore >= threshold
      const withinGate = centerDist <= gate
      if (!overlaps && !withinGate) continue                          // dual gate
      // Direction is a SOFT preference, never a hard veto: a detection inside the
      // gate is almost certainly the same car (vetoing it just spawns a duplicate
      // id — the bug we chased). Heading measured from the last OBSERVED centre.
      const ds = dirScoreRef(vel, last.cx, last.cy, det)
      const distNorm = Math.min(centerDist / Math.max(gate, 1e-6), 1)
      let score = W_IOU * iouScore + W_DIST * (1 - distNorm) + W_DIR * ds
      // Cross-zone = probably a different lane/car → discourage (but don't block, so
      // a car crossing a zone boundary keeps its id).
      if (zones && zones.trackZone[ti] >= 0 && zones.detZone[di] >= 0 && zones.detZone[di] !== zones.trackZone[ti]) {
        score *= 0.25
      }
      candidates.push({ ti, di, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  const usedT = new Set<number>()
  const usedD = new Set<number>()
  const result: Array<{ ti: number; di: number }> = []
  for (const { ti, di } of candidates) {
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
  private frameW = 768
  private frameH = 576
  // Direction zones (normalised polygon + unit heading) — per-lane fixed-direction
  // prior + same-zone association for the motion-gated matcher.
  private dirZones: Array<{ poly: number[]; dir: { x: number; y: number } }> = []

  constructor(config?: Partial<TrackerConfig>) {
    this.cfg = { ...DEFAULT_TRACKER_CONFIG, ...config }
  }

  /** Frame dimensions in pixels — used for edge-aware track persistence. */
  setFrameSize(w: number, h: number): void {
    if (w > 0 && h > 0) { this.frameW = w; this.frameH = h }
  }

  /** Set per-lane direction zones (normalised polygon + arrow [ax1,ay1,ax2,ay2]). */
  setDirectionZones(zones: Array<{ polygon: number[]; arrow: number[] }>): void {
    this.dirZones = (zones ?? [])
      .filter((z) => Array.isArray(z.polygon) && z.polygon.length >= 6 && Array.isArray(z.arrow) && z.arrow.length === 4)
      .map((z) => {
        const dx = z.arrow[2] - z.arrow[0], dy = z.arrow[3] - z.arrow[1]
        const m = Math.hypot(dx, dy) || 1
        return { poly: z.polygon, dir: { x: dx / m, y: dy / m } }
      })
  }

  /** Direction-zone index containing pixel point (px,py), or -1 if none/unset. */
  private zoneOf(px: number, py: number): number {
    if (!this.dirZones.length) return -1
    const nx = px / this.frameW, ny = py / this.frameH
    for (let z = 0; z < this.dirZones.length; z++) if (pointInPoly(nx, ny, this.dirZones[z].poly)) return z
    return -1
  }

  /** Bind a detection to a track: Kalman update, box/class smoothing, reset the
   *  miss counter. Used both for the matcher's results and for re-acquiring a
   *  coasted track whose box drifted off the car during occlusion. */
  private attachDetection(t: KFTrack, det: DetectionResult, timestamp: number): void {
    const r = rMeas(det.confidence)
    const mcx = (det.x1 + det.x2) / 2, mcy = (det.y1 + det.y2) / 2
    t.kf.update(mcx, mcy, r)
    t.w = this.cfg.boxEmaAlpha * (det.x2 - det.x1) + (1 - this.cfg.boxEmaAlpha) * t.w
    t.h = this.cfg.boxEmaAlpha * (det.y2 - det.y1) + (1 - this.cfg.boxEmaAlpha) * t.h
    const rcx = RENDER_MEAS_WEIGHT * mcx + (1 - RENDER_MEAS_WEIGHT) * t.kf.cx
    const rcy = RENDER_MEAS_WEIGHT * mcy + (1 - RENDER_MEAS_WEIGHT) * t.kf.cy
    t.x1 = rcx - t.w / 2; t.y1 = rcy - t.h / 2
    t.x2 = rcx + t.w / 2; t.y2 = rcy + t.h / 2
    t.cx = rcx; t.cy = rcy
    t.bcx = t.cx; t.bcy = t.y2 - t.h * 0.05
    t.confidence = det.confidence
    t.classVotes.set(det.class, (t.classVotes.get(det.class) ?? 0) + 1)
    let bestClass = t.class, bestVotes = 0
    for (const [cls, votes] of t.classVotes) { if (votes > bestVotes) { bestClass = cls; bestVotes = votes } }
    t.class = bestClass
    t.history.push({ cx: t.cx, cy: t.cy, timestamp })
    if (t.history.length > 30) t.history.shift()
    t.missedFrames = 0
    t.confirmedFrames++
    t.isPredicted = false
  }

  update(detections: DetectionResult[], timestamp: number = Date.now()): TrackedVehicle[] {
    const { highConfidence, iouStage1, iouStage2, maxPredictedGap, maxMissedFrames, minConfirmedFrames } = this.cfg

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

    // Last OBSERVED centre per track (predict() above mutates kf.cx/cy but not
    // t.cx/cy, so these still hold the previous frame's settled centre) — used as
    // the heading reference so prediction overshoot can't trigger a false veto.
    const lastCenters = this.tracks.map((t) => ({ cx: t.cx, cy: t.cy }))

    const motionGated = this.cfg.motionGated
    let m1: Array<{ ti: number; di: number }>
    let m2: Array<{ ti: number; di: number }>
    if (motionGated) {
      // Covariance-scaled gate per track (bounded between a floor and a fraction
      // of the frame so an uncertain track can't grab everything).
      const gmax = GATE_MAX_FRAC * Math.min(this.frameW, this.frameH)
      const gateRadii = this.tracks.map(t => {
        // Covariance term + one+ frame of the track's own motion (so a 1-frame miss
        // on a moving car still re-acquires instead of spawning a new id).
        let s = GATE_K * Math.sqrt(Math.max(t.kf.posVar(), 1)) + t.kf.velMag() * 0.05 * GATE_VEL_FRAMES
        // Widen with coast duration — the longer a track is occluded, the further its
        // box may have drifted from the (re-emerging, possibly shrunken) car.
        s += t.missedFrames * GATE_COAST_PX
        // A brand-new track has velocity 0, so its prediction doesn't move yet —
        // widen the gate while it's still learning velocity so a fast car's 2nd
        // detection attaches (then the gate tightens as the KF locks on).
        if (t.confirmedFrames < MIN_FRAMES_FOR_DIRECTION) s *= 2
        return Math.min(Math.max(s, GATE_MIN_PX), gmax)
      })
      let zones: ZoneInfo | undefined
      if (this.dirZones.length) {
        const zoneOf = (px: number, py: number): number => {
          const nx = px / this.frameW, ny = py / this.frameH
          for (let z = 0; z < this.dirZones.length; z++) if (pointInPoly(nx, ny, this.dirZones[z].poly)) return z
          return -1
        }
        const trackZone = lastCenters.map((c) => zoneOf(c.cx, c.cy))
        zones = {
          trackZone,
          detZone: detections.map((d) => zoneOf((d.x1 + d.x2) / 2, d.y2)),  // ground point
          trackDir: trackZone.map((z) => (z >= 0 ? this.dirZones[z].dir : null)),
          frameW: this.frameW, frameH: this.frameH,
        }
      }
      m1 = greedyMatchMotion(predicted, allTI, detections, highDI, iouStage1, velocities, gateRadii, lastCenters, zones)
      const matchedT1 = new Set(m1.map(m => m.ti))
      const unmatchedTI = allTI.filter(i => !matchedT1.has(i))
      m2 = greedyMatchMotion(predicted, unmatchedTI, detections, lowDI, iouStage2, velocities, gateRadii, lastCenters, zones)
    } else {
      m1 = greedyMatch(predicted, allTI, detections, highDI, iouStage1, velocities)
      const matchedT1 = new Set(m1.map(m => m.ti))
      const unmatchedTI = allTI.filter(i => !matchedT1.has(i))
      m2 = greedyMatch(predicted, unmatchedTI, detections, lowDI, iouStage2, velocities)
    }

    const allMatched = [...m1, ...m2]
    const matchedTSet = new Set(allMatched.map(m => m.ti))

    for (const { ti, di } of allMatched) {
      this.attachDetection(this.tracks[ti], detections[di], timestamp)
    }

    for (let ti = 0; ti < this.tracks.length; ti++) {
      if (!matchedTSet.has(ti)) {
        const t = this.tracks[ti]
        t.missedFrames++
        // Damp velocity while coasting so the predicted box doesn't run ahead of a
        // car that has slowed (perspective) or vanished behind an occluder. Without
        // this the box leads the car further every missed frame (the "box precedes
        // the car" overshoot). Next frame's predict() uses the decayed velocity.
        t.kf.vx *= COAST_VEL_DAMP
        t.kf.vy *= COAST_VEL_DAMP
        t.cx = t.kf.cx; t.cy = t.kf.cy
        t.x1 = t.cx - t.w / 2; t.y1 = t.cy - t.h / 2
        t.x2 = t.cx + t.w / 2; t.y2 = t.cy + t.h / 2
        if (motionGated) {
          // Bounded: clamp the coasted box to the frame — no off-road / off-screen
          // ghost boxes drifting away on the Kalman prediction.
          t.x1 = Math.max(0, t.x1); t.y1 = Math.max(0, t.y1)
          t.x2 = Math.min(this.frameW, t.x2); t.y2 = Math.min(this.frameH, t.y2)
        }
        t.bcx = (t.x1 + t.x2) / 2; t.bcy = t.y2 - t.h * 0.05
        t.isPredicted = true
      }
    }

    // Flat, BOUNDED drop: a track lost for maxMissedFrames is removed. (The earlier
    // edge-aware 5× retention let interior ghost tracks linger and, with loose IoU,
    // get re-matched forever → unbounded track growth → tracker.update slowed every
    // frame → micro-freezes then full lock-up after ~1 min. Keep it bounded.)
    this.tracks = this.tracks.filter(t => t.missedFrames < maxMissedFrames)

    const matchedHighDIs = new Set(m1.map(m => m.di))
    for (const di of highDI) {
      if (matchedHighDIs.has(di)) continue
      const det = detections[di]
      const cx = (det.x1 + det.x2) / 2
      const cy = (det.y1 + det.y2) / 2
      const w  = det.x2 - det.x1
      const h  = det.y2 - det.y1
      // An unmatched high-conf detection that lands ON TOP of a confirmed track is
      // a duplicate detection (YOLO double-box on large/long vehicles, car/truck
      // class flip) or a missed greedy match — NOT a new vehicle. Two real cars
      // can't occupy the same pixels, so a high IoU here is always the same car.
      // Spawning a new id was the id-swap. Suppress it; the existing track keeps
      // its id and re-matches this detection next frame.
      let near: { t: KFTrack; id: number; iou: number; d: number; missed: number; cx: number; cy: number } | null = null
      for (const t of this.tracks) {
        if (t.confirmedFrames < minConfirmedFrames) continue
        const d = Math.hypot(t.cx - cx, t.cy - cy)
        if (!near || d < near.d) {
          near = { t, id: t.id, iou: iou(t, det), d, missed: t.missedFrames, cx: t.cx, cy: t.cy }
        }
      }
      // Two suppression signals, both meaning "same car, not a new one":
      //  1. overlap — IoU above threshold (duplicate box / class flip).
      //  2. SAME-ZONE proximity — Kalman overshoot after occlusion runs the track
      //     box ahead of the car, dropping IoU to ~0; but if the orphan detection
      //     sits within ~half a box of a confirmed track IN THE SAME DIRECTION ZONE,
      //     it's that car re-detected behind its own prediction, not a new one.
      //     Gated by same-zone so we never merge across lanes (that veto caused
      //     swaps before — c2465d5 — but here it suppresses a SPAWN, never a match).
      const dz = near ? this.zoneOf((det.x1 + det.x2) / 2, det.y2) : -1
      const tz = near ? this.zoneOf(near.cx, near.cy) : -1
      const sameZone = dz >= 0 && dz === tz
      const proxPx = NEW_TRACK_PROX_FRAC * Math.max(w, h)
      // Proximity-suppression ONLY applies to a COASTING track (missed > 0): that's
      // the drifted-box re-emergence case. Two ACTIVELY tracked cars (missed === 0)
      // can sit within a box of each other in dense traffic — they are DIFFERENT
      // cars, so a nearby detection must spawn its own id, not get swallowed. The
      // IoU branch still suppresses true duplicate boxes regardless of missed state.
      const sameCar = !!near && (near.iou > NEW_TRACK_SUPPRESS_IOU || (sameZone && near.d < proxPx && near!.missed > 0))
      // A coasted track (missed > 0) whose drifted box this detection re-emerged
      // near IS that car — re-acquire it (snap the track onto the detection) so the
      // id survives the occlusion. A matched track (missed === 0) means a duplicate
      // detection → just drop it.
      const recover = sameCar && near!.missed > 0
      if (this.cfg.trackDebug && near && near.d < 200) {
        const tag = recover ? 'RECOVER' : sameCar ? 'SUPPRESS' : `SPAWN#${this.nextId}`
        process.stderr.write(`[track-debug] ${tag} det(conf=${det.confidence.toFixed(2)} ${Math.round(w)}x${Math.round(h)}) near #${near.id} dist=${near.d.toFixed(0)} iou=${near.iou.toFixed(2)} missed=${near.missed} detZone=${dz} trackZone=${tz}${sameZone ? ' SAME-ZONE' : ''}\n`)
      }
      if (recover) { this.attachDetection(near!.t, det, timestamp); continue }
      if (sameCar) continue
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
