import { db } from './db'
import { extractStreamUrl } from './stream/extractor'
import { MJPEGStreamer } from './stream/mjpeg-streamer'
import { evictCameraFrame } from './socket/server'

// Hard cap — each camera spawns an OS thread (AI worker) and a ffmpeg process.
// Beyond this number, resource contention (CoreML, network, memory) outweighs benefit.
const MAX_CAMERAS = 10

// Limit simultaneous ONNX model loads. Each load takes 3-10 s on macOS (CoreML
// compilation) and is CPU/memory intensive. Serialise to at most 2 at once.
const MAX_CONCURRENT_INITS = 2

const streamers = new Map<string, MJPEGStreamer>()

export function getStreamer(cameraId: string): MJPEGStreamer | undefined {
  return streamers.get(cameraId)
}

export class CameraWorkerManager {
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private syncing = false
  private starting = new Set<string>()
  private initSlots = 0   // number of cameras currently loading their ONNX model

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

      // Tear down streamers for cameras that were removed or deactivated
      for (const [id, streamer] of streamers) {
        if (!activeIds.has(id)) {
          streamer.dispose().catch(console.error)
          evictCameraFrame(id)
          streamers.delete(id)
          const timer = this.retryTimers.get(id)
          if (timer) { clearTimeout(timer); this.retryTimers.delete(id) }
        }
      }

      // Enforce camera cap — warn but don't kill already-running cameras
      if (cameras.length > MAX_CAMERAS) {
        console.warn(`[camera-manager] ${cameras.length} active cameras exceeds the recommended maximum of ${MAX_CAMERAS}. Performance may degrade.`)
      }

      for (const camera of cameras) {
        if (!streamers.has(camera.id) && !this.retryTimers.has(camera.id) && !this.starting.has(camera.id)) {
          this.startWorker(camera.id, camera.streamUrl)
        }
      }

      console.log(`[camera-manager] active: ${streamers.size} running, ${this.starting.size} starting, ${this.initSlots} init slots used`)
    } finally {
      this.syncing = false
    }
  }

  private async startWorker(cameraId: string, pageUrl: string): Promise<void> {
    if (this.retryTimers.has(cameraId) || this.starting.has(cameraId)) return

    // If all init slots are occupied, defer — the sync loop will pick this up next cycle
    // (or we schedule a retry so we don't wait a full 60 s)
    if (this.initSlots >= MAX_CONCURRENT_INITS) {
      const timer = setTimeout(() => {
        this.retryTimers.delete(cameraId)
        this.startWorker(cameraId, pageUrl)
      }, 15_000)
      this.retryTimers.set(cameraId, timer)
      console.log(`[worker:${cameraId}] init slots full (${this.initSlots}/${MAX_CONCURRENT_INITS}) — queued for 15 s`)
      return
    }

    this.starting.add(cameraId)
    this.initSlots++
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
      console.log(`[worker:${cameraId}] started (${streamers.size} total)`)
    } catch (err) {
      console.error(`Failed to start worker for camera ${cameraId}:`, err)
      const timer = setTimeout(() => {
        this.retryTimers.delete(cameraId)
        this.startWorker(cameraId, pageUrl)
      }, 60_000)
      this.retryTimers.set(cameraId, timer)
    } finally {
      this.starting.delete(cameraId)
      this.initSlots--
    }
  }
}
