import { Detector } from './detector'
import { Tracker, TrackedVehicle } from './tracker'
import { annotateFrame } from './annotator'
import { DirectionCounter } from '../analysis/counter'
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
  private initialized = false
  private speeders = 0

  constructor(
    private readonly cameraId: string,
    private readonly frameWidth: number,
    private readonly frameHeight: number,
    private readonly lineA: number,
    private readonly lineB: number,
    private readonly maxSpeedKmh: number | null,
  ) {
    this.detector = new Detector(MODEL_PATH)
    this.tracker = new Tracker()
    this.counter = new DirectionCounter(frameHeight, lineA, lineB)
  }

  async init(): Promise<void> {
    await this.detector.init()
    this.initialized = true
  }

  async process(jpegBuffer: Buffer): Promise<PipelineResult> {
    if (!this.initialized) throw new Error('Pipeline not initialized')

    const detections = await this.detector.detect(jpegBuffer, this.frameWidth, this.frameHeight)
    const tracked = this.tracker.update(detections)

    for (const v of tracked) {
      this.counter.updateVehicle(v.id, v.cy)
    }

    const counts = this.counter.getCounts()

    const vehicles: VehicleInfo[] = tracked.map((v) => ({
      id: v.id,
      class: v.class,
      speedKmh: null, // filled in Plan 4 after homography calibration
      direction: null as 'AB' | 'BA' | null,
    }))

    const annotatedFrame = await annotateFrame(jpegBuffer, tracked, this.lineA, this.lineB)

    return {
      annotatedFrame,
      vehicles,
      counts: { ...counts, speeders: this.speeders },
    }
  }

  resetDailyCounts(): void {
    this.counter.reset()
    this.speeders = 0
  }
}
