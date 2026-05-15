import { db } from './db'
import { extractStreamUrl } from './stream/extractor'
import { FrameCapturer } from './stream/capturer'
import { emitFrame, evictCameraFrame } from './socket/server'
import { CameraPipeline } from './ai/pipeline'

type WorkerEntry = {
  capturer: FrameCapturer
  pipeline: CameraPipeline
  cameraId: string
}

export class CameraWorkerManager {
  private workers = new Map<string, WorkerEntry>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private syncing = false
  private starting = new Set<string>()

  async start(): Promise<void> {
    await this.syncWorkers()
    this.pollInterval = setInterval(() => this.syncWorkers(), 60_000)
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval)
    for (const [, timer] of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    for (const { capturer, pipeline } of this.workers.values()) {
      capturer.stop()
      pipeline.dispose().catch(console.error)
    }
    this.workers.clear()
  }

  private async syncWorkers(): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      const cameras = await db.camera.findMany({ where: { active: true } })
      const activeIds = new Set(cameras.map((c) => c.id))

      for (const [id, worker] of this.workers) {
        if (!activeIds.has(id)) {
          worker.capturer.stop()
          worker.pipeline.dispose().catch(console.error)
          evictCameraFrame(id)
          this.workers.delete(id)
          const timer = this.retryTimers.get(id)
          if (timer) { clearTimeout(timer); this.retryTimers.delete(id) }
        }
      }

      for (const camera of cameras) {
        if (!this.workers.has(camera.id) && !this.retryTimers.has(camera.id) && !this.starting.has(camera.id)) {
          this.startWorker(camera.id, camera.streamUrl)
        }
      }
    } finally {
      this.syncing = false
    }
  }

  private async startWorker(cameraId: string, pageUrl: string): Promise<void> {
    // Don't retry if already has a pending retry timer
    if (this.retryTimers.has(cameraId)) return

    this.starting.add(cameraId)
    try {
      const camera = await db.camera.findUniqueOrThrow({ where: { id: cameraId } })
      const streamUrl = await extractStreamUrl(pageUrl)
      const fps = 5
      const capturer = new FrameCapturer(streamUrl, cameraId, fps)

      const pipeline = new CameraPipeline(
        cameraId,
        1280,
        720,
        camera.countingLineA,
        camera.countingLineB,
        camera.maxSpeedKmh,
        camera.homographyMatrix,
        fps,
      )
      await pipeline.init()

      capturer.on('frame', async (frameBuffer: Buffer) => {
        try {
          const result = await pipeline.process(frameBuffer)
          emitFrame({
            cameraId,
            timestamp: Date.now(),
            vehicles: result.vehicles,
            counts: result.counts,
            frameWidth: result.frameWidth,
            frameHeight: result.frameHeight,
          }, frameBuffer.toString('base64'))
        } catch (err) {
          console.error(`Pipeline error for camera ${cameraId}:`, err)
        }
      })

      capturer.on('error', (err: Error) => {
        console.error(`Camera ${cameraId} stream error:`, err.message)
      })

      capturer.start()
      this.workers.set(cameraId, { capturer, pipeline, cameraId })
      this.starting.delete(cameraId)
    } catch (err) {
      this.starting.delete(cameraId)
      console.error(`Failed to start worker for camera ${cameraId}:`, err)
      const timer = setTimeout(() => {
        this.retryTimers.delete(cameraId)
        this.startWorker(cameraId, pageUrl)
      }, 60_000)
      this.retryTimers.set(cameraId, timer)
    }
  }
}
