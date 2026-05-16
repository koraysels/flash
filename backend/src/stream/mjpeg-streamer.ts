import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { existsSync } from 'fs'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { emitFrame } from '../socket/server'
import type { WorkerInitData, WorkerResultMsg } from './ai-worker'

// With -re, frames arrive at ~source fps (~25) and drain at OUTPUT_FPS (17).
// Net accumulation ~8 fps; queue fills after ~2 s. Cap at 2 s to limit latency.
const MAX_QUEUE = 34   // ~2 s at OUTPUT_FPS
const OUTPUT_FPS = 17

function resolveFfmpegPath(): string {
  if (process.platform === 'darwin') {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (existsSync(p)) return p
    }
  }
  return ffmpegStatic!
}

type Box = { id: number; class: string; speedKmh: number | null; x1: number; y1: number; x2: number; y2: number }

export class MJPEGStreamer extends EventEmitter {
  private ffmpegProc: ReturnType<typeof ffmpeg> | null = null
  private running = false

  // AI worker — owns the full pipeline (decode + ONNX + track + annotate)
  private aiWorker: Worker | null = null
  private workerBusy = false
  private workerReady = false

  // Latest state published by the worker
  private boxes: Box[] = []
  private counts = { AB: 0, BA: 0, speeders: 0 }
  private lastFrameWidth = 768
  private lastFrameHeight = 576
  // Latest raw frame as base64 — kept for the snapshot endpoint
  private latestRawBase64: string | null = null

  private frameIdx = 0

  // Frame queue: ffmpeg delivers HLS frames in bursts; we dequeue at a fixed
  // rate so MJPEG output is smooth regardless of segment delivery timing.
  private frameQueue: Buffer[] = []
  private latestRawFrame: Buffer | null = null
  private dequeueTimer: ReturnType<typeof setTimeout> | null = null

  // Video fps tracking (measures dequeue/display rate)
  private videoFpsCount = 0
  private videoFpsLastTime = Date.now()
  private videoFps = 0

  // Restart backoff: quick first retry, then exponential up to 30 s
  private retryCount = 0
  private spawnedAt = 0
  private static readonly RETRY_DELAYS = [0, 500, 2_000, 5_000, 15_000, 30_000]

  constructor(
    private readonly cameraId: string,
    private readonly streamUrl: string,
    private readonly lineA: number,
    private readonly lineB: number,
    private readonly maxSpeedKmh: number | null,
    private readonly homographyMatrix: number[] = [],
  ) {
    super()
  }

  async init(): Promise<void> {
    ffmpeg.setFfmpegPath(resolveFfmpegPath())
    await this.spawnWorker()
    console.log(`[mjpeg:${this.cameraId}] ai worker ready`)
  }

  private spawnWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      const initData: WorkerInitData = {
        cameraId: this.cameraId,
        lineA: this.lineA,
        lineB: this.lineB,
        maxSpeedKmh: this.maxSpeedKmh,
        homographyMatrix: this.homographyMatrix,
        outputFps: OUTPUT_FPS,
      }

      // tsx/cjs registers the CommonJS TypeScript hook, enabling extensionless
      // TypeScript imports (e.g. '../ai/detector') inside the worker process.
      this.aiWorker = new Worker(join(__dirname, 'ai-worker.ts'), {
        execArgv: ['--require', 'tsx/cjs'],
        workerData: initData,
      })

      this.aiWorker.on('message', (msg: WorkerResultMsg | { type: 'ready' } | { type: 'error'; error: string }) => {
        if (msg.type === 'ready') {
          this.workerReady = true
          resolve()
          return
        }

        if (msg.type === 'error') {
          if (!this.workerReady) reject(new Error(msg.error))
          else console.error(`[mjpeg:${this.cameraId}] worker error: ${msg.error}`)
          return
        }

        if (msg.type === 'result') {
          this.workerBusy = false
          this.boxes = msg.boxes
          this.counts = msg.counts
          this.lastFrameWidth = msg.frameWidth
          this.lastFrameHeight = msg.frameHeight

          emitFrame({
            cameraId: this.cameraId,
            timestamp: Date.now(),
            vehicles: msg.boxes.map((b) => ({ ...b, direction: null })),
            counts: msg.counts,
            frameWidth: msg.frameWidth,
            frameHeight: msg.frameHeight,
            videoFps: this.videoFps,
            timing: msg.timing,
          }, this.latestRawBase64 ?? undefined)
        }
      })

      this.aiWorker.on('error', (err) => {
        console.error(`[mjpeg:${this.cameraId}] worker crashed: ${err.message}`)
        this.workerBusy = false
        if (!this.workerReady) reject(err)
      })

