import { db } from './db'
import { extractStreamUrl } from './stream/extractor'
import { MJPEGStreamer } from './stream/mjpeg-streamer'
import { evictCameraFrame } from './socket/server'

const streamers = new Map<string, MJPEGStreamer>()

export function getStreamer(cameraId: string): MJPEGStreamer | undefined {
  return streamers.get(cameraId)
}

export class CameraWorkerManager {
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
    for (const streamer of streamers.values()) {
      streamer.dispose().catch(console.error)
    }
    streamers.clear()
  }

  private async syncWorkers(): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      const cameras = await db.camera.findMany({ where: { active: true } })
      const activeIds = new Set(cameras.map((c) => c.id))

      for (const [id, streamer] of streamers) {
        if (!activeIds.has(id)) {
          streamer.dispose().catch(console.error)
          evictCameraFrame(id)
          streamers.delete(id)
          const timer = this.retryTimers.get(id)
          if (timer) { clearTimeout(timer); this.retryTimers.delete(id) }
        }
      }

      for (const camera of cameras) {
        if (!streamers.has(camera.id) && !this.retryTimers.has(camera.id) && !this.starting.has(camera.id)) {
          this.startWorker(camera.id, camera.streamUrl)
        }
      }
    } finally {
      this.syncing = false
    }
  }

  private async startWorker(cameraId: string, pageUrl: string): Promise<void> {
    if (this.retryTimers.has(cameraId)) return
    this.starting.add(cameraId)
    try {
      const camera = await db.camera.findUniqueOrThrow({ where: { id: cameraId } })
      const streamUrl = await extractStreamUrl(pageUrl)

      const streamer = new MJPEGStreamer(
        cameraId,
        streamUrl,
        camera.countingLineA,
        camera.countingLineB,
        camera.maxSpeedKmh,
        (camera.homographyMatrix as number[] | null) ?? [],
      )
      await streamer.init()
      streamer.start()

      streamers.set(cameraId, streamer)
      this.starting.delete(cameraId)
      console.log(`[worker:${cameraId}] started`)
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
