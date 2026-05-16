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
import { Tracker } from '../ai/tracker'
import { DirectionCounter } from '../analysis/counter'
import { SpeedCalculator } from '../analysis/speed'

// ---- types shared with main thread -----------------------------------------------

export type WorkerInitData = {
  cameraId: string
  lineA: number
  lineB: number
  maxSpeedKmh: number | null
  homographyMatrix: number[]
  outputFps: number
}

export type WorkerAnalyseMsg = {
  type: 'analyse'
  jpeg: Buffer
  frameTime: number
}

export type WorkerResetMsg = {
  type: 'reset-counts'
}

export type WorkerResultMsg = {
  type: 'result'
  boxes: Array<{ id: number; class: string; speedKmh: number | null; x1: number; y1: number; x2: number; y2: number }>
  counts: { AB: number; BA: number; speeders: number }
  frameWidth: number
  frameHeight: number
  annotatedJpeg: Buffer
  timing: { decodeMs: number; canvasMs: number; inferenceMs: number; trackMs: number; annotateMs: number; totalMs: number }
}

// ----------------------------------------------------------------------------------

const MODEL_PATH = join(process.cwd(), 'models/yolov8n.onnx')

const CLASS_COLORS: Record<string, string> = {
  car: '#3b82f6',
  truck: '#f59e0b',
  bus: '#10b981',
  motorcycle: '#8b5cf6',
}

const { cameraId, lineA, lineB, maxSpeedKmh, homographyMatrix, outputFps } = workerData as WorkerInitData

const detector = new Detector(MODEL_PATH)
const tracker = new Tracker()
let counter = new DirectionCounter(576, lineA, lineB)
const speedCalc = homographyMatrix.length === 9
  ? new SpeedCalculator(homographyMatrix, outputFps, maxSpeedKmh ?? undefined)
  : null

let actualWidth = 768
let actualHeight = 576
let speeders = 0
const countedSpeeders = new Set<number>()
let prevBoxIds = new Set<number>()

// Periodic timing summary — log to stderr every 100 frames so you can see per-stage costs
let frameCount = 0
const timingAccum = { decodeMs: 0, canvasMs: 0, inferenceMs: 0, trackMs: 0, annotateMs: 0, totalMs: 0 }

detector.init()
  .then(() => parentPort!.postMessage({ type: 'ready' }))
  .catch((err) => parentPort!.postMessage({ type: 'error', error: String(err) }))

parentPort!.on('message', async (msg: WorkerAnalyseMsg | WorkerResetMsg) => {
  if (msg.type === 'reset-counts') {
    counter.reset()
    speeders = 0
    countedSpeeders.clear()
    return
  }

  if (msg.type !== 'analyse') return

  const t0 = performance.now()

  try {
    const img = await loadImage(msg.jpeg)
    const { width, height } = img
    const t1 = performance.now()

    if (width !== actualWidth || height !== actualHeight) {
      counter = new DirectionCounter(height, lineA, lineB)
      actualWidth = width
      actualHeight = height
    }

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

    const tracked = tracker.update(detections)
    const currentIds = new Set(tracked.map((v) => v.id))

    // Clean up vehicles that disappeared
    for (const id of prevBoxIds) {
      if (!currentIds.has(id)) {
        speedCalc?.removeVehicle(id)
        countedSpeeders.delete(id)
      }
    }
    prevBoxIds = currentIds

    for (const v of tracked) counter.updateVehicle(v.id, v.bcy)
    const counts = counter.getCounts()

    const boxes: WorkerResultMsg['boxes'] = []
    for (const v of tracked) {
      let speedKmh: number | null = null
      if (speedCalc) {
        speedCalc.addPosition(v.id, v.bcx, v.bcy, msg.frameTime)
        speedKmh = speedCalc.getSpeed(v.id)
        if (speedCalc.isSpeeder(v.id) && !countedSpeeders.has(v.id)) {
          countedSpeeders.add(v.id)
          speeders++
        }
      }
      boxes.push({ id: v.id, class: v.class, speedKmh, x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2 })
    }

    const t4 = performance.now()

    // Annotate frame
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)

    const aY = lineA * height
    const bY = lineB * height
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

    for (const v of boxes) {
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

    // encode() runs on the libuv thread pool (non-blocking within this worker)
    const annotatedJpeg = await canvas.encode('jpeg', 80)
    const t5 = performance.now()

    const timing = {
      decodeMs: Math.round(t1 - t0),
      canvasMs: Math.round(t2 - t1),
      inferenceMs: Math.round(t3 - t2),
      trackMs: Math.round(t4 - t3),
      annotateMs: Math.round(t5 - t4),
      totalMs: Math.round(t5 - t0),
    }

    // Accumulate for periodic log
    frameCount++
    for (const k of Object.keys(timing) as (keyof typeof timing)[]) {
      timingAccum[k] += timing[k]
    }
    if (frameCount % 100 === 0) {
      const avg = Object.fromEntries(
        Object.entries(timingAccum).map(([k, v]) => [k, Math.round(v / 100)])
      )
      process.stderr.write(`[ai-worker:${cameraId}] avg over 100 frames: ${JSON.stringify(avg)}\n`)
      for (const k of Object.keys(timingAccum) as (keyof typeof timingAccum)[]) timingAccum[k] = 0
    }

    parentPort!.postMessage({
      type: 'result',
      boxes,
      counts: { ...counts, speeders },
      frameWidth: width,
      frameHeight: height,
      annotatedJpeg,
      timing,
    } satisfies WorkerResultMsg)
  } catch (err) {
    process.stderr.write(`[ai-worker:${cameraId}] error: ${err}\n`)
  }
})
