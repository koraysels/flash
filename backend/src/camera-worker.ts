import { db } from './db'
import { extractStreamUrl } from './stream/extractor'
import { FrameCapturer } from './stream/capturer'
import { emitFrame, evictCameraFrame } from './socket/server'
import { CameraPipeline } from './ai/pipeline'

type WorkerEntry = {
  capturer: FrameCapturer
  cameraId: string
}

export class CameraWorkerManager {
  private workers = new Map<string, WorkerEntry>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private syncing = false

  async start(): Promise<void> {
    await this.syncWorkers()
    this.pollInterval = setInterval(() => this.syncWorkers(), 60_000)
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval)
    for (const { capturer } of this.workers.values()) capturer.stop()
    this.workers.clear()
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
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
          this.workers.delete(id)
          evictCameraFrame(id)
          const timer = this.retryTimers.get(id)
          if (timer) { clearTimeout(timer); this.retryTimers.delete(id) }
        }
      }

      for (const camera of cameras) {
        if (!this.workers.has(camera.id) && !this.retryTimers.has(camera.id)) {
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

    try {
      const camera = await db.camera.findUniqueOrThrow({ where: { id: cameraId } })
      const streamUrl = await extractStreamUrl(pageUrl)
      const capturer = new FrameCapturer(streamUrl, cameraId)

      const pipeline = new CameraPipeline(
        cameraId,
        1280,
        720,
        camera.countingLineA,
        camera.countingLineB,
        camera.maxSpeedKmh,
      )
      await pipeline.init()

      capturer.on('frame', async (frameBuffer: Buffer) => {
        try {
          const result = await pipeline.process(frameBuffer)
          emitFrame({
            cameraId,
            frame: result.annotatedFrame.toString('base64'),
            timestamp: Date.now(),
            vehicles: result.vehicles,
            counts: result.counts,
          })
        } catch (err) {
          console.error(`Pipeline error for camera ${cameraId}:`, err)
        }
      })

      capturer.on('error', (err: Error) => {
        console.error(`Camera ${cameraId} stream error:`, err.message)
      })

      capturer.start()
      this.workers.set(cameraId, { capturer, cameraId })
    } catch (err) {
      console.error(`Failed to start worker for camera ${cameraId}:`, err)
      const timer = setTimeout(() => {
        this.retryTimers.delete(cameraId)
        this.startWorker(cameraId, pageUrl)
      }, 60_000)
      this.retryTimers.set(cameraId, timer)
    }
  }
}
