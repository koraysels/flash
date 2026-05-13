import { Detector } from './detector'
import { Tracker, TrackedVehicle } from './tracker'
import { annotateFrame } from './annotator'
import { DirectionCounter } from '../analysis/counter'
import { SpeedCalculator } from '../analysis/speed'
import { join } from 'path'

const MODEL_PATH = join(__dirname, '../../models/yolov8n.onnx')

export type VehicleInfo = {
  id: number
  class: string
  speedKmh: number | null
  direction: 'AB' | 'BA' | null
}

export type PipelineResult = {
  annotatedFrame: Buffer
  vehicles: VehicleInfo[]
  counts: { AB: number; BA: number; speeders: number }
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

  constructor(
    private readonly cameraId: string,
    private readonly frameWidth: number,
    private readonly frameHeight: number,
    private readonly lineA: number,
    private readonly lineB: number,
    private readonly maxSpeedKmh: number | null,
    private readonly homographyMatrix: number[] = [],
    private readonly fps: number = 2,
  ) {
    this.detector = new Detector(MODEL_PATH)
    this.tracker = new Tracker()
    this.counter = new DirectionCounter(frameHeight, lineA, lineB)
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

    const detections = await this.detector.detect(jpegBuffer, this.frameWidth, this.frameHeight)
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
      this.counter.updateVehicle(v.id, v.cy)
    }

    const counts = this.counter.getCounts()

    const vehicles: VehicleInfo[] = tracked.map((v) => {
      let speedKmh: number | null = null

      if (this.speedCalc) {
        this.speedCalc.addPosition(v.id, v.cx, v.cy, Date.now())
        speedKmh = this.speedCalc.getSpeed(v.id)
        if (this.speedCalc.isSpeeder(v.id) && !this.countedSpeeders.has(v.id)) {
          this.countedSpeeders.add(v.id)
          this.speeders++
        }
      }

      return { id: v.id, class: v.class, speedKmh, direction: null as 'AB' | 'BA' | null }
    })

    const annotatedFrame = await annotateFrame(jpegBuffer, tracked, this.lineA, this.lineB)

    return {
      annotatedFrame,
      vehicles,
      counts: { ...counts, speeders: this.speeders },
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
