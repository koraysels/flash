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

export type WorkerResultMsg = {
  type: 'result'
  seq: number
  boxes: Array<{ id: number; class: string; speedKmh: number | null; x1: number; y1: number; x2: number; y2: number }>
  counts: { AB: number; BA: number; speeders: number }
  frameWidth: number
  frameHeight: number
  timing: { decodeMs: number; canvasMs: number; inferenceMs: number; trackMs: number; totalMs: number }
  recentTrapMeasurements: TrapMeasurement[]
}

// ----------------------------------------------------------------------------------

const MODEL_PATH = join(process.cwd(), 'models/traffic_detector.onnx')

const { cameraId, lineA, lineB, lineAPoints, lineBPoints, maxSpeedKmh, homographyMatrix, calibrationWidth, calibrationHeight, trapSpeedEnabled, trackingConfig: rawTrackingConfig } = workerData as WorkerInitData
const trackingConfig: TrackerConfig = { ...DEFAULT_TRACKER_CONFIG, ...rawTrackingConfig }

const detector = new Detector(MODEL_PATH)
const tracker = new Tracker(trackingConfig)
let counter = new DirectionCounter(576, lineA, lineB, lineAPoints, lineBPoints)
let speedCalc: SpeedCalculator | null = null

// Trap speed calculator — created lazily after first frame when frame dimensions are known
let trapCalc: TrapSpeedCalculator | null = null

let actualWidth = 768
let actualHeight = 576
let speeders = 0
const countedSpeeders = new Set<number>()   // IDs already counted (never reset until reset-counts)
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

parentPort!.on('message', async (msg: WorkerAnalyseMsg | WorkerResetMsg) => {
  if (msg.type === 'reset-counts') {
    counter.reset()
    speeders = 0
    countedSpeeders.clear()
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

    const detections = await detector.detect(rgba640, padX, padY, scale, width, height)
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
    for (const v of tracked) {
      const nx = v.bcx / actualWidth
      const ny = v.bcy / actualHeight
      const lineAY = lineYAtX(lineAPoints, nx, lineA)
      const lineBY = lineYAtX(lineBPoints, nx, lineB)
      let speedKmh: number | null = null

      if (trapCalc) {
        // Trap mode: time between line A and B crossings — speed locked in after both crossed
        if (!v.isPredicted) trapCalc.update(v.id, v.bcx, v.bcy, ny, lineAY, lineBY, msg.frameTime)
        speedKmh = trapCalc.getSpeed(v.id)
        if (speedKmh !== null && !countedSpeeders.has(v.id)) {
          countedSpeeders.add(v.id)
          if (maxSpeedKmh !== null && speedKmh > maxSpeedKmh) speeders++
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
              speeders++
            }
            vehicleZoneSpeed.delete(v.id)
          }
        }
      }

      boxes.push({ id: v.id, class: v.class, speedKmh, x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2 })
    }

    const t4 = performance.now()

    const timing = {
      decodeMs: Math.round(t1 - t0),
      canvasMs: Math.round(t2 - t1),
      inferenceMs: Math.round(t3 - t2),
      trackMs: Math.round(t4 - t3),
      totalMs: Math.round(t4 - t0),
    }

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

    parentPort!.postMessage({
      type: 'result',
      seq: msg.seq,
      boxes,
      counts: { ...counts, speeders },
      frameWidth: width,
      frameHeight: height,
      timing,
      recentTrapMeasurements: trapCalc?.getRecentMeasurements() ?? [],
    } satisfies WorkerResultMsg)
  } catch (err) {
    const errMsg = String(err)
    // Corrupt/non-JPEG frames from the stream are silently skipped
    if (!errMsg.includes('SVG') && !errMsg.includes('Invalid image')) {
      process.stderr.write(`[ai-worker:${cameraId}] error: ${errMsg}\n`)
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
