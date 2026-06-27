/**
 * Worker thread for per-camera AI processing.
 * Receives raw JPEG frames from the main thread, runs the full pipeline
 * (decode → letterbox → ONNX → track → count → speed → annotate → encode),
 * and posts results back. Runs in a separate OS thread so canvas and ONNX
 * work never blocks the main event loop's dequeue timer or MJPEG emission.
 */
import { parentPort, workerData } from 'worker_threads'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { join } from 'path'
import { Detector } from '../ai/detector'
import { Tracker, type TrackerConfig, DEFAULT_TRACKER_CONFIG } from '../ai/tracker'
import { DirectionCounter } from '../analysis/counter'
import { SpeedCalculator } from '../analysis/speed'
import { TrapSpeedCalculator, type TrapMeasurement } from '../analysis/trap-speed'
import { applyHomography, scaleHomography } from '../analysis/homography'
import { annotateFrame } from '../ai/annotator'

// ---- types shared with main thread -----------------------------------------------

export type WorkerInitData = {
  cameraId: string
  lineA: number
  lineB: number
  lineAPoints: number[]
  lineBPoints: number[]
  maxSpeedKmh: number | null
  homographyMatrix: number[]
  calibrationWidth: number | null
  calibrationHeight: number | null
  trapSpeedEnabled: boolean
  trackingConfig: TrackerConfig
  roiPolygon: number[]
  directionZones: Array<{ polygon: number[]; arrow: number[] }>
}

export type WorkerAnalyseMsg = {
  type: 'analyse'
  jpeg: Buffer
  frameTime: number
  seq: number
}

export type WorkerResetMsg = {
  type: 'reset-counts'
}

export type WorkerSetAnnotatedMsg = { type: 'set-annotated'; enabled: boolean }

export type WorkerResultMsg = {
  type: 'result'
  seq: number
  boxes: Array<{ id: number; class: string; speedKmh: number | null; x1: number; y1: number; x2: number; y2: number }>
  counts: { AB: number; BA: number; speeders: number }
  frameWidth: number
  frameHeight: number
  timing: { decodeMs: number; canvasMs: number; inferenceMs: number; trackMs: number; totalMs: number }
  recentTrapMeasurements: TrapMeasurement[]
  annotatedJpeg?: Buffer
  // One entry per track the first time its speed is confident — for MQTT publish.
  speedEvents?: Array<{ trackId: number; speedKmh: number; ts: number; direction: 'AB' | 'BA' | null }>
}

// ----------------------------------------------------------------------------------

const MODEL_PATH = join(process.cwd(), 'models/traffic_detector.onnx')

const { cameraId, lineA, lineB, lineAPoints, lineBPoints, maxSpeedKmh, homographyMatrix, calibrationWidth, calibrationHeight, trapSpeedEnabled, trackingConfig: rawTrackingConfig, roiPolygon, directionZones } = workerData as WorkerInitData

