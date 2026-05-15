import { createCanvas, loadImage } from '@napi-rs/canvas'
import { Detector } from './detector'
import { Tracker } from './tracker'
import { DirectionCounter } from '../analysis/counter'
import { SpeedCalculator } from '../analysis/speed'
import { join } from 'path'

const MODEL_PATH = join(process.cwd(), 'models/yolov8n.onnx')

export type VehicleInfo = {
  id: number
  class: string
  speedKmh: number | null
  direction: 'AB' | 'BA' | null
  x1: number
  y1: number
  x2: number
  y2: number
}

export type PipelineResult = {
  vehicles: VehicleInfo[]
  counts: { AB: number; BA: number; speeders: number }
  frameWidth: number
  frameHeight: number
}

export class CameraPipeline {
  private detector: Detector
  private tracker: Tracker
  private counter: DirectionCounter
  private speedCalc: SpeedCalculator | null = null
  private initialized = false
  private speeders = 0
  private countedSpeeders = new Set<number>()
  private activeVehicleIds = new Set<number>()
  private actualWidth: number
  private actualHeight: number

  constructor(
    private readonly cameraId: string,
    initialWidth: number,
    initialHeight: number,
    private readonly lineA: number,
    private readonly lineB: number,
    private readonly maxSpeedKmh: number | null,
    private readonly homographyMatrix: number[] = [],
    private readonly fps: number = 2,
  ) {
    this.actualWidth = initialWidth
    this.actualHeight = initialHeight
    this.detector = new Detector(MODEL_PATH)
    this.tracker = new Tracker()
    this.counter = new DirectionCounter(initialHeight, lineA, lineB)
    if (homographyMatrix.length === 9) {
      this.speedCalc = new SpeedCalculator(homographyMatrix, fps, maxSpeedKmh ?? undefined)
    }
  }

  async init(): Promise<void> {
    await this.detector.init()
    this.initialized = true
  }

  async process(jpegBuffer: Buffer): Promise<PipelineResult> {
    if (!this.initialized) throw new Error('Pipeline not initialized')

    // Decode JPEG → raw RGB pixels (detector.preprocess() reads raw RGB, not JPEG bytes)
    const img = await loadImage(jpegBuffer)
    const { width, height } = img
    if (height !== this.actualHeight) {
      this.counter = new DirectionCounter(height, this.lineA, this.lineB)
      this.actualWidth = width
      this.actualHeight = height
    }

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

    const detections = await this.detector.detect(rgba640, padX, padY, scale, width, height)
    const tracked = this.tracker.update(detections)

    const trackedIds = new Set(tracked.map((v) => v.id))

    // Clean up dropped vehicles
    for (const id of this.activeVehicleIds) {
      if (!trackedIds.has(id)) {
        if (this.speedCalc) this.speedCalc.removeVehicle(id)
        this.countedSpeeders.delete(id)
      }
    }
    this.activeVehicleIds = trackedIds

    for (const v of tracked) {
      // Use bottom-center y for counting — ground contact point crosses line more accurately
      this.counter.updateVehicle(v.id, v.bcy)
    }

    const counts = this.counter.getCounts()

    const vehicles: VehicleInfo[] = tracked.map((v) => {
      let speedKmh: number | null = null

      if (this.speedCalc) {
        // Bottom-center projects correctly through homography (calibrated to ground plane)
        this.speedCalc.addPosition(v.id, v.bcx, v.bcy, Date.now())
        speedKmh = this.speedCalc.getSpeed(v.id)
        if (this.speedCalc.isSpeeder(v.id) && !this.countedSpeeders.has(v.id)) {
          this.countedSpeeders.add(v.id)
          this.speeders++
        }
      }

      return { id: v.id, class: v.class, speedKmh, direction: null as 'AB' | 'BA' | null, x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2 }
    })

    return {
      vehicles,
      counts: { ...counts, speeders: this.speeders },
      frameWidth: width,
      frameHeight: height,
    }
  }

  async dispose(): Promise<void> {
    await this.detector.dispose()
    this.tracker.reset()
    this.counter.reset()
    this.speedCalc = null
    this.initialized = false
    this.countedSpeeders.clear()
    this.activeVehicleIds.clear()
  }

  resetDailyCounts(): void {
    this.counter.reset()
    this.speeders = 0
    this.countedSpeeders.clear()
  }
}
