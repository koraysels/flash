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

let _manager: CameraWorkerManager | null = null

export function setManager(m: CameraWorkerManager): void { _manager = m }
export function getManager(): CameraWorkerManager | null { return _manager }

export class CameraWorkerManager {
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private syncing = false
  private starting = new Set<string>()
  private initSlots = 0   // number of cameras currently loading their ONNX model
  private initQueue: Array<{ cameraId: string; pageUrl: string }> = []

  async start(): Promise<void> {
    await this.syncWorkers()
    this.pollInterval = setInterval(() => this.syncWorkers(), 60_000)
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval)
    for (const [, timer] of this.retryTimers) clearTimeout(timer)
    this.retryTimers.clear()
    this.initQueue = []
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
          this.initQueue = this.initQueue.filter(q => q.cameraId !== id)
        }
      }

      // Enforce camera cap — warn but don't kill already-running cameras
      if (cameras.length > MAX_CAMERAS) {
        console.warn(`[camera-manager] ${cameras.length} active cameras exceeds the recommended maximum of ${MAX_CAMERAS}. Performance may degrade.`)
      }

      for (const camera of cameras) {
        const inInitQueue = this.initQueue.some(q => q.cameraId === camera.id)
        if (!streamers.has(camera.id) && !this.retryTimers.has(camera.id) && !this.starting.has(camera.id) && !inInitQueue) {
          void this.startWorker(camera.id, camera.streamUrl)
        }
      }

      console.log(`[camera-manager] active: ${streamers.size} running, ${this.starting.size} starting, ${this.initSlots} init slots used`)
    } catch (err) {
      console.error('[camera-manager] syncWorkers error:', err)
    } finally {
      this.syncing = false
    }
  }

  private async startWorker(cameraId: string, pageUrl: string): Promise<void> {
    if (this.retryTimers.has(cameraId) || this.starting.has(cameraId)) return

    // If all init slots are occupied, enqueue — drainInitQueue() will start it
    // as soon as another camera finishes loading its ONNX model.
    if (this.initSlots >= MAX_CONCURRENT_INITS) {
      if (!this.initQueue.some(q => q.cameraId === cameraId)) {
        this.initQueue.push({ cameraId, pageUrl })
        console.log(`[worker:${cameraId}] init slots full (${this.initSlots}/${MAX_CONCURRENT_INITS}) — queued`)
      }
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
        (camera.countingLineAPoints as number[] | null) ?? [],
        (camera.countingLineBPoints as number[] | null) ?? [],
        camera.trapSpeedEnabled,
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
      this.drainInitQueue()
    }
  }

  restartCamera(cameraId: string): void {
    const streamer = streamers.get(cameraId)
    if (streamer) {
      streamer.dispose().catch(console.error)
      evictCameraFrame(cameraId)
      streamers.delete(cameraId)
    }
    const timer = this.retryTimers.get(cameraId)
    if (timer) { clearTimeout(timer); this.retryTimers.delete(cameraId) }
    this.initQueue = this.initQueue.filter(q => q.cameraId !== cameraId)
    this.starting.delete(cameraId)
    void this.syncWorkers()
  }

  private drainInitQueue(): void {
    while (this.initSlots < MAX_CONCURRENT_INITS && this.initQueue.length > 0) {
      const next = this.initQueue.shift()!
      if (!streamers.has(next.cameraId) && !this.starting.has(next.cameraId)) {
        void this.startWorker(next.cameraId, next.pageUrl)
      }
    }
  }
}
