import { db } from './db'
import { extractStreamUrl } from './stream/extractor'
import { FrameCapturer } from './stream/capturer'
import { emitFrame } from './socket/server'

type WorkerEntry = {
  capturer: FrameCapturer
  cameraId: string
}

export class CameraWorkerManager {
  private workers = new Map<string, WorkerEntry>()
  private pollInterval: ReturnType<typeof setInterval> | null = null

  async start(): Promise<void> {
    await this.syncWorkers()
    this.pollInterval = setInterval(() => this.syncWorkers(), 60_000)
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval)
    for (const { capturer } of this.workers.values()) capturer.stop()
    this.workers.clear()
  }

  private async syncWorkers(): Promise<void> {
    const cameras = await db.camera.findMany({ where: { active: true } })
    const activeIds = new Set(cameras.map((c) => c.id))

    for (const [id, worker] of this.workers) {
      if (!activeIds.has(id)) {
        worker.capturer.stop()
        this.workers.delete(id)
      }
    }

    for (const camera of cameras) {
      if (!this.workers.has(camera.id)) {
        this.startWorker(camera.id, camera.streamUrl)
      }
    }
  }

  private async startWorker(cameraId: string, pageUrl: string): Promise<void> {
    try {
      const streamUrl = await extractStreamUrl(pageUrl)
      const capturer = new FrameCapturer(streamUrl, cameraId)

      capturer.on('frame', (frameBuffer: Buffer) => {
        emitFrame({
          cameraId,
          frame: frameBuffer.toString('base64'),
          timestamp: Date.now(),
          vehicles: [],
          counts: { AB: 0, BA: 0, speeders: 0 },
        })
      })

      capturer.on('error', (err: Error) => {
        console.error(`Camera ${cameraId} stream error:`, err.message)
      })

      capturer.start()
      this.workers.set(cameraId, { capturer, cameraId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Failed to start worker for camera ${cameraId}: ${msg}`)
      setTimeout(() => this.startWorker(cameraId, pageUrl), 60_000)
    }
  }
}