      this.aiWorker.on('exit', (code) => {
        if (!this.running) return
        console.warn(`[mjpeg:${this.cameraId}] worker exited (code ${code}) — restarting`)
        this.workerBusy = false
        this.workerReady = false
        // Restart the worker after a brief delay
        setTimeout(() => {
          if (this.running) this.spawnWorker().catch((err) => console.error(`[mjpeg:${this.cameraId}] worker restart failed: ${err}`))
        }, 1_000)
      })
    })
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.startDequeue()
    this.spawn()
  }

  stop(): void {
    this.running = false
    if (this.dequeueTimer) { clearTimeout(this.dequeueTimer); this.dequeueTimer = null }
    this.frameQueue = []
    this.latestRawBase64 = null
    this.ffmpegProc?.kill('SIGTERM')
    this.ffmpegProc = null
    this.aiWorker?.terminate()
    this.aiWorker = null
    this.workerReady = false
    this.workerBusy = false
  }

  isRunning(): boolean { return this.running }

  clientCount(): number { return this.listenerCount('frame') }

  // Dequeue one frame every 1/OUTPUT_FPS seconds using a self-correcting timer.
  // Each tick schedules the next one relative to an absolute target timestamp so
  // accumulated jitter from late wakeups is continuously corrected.
  private startDequeue(): void {
    const intervalMs = 1000 / OUTPUT_FPS
    let nextTarget = Date.now() + intervalMs

    const tick = () => {
      const frameTime = Date.now()
      const isNewFrame = this.frameQueue.length > 0
      const frame = this.frameQueue.shift() ?? this.latestRawFrame
      if (frame) {
        this.latestRawFrame = frame
        this.videoFpsCount++
        if (frameTime - this.videoFpsLastTime >= 1000) {
          this.videoFps = this.videoFpsCount
          this.videoFpsCount = 0
          this.videoFpsLastTime = frameTime
        }
        this.onRawFrame(frame, isNewFrame, frameTime)
      }
      if (!this.running) return
      nextTarget += intervalMs
      this.dequeueTimer = setTimeout(tick, Math.max(0, nextTarget - Date.now()))
    }

    this.dequeueTimer = setTimeout(tick, intervalMs)
  }

  private spawn(): void {
    const pass = new PassThrough()

    const inputOpts = [
      '-re',           // Read at native frame rate. Without this, ffmpeg decodes a 9-second
                       // HLS segment in ~0.5s, flooding the queue with 200+ frames in a burst.
                       // The queue overflows, old frames are dropped, and playback appears at
                       // wrong speed. -re paces output to real-time, fixing both visual speed
                       // and frameTime accuracy for the speed calculator.
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-timeout', '10000000',
    ]
    if (this.streamUrl.includes('hls.media.verkeerscentrum.be')) {
      inputOpts.push('-headers',
        'Referer: https://www.verkeerscentrum.be/\r\n' +
        'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n'
      )
    }

    this.ffmpegProc = ffmpeg(this.streamUrl)
      .inputOptions(inputOpts)
      .outputOptions([
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '4',
      ])
      .output(pass as unknown as string)
      .on('start', (cmd) => {
        this.spawnedAt = Date.now()
        console.log(`[mjpeg:${this.cameraId}] ffmpeg: ${cmd}`)
      })
      .on('error', (err: Error) => {
        if (!this.running) return
        if (Date.now() - this.spawnedAt > 10_000) this.retryCount = 0
        const delay = MJPEGStreamer.RETRY_DELAYS[Math.min(this.retryCount, MJPEGStreamer.RETRY_DELAYS.length - 1)]
        this.retryCount++
        console.error(`[mjpeg:${this.cameraId}] error (retry #${this.retryCount} in ${delay} ms): ${err.message}`)
        setTimeout(() => { if (this.running) this.spawn() }, delay)
      })
      .on('end', () => {
        if (!this.running) return
        // Live HLS stream ended unexpectedly — restart
        const delay = MJPEGStreamer.RETRY_DELAYS[Math.min(this.retryCount, MJPEGStreamer.RETRY_DELAYS.length - 1)]
        this.retryCount++
        console.warn(`[mjpeg:${this.cameraId}] stream ended (retry #${this.retryCount} in ${delay} ms)`)
        setTimeout(() => { if (this.running) this.spawn() }, delay)
      })

    const SOI = Buffer.from([0xff, 0xd8])
    const EOI = Buffer.from([0xff, 0xd9])
    let buf = Buffer.alloc(0)

    pass.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      while (true) {
        const s = buf.indexOf(SOI)
        if (s === -1) { buf = Buffer.alloc(0); break }
        const e = buf.indexOf(EOI, s + 2)
        if (e === -1) { buf = s > 0 ? buf.slice(s) : buf; break }
        const frame = buf.slice(s, e + 2)
        buf = buf.slice(e + 2)
        // Push into queue; if we're at the cap, drop the oldest frame
        if (this.frameQueue.length >= MAX_QUEUE) this.frameQueue.shift()
        this.frameQueue.push(frame)
      }
    })

    this.ffmpegProc.run()
  }

  private onRawFrame(jpeg: Buffer, isNewFrame: boolean, frameTime: number): void {
    this.frameIdx++
    // Emit raw frame for the MJPEG debug endpoint; store base64 for the snapshot endpoint.
    this.latestRawBase64 = jpeg.toString('base64')
    this.emit('frame', jpeg)

    if (isNewFrame && this.workerReady && !this.workerBusy) {
      this.workerBusy = true
      this.aiWorker!.postMessage({ type: 'analyse', jpeg, frameTime })
    }
  }

  async dispose(): Promise<void> {
    this.stop()
  }

  resetDailyCounts(): void {
    this.aiWorker?.postMessage({ type: 'reset-counts' })
  }
}
