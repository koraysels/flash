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
import { applyHomography } from '../analysis/homography'

// ---- types shared with main thread -----------------------------------------------

export type WorkerInitData = {
  cameraId: string
  lineA: number
  lineB: number
  lineAPoints: number[]
  lineBPoints: number[]
  maxSpeedKmh: number | null
  homographyMatrix: number[]
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

const { cameraId, lineA, lineB, lineAPoints, lineBPoints, maxSpeedKmh, homographyMatrix, trapSpeedEnabled, trackingConfig: rawTrackingConfig } = workerData as WorkerInitData
const trackingConfig: TrackerConfig = { ...DEFAULT_TRACKER_CONFIG, ...rawTrackingConfig }

const detector = new Detector(MODEL_PATH)
const tracker = new Tracker(trackingConfig)
let counter = new DirectionCounter(576, lineA, lineB, lineAPoints, lineBPoints)
const speedCalc = !trapSpeedEnabled && homographyMatrix.length === 9
  ? new SpeedCalculator(homographyMatrix, maxSpeedKmh ?? undefined, trackingConfig.speedPlausibilityKmh)
  : null

// Trap speed calculator — created lazily after first frame when frame dimensions are known
let trapCalc: TrapSpeedCalculator | null = null

let actualWidth = 768
let actualHeight = 576
let speeders = 0
const countedSpeeders = new Set<number>()   // IDs already counted (never reset until reset-counts)
const vehicleZoneSpeed = new Map<number, number>()  // max speed seen while in zone per vehicle (continuous mode only)
let prevBoxIds = new Set<number>()

function initTrapCalc(): void {
  if (!trapSpeedEnabled || homographyMatrix.length !== 9) return
  // Project the center of each counting line to world coordinates and measure the distance
  const midX = (pts: number[], fallbackNx: number) =>
    pts.length === 4 ? ((pts[0] + pts[2]) / 2) * actualWidth : fallbackNx * actualWidth
  const midY = (pts: number[], fallbackNy: number) =>
    pts.length === 4 ? ((pts[1] + pts[3]) / 2) * actualHeight : fallbackNy * actualHeight

  const wA = applyHomography(homographyMatrix, midX(lineAPoints, 0.5), midY(lineAPoints, lineA))
  const wB = applyHomography(homographyMatrix, midX(lineBPoints, 0.5), midY(lineBPoints, lineB))
  const dx = wB.wx - wA.wx
  const dy = wB.wy - wA.wy
  const distM = Math.sqrt(dx * dx + dy * dy)
  if (distM > 0) {
    trapCalc = new TrapSpeedCalculator(distM, maxSpeedKmh ?? undefined, trackingConfig.speedPlausibilityKmh)
    process.stderr.write(`[ai-worker:${cameraId}] trap speed enabled, line distance = ${distM.toFixed(2)}m\n`)
  }
}

// Periodic timing summary — log to stderr every 100 frames so you can see per-stage costs
let frameCount = 0

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
      trapCalc = null  // recompute distance for new dimensions
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
    ctx640.fillStyle = '#808080'
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

    for (const v of tracked) counter.updateVehicle(v.id, v.bcx / actualWidth, v.bcy / actualHeight)
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
        trapCalc.update(v.id, ny, lineAY, lineBY, msg.frameTime)
        speedKmh = trapCalc.getSpeed(v.id)
        if (speedKmh !== null && !countedSpeeders.has(v.id)) {
          countedSpeeders.add(v.id)
          if (maxSpeedKmh !== null && speedKmh > maxSpeedKmh) speeders++
        }
      } else if (speedCalc) {
        // Continuous mode: EMA-smoothed homography speed with zone-based speeder detection
        speedCalc.addPosition(v.id, v.bcx, v.bcy, msg.frameTime)
        speedKmh = speedCalc.getSpeed(v.id)
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
    process.stderr.write(`[ai-worker:${cameraId}] error: ${err}\n`)
  }
})