// Ray-casting point-in-polygon on a flattened normalised polygon [x1,y1,x2,y2,...].
function pip(nx: number, ny: number, poly: number[]): boolean {
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
const zonePolys = (directionZones ?? []).map((z) => z.polygon)
// Detection passes the road mask if: inside any direction zone (when zones defined),
// else inside the ROI polygon (when defined), else always.
function onRoad(nx: number, ny: number): boolean {
  if (zonePolys.length) return zonePolys.some((p) => pip(nx, ny, p))
  if (roiPolygon.length >= 6) return pip(nx, ny, roiPolygon)
  return true
}
const trackingConfig: TrackerConfig = { ...DEFAULT_TRACKER_CONFIG, ...rawTrackingConfig }

const detector = new Detector(MODEL_PATH)
const tracker = new Tracker(trackingConfig)
tracker.setDirectionZones(directionZones ?? [])
let counter = new DirectionCounter(576, lineA, lineB, lineAPoints, lineBPoints)
let speedCalc: SpeedCalculator | null = null

// Trap speed calculator — created lazily after first frame when frame dimensions are known
let trapCalc: TrapSpeedCalculator | null = null

let annotatedEnabled = true   // always annotate — encoder is persistent per camera
let lastErrLog = 0   // throttle repeated corrupt-frame errors
let actualWidth = 768
let actualHeight = 576
let speeders = 0
const countedSpeeders = new Set<number>()   // IDs already counted (never reset until reset-counts)
// White camera-flash on a fresh offender: frames remaining in the strobe burst,
// per id. Counts down per annotated frame; box drawn white on "on" (even) frames.
const speederStrobe = new Map<number, number>()
const STROBE_FRAMES = 8   // 4 on + 4 off — at 5fps ≈ 1.6s of frame-by-frame flashing
const publishedSpeedIds = new Set<number>()  // IDs already published to MQTT (once per track)
const vehicleZoneSpeed = new Map<number, number>()  // max speed seen while in zone per vehicle (continuous mode only)
let prevBoxIds = new Set<number>()

// Homography rescaled to the actual frame dimensions: calibration points were
// picked at (calibrationWidth, calibrationHeight), which may differ from the
// stream's decoded resolution.
let activeH: number[] = []

function rebuildCalibration(): void {
  if (homographyMatrix.length !== 9) return
  activeH = scaleHomography(
    homographyMatrix,
    calibrationWidth ?? actualWidth,
    calibrationHeight ?? actualHeight,
    actualWidth,
    actualHeight,
  )
  speedCalc = !trapSpeedEnabled
    ? new SpeedCalculator(activeH, maxSpeedKmh ?? undefined, trackingConfig.speedPlausibilityKmh)
    : null
}
rebuildCalibration()

function initTrapCalc(): void {
  if (!trapSpeedEnabled || activeH.length !== 9) return
  // Midpoint line distance is only logged for diagnostics — actual measurements
  // use each vehicle's own world-space path between its crossing points
  const midX = (pts: number[], fallbackNx: number) =>
    pts.length === 4 ? ((pts[0] + pts[2]) / 2) * actualWidth : fallbackNx * actualWidth
  const midY = (pts: number[], fallbackNy: number) =>
    pts.length === 4 ? ((pts[1] + pts[3]) / 2) * actualHeight : fallbackNy * actualHeight

  const wA = applyHomography(activeH, midX(lineAPoints, 0.5), midY(lineAPoints, lineA))
  const wB = applyHomography(activeH, midX(lineBPoints, 0.5), midY(lineBPoints, lineB))
  const distM = Math.hypot(wB.wx - wA.wx, wB.wy - wA.wy)
  if (distM > 0) {
    trapCalc = new TrapSpeedCalculator(activeH, maxSpeedKmh ?? undefined, trackingConfig.speedPlausibilityKmh)
    process.stderr.write(`[ai-worker:${cameraId}] trap speed enabled, midpoint line distance = ${distM.toFixed(2)}m\n`)
  }
}

// Periodic timing summary — log to stderr every 100 frames so you can see per-stage costs
let frameCount = 0
const timingSum = { decodeMs: 0, canvasMs: 0, inferenceMs: 0, trackMs: 0, totalMs: 0 }
let timingWindowStart = performance.now()

// Returns the normalised Y of a counting line at a given normalised X.
// For angled lines ([x1,y1,x2,y2]); falls back to the scalar fraction for horizontal ones.
function lineYAtX(pts: number[], nx: number, fallback: number): number {
  if (pts.length !== 4) return fallback
  const [x1, y1, x2, y2] = pts
  if (Math.abs(x2 - x1) < 1e-6) return (y1 + y2) / 2
  return y1 + ((y2 - y1) / (x2 - x1)) * (nx - x1)
}

detector.init()
  .then(() => parentPort!.postMessage({ type: 'ready' }))
  .catch((err) => parentPort!.postMessage({ type: 'error', error: String(err) }))

parentPort!.on('message', async (msg: WorkerAnalyseMsg | WorkerResetMsg | WorkerSetAnnotatedMsg) => {
  if (msg.type === 'set-annotated') {
    annotatedEnabled = msg.enabled
    return
  }

  if (msg.type === 'reset-counts') {
    counter.reset()
    speeders = 0
    countedSpeeders.clear()
    speederStrobe.clear()
    publishedSpeedIds.clear()
    vehicleZoneSpeed.clear()
    trapCalc?.reset()
    return
  }

  if (msg.type !== 'analyse') return

  const t0 = performance.now()

  try {
    const img = await loadImage(msg.jpeg)
    const { width, height } = img
    const t1 = performance.now()

    if (width !== actualWidth || height !== actualHeight) {
      counter = new DirectionCounter(height, lineA, lineB, lineAPoints, lineBPoints)
      actualWidth = width
      actualHeight = height
      trapCalc = null  // recreate with the rescaled homography
      rebuildCalibration()
      tracker.setFrameSize(width, height)  // edge-aware track persistence
    }

    if (trapSpeedEnabled && trapCalc === null) initTrapCalc()

    // Letterbox to 640×640 for ONNX input
    const scale = Math.min(640 / width, 640 / height)
    const scaledW = Math.round(width * scale)
    const scaledH = Math.round(height * scale)
    const padX = Math.round((640 - scaledW) / 2)
    const padY = Math.round((640 - scaledH) / 2)
    const canvas640 = createCanvas(640, 640)
    const ctx640 = canvas640.getContext('2d')
    ctx640.fillStyle = '#727272'  // 114,114,114 — YOLO letterbox fill used in training
    ctx640.fillRect(0, 0, 640, 640)
    ctx640.drawImage(img, padX, padY, scaledW, scaledH)
    const rgba640 = ctx640.getImageData(0, 0, 640, 640).data
    const t2 = performance.now()

    const rawDetections = await detector.detect(rgba640, padX, padY, scale, width, height)
    // Road ROI mask: keep only detections whose ground-contact point (bottom-centre)
    // is on the road — drops off-road clutter (billboards, opposite carriageway,
    // parked) before tracking, cutting phantom tracks. No ROI → keep all.
    const detections = (zonePolys.length || roiPolygon.length >= 6)
      ? rawDetections.filter((d) => onRoad(((d.x1 + d.x2) / 2) / width, d.y2 / height))
      : rawDetections
    const t3 = performance.now()

    const tracked = tracker.update(detections, msg.frameTime)
    const currentIds = new Set(tracked.map((v) => v.id))

    // Clean up vehicles that disappeared
    for (const id of prevBoxIds) {
      if (!currentIds.has(id)) {
        if (trapCalc) {
          trapCalc.removeVehicle(id)
        } else {
          // Continuous mode: if vehicle vanished while in zone, evaluate its peak speed now
          const maxZoneSpd = vehicleZoneSpeed.get(id)
          if (maxZoneSpd !== undefined && maxSpeedKmh !== null && maxZoneSpd > maxSpeedKmh && !countedSpeeders.has(id)) {
            countedSpeeders.add(id)
            speederStrobe.set(id, STROBE_FRAMES)
            speeders++
          }
          vehicleZoneSpeed.delete(id)
          speedCalc?.removeVehicle(id)
        }
      }
    }
    prevBoxIds = currentIds

    // Predicted (coasted) tracks have no measurement this frame — letting them
    // cross lines or feed the speed calculators produces phantom counts
    for (const v of tracked) {
      if (!v.isPredicted) counter.updateVehicle(v.id, v.bcx / actualWidth, v.bcy / actualHeight)
    }
    const counts = counter.getCounts()

    const boxes: WorkerResultMsg['boxes'] = []
    const speedEvents: NonNullable<WorkerResultMsg['speedEvents']> = []
    for (const v of tracked) {
      // Don't emit coasted/predicted tracks as boxes — they drift (Kalman) onto
      // empty road and show as ghost boxes. The frontend miss-fade bridges brief
      // detection gaps for real cars; counting/speed already skip predicted.
      if (v.isPredicted) continue
      const nx = v.bcx / actualWidth
      const ny = v.bcy / actualHeight
      const lineAY = lineYAtX(lineAPoints, nx, lineA)
      const lineBY = lineYAtX(lineBPoints, nx, lineB)
      let speedKmh: number | null = null

      if (trapCalc) {
        // Trap mode: time between line A and B crossings — speed locked in after both crossed
        if (!v.isPredicted) trapCalc.update(v.id, v.bcx, v.bcy, ny, lineAY, lineBY, msg.frameTime)
        speedKmh = trapCalc.getSpeed(v.id)
        // Only true speeders enter countedSpeeders — it dedups the count and arms
        // the white strobe. Adding sub-limit cars here strobed them without
        // counting them. Matches the continuous-mode gating above.
        if (speedKmh !== null && maxSpeedKmh !== null && speedKmh > maxSpeedKmh && !countedSpeeders.has(v.id)) {
          countedSpeeders.add(v.id)
          speederStrobe.set(v.id, STROBE_FRAMES)
          speeders++
        }
      } else if (speedCalc) {
        // Continuous mode: EMA-smoothed homography speed with zone-based speeder detection
        if (!v.isPredicted) speedCalc.addPosition(v.id, v.bcx, v.bcy, msg.frameTime)
        speedKmh = speedCalc.getSpeed(v.id)
        if (!v.isPredicted) {
          const inZone = ny >= Math.min(lineAY, lineBY) && ny <= Math.max(lineAY, lineBY)
          if (inZone && speedKmh !== null) {
            vehicleZoneSpeed.set(v.id, Math.max(vehicleZoneSpeed.get(v.id) ?? 0, speedKmh))
          } else if (!inZone && vehicleZoneSpeed.has(v.id)) {
            const maxZoneSpd = vehicleZoneSpeed.get(v.id)!
            if (maxSpeedKmh !== null && maxZoneSpd > maxSpeedKmh && !countedSpeeders.has(v.id)) {
              countedSpeeders.add(v.id)
              speederStrobe.set(v.id, STROBE_FRAMES)
              speeders++
            }
            vehicleZoneSpeed.delete(v.id)
          }
        }
      }

      boxes.push({ id: v.id, class: v.class, speedKmh, x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2 })

      // First confident speed for this track → emit one MQTT speed event.
      // ts = the frame's real ingest time (epoch seconds) so the strobe can apply
      // its own display-delay offset. Predicted tracks have speedKmh null (skipped).
      if (speedKmh !== null && !publishedSpeedIds.has(v.id)) {
        publishedSpeedIds.add(v.id)
        const direction = trapCalc?.getDirection(v.id) ?? null
        speedEvents.push({ trackId: v.id, speedKmh, ts: msg.frameTime / 1000, direction })
      }
    }

    // Advance each fresh offender's white-strobe burst once per frame. Box drawn
    // white on "on" frames (even count remaining) → frame-by-frame flash on/off,
    // 4 times, then the entry is dropped. At 20fps that's a ~0.4s fast strobe.
    const whiteStrobeIds = new Set<number>()
    for (const [id, left] of speederStrobe) {
      // Stop the strobe the moment the vehicle leaves frame (no longer tracked).
      if (!currentIds.has(id)) { speederStrobe.delete(id); continue }
      if (left % 2 === 0) whiteStrobeIds.add(id)
      if (left <= 1) speederStrobe.delete(id)
      else speederStrobe.set(id, left - 1)
    }

    let annotatedJpeg: Buffer | undefined
    if (annotatedEnabled) {
      annotatedJpeg = annotateFrame(
        img,
        // Draw coasted (predicted) boxes too — bridges the 1-2 frame detector
        // misses so boxes don't blink out. Bounded by the report gate
        // (missedFrames <= maxPredictedGap); motion-gated clamps them in-frame
        // and the annotator skips any non-finite box.
        tracked,
        lineA,
        lineB,
        { ab: counts.AB, ba: counts.BA, speeders, maxSpeedKmh },
        lineAPoints,
        lineBPoints,
        whiteStrobeIds,
      )
    }

    const t4 = performance.now()

    const timing = {
      decodeMs: Math.round(t1 - t0),
      canvasMs: Math.round(t2 - t1),
      inferenceMs: Math.round(t3 - t2),
      trackMs: Math.round(t4 - t3),
      totalMs: Math.round(t4 - t0),
    }

    // Per-stage timing summary — off by default (it floods stderr); enable with
    // FLASH_AI_TIMING=1 for perf diagnosis.
    if (process.env.FLASH_AI_TIMING) {
      frameCount++
      timingSum.decodeMs += timing.decodeMs
      timingSum.canvasMs += timing.canvasMs
      timingSum.inferenceMs += timing.inferenceMs
      timingSum.trackMs += timing.trackMs
      timingSum.totalMs += timing.totalMs
      if (frameCount % 50 === 0) {
        const now = performance.now()
        const fps = (50 / (now - timingWindowStart)) * 1000
        process.stderr.write(
          `[ai-worker:${cameraId}] avg over 50f @ ${fps.toFixed(1)}fps | ` +
          `decode=${(timingSum.decodeMs / 50).toFixed(1)} canvas=${(timingSum.canvasMs / 50).toFixed(1)} ` +
          `infer=${(timingSum.inferenceMs / 50).toFixed(1)} track=${(timingSum.trackMs / 50).toFixed(1)} ` +
          `total=${(timingSum.totalMs / 50).toFixed(1)}ms\n`
        )
        timingSum.decodeMs = timingSum.canvasMs = timingSum.inferenceMs = timingSum.trackMs = timingSum.totalMs = 0
        timingWindowStart = now
      }
    }

    parentPort!.postMessage({
      type: 'result',
      seq: msg.seq,
      boxes,
      counts: { ...counts, speeders },
      frameWidth: width,
      frameHeight: height,
      timing,
      recentTrapMeasurements: trapCalc?.getRecentMeasurements() ?? [],
      annotatedJpeg,
      speedEvents,
    } satisfies WorkerResultMsg)
  } catch (err) {
    const errMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    // Always surface real errors (the annotator/pipeline crashing must NOT be
    // silent). Only throttle the noisy corrupt-frame case to avoid flooding.
    const isCorruptFrame = errMsg.includes('SVG') || errMsg.includes('Invalid image')
    const now = Date.now()
    if (!isCorruptFrame || now - lastErrLog > 5000) {
      lastErrLog = now
      process.stderr.write(`[ai-worker:${cameraId}] frame error: ${errMsg}\n`)
    }
    // Always post back a result so the main thread resets workerBusy.
    // Without this, a single corrupt frame permanently locks the pipeline.
    const counts = counter.getCounts()
    parentPort!.postMessage({
      type: 'result',
      seq: msg.seq,
      boxes: [],
      counts: { ...counts, speeders },
      frameWidth: actualWidth,
      frameHeight: actualHeight,
      timing: { decodeMs: 0, canvasMs: 0, inferenceMs: 0, trackMs: 0, totalMs: 0 },
      recentTrapMeasurements: trapCalc?.getRecentMeasurements() ?? [],
    } satisfies WorkerResultMsg)
  }
})
