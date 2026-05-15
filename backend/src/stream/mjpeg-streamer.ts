import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { existsSync } from 'fs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { Detector } from '../ai/detector'
import { Tracker } from '../ai/tracker'
import { DirectionCounter } from '../analysis/counter'
import { SpeedCalculator } from '../analysis/speed'
import { emitFrame } from '../socket/server'
import { join } from 'path'

const MODEL_PATH = join(process.cwd(), 'models/yolov8s.onnx')

// HLS segments arrive in bursts; cap queue at ~20s worth of frames so memory
// stays bounded if a segment happens to be delivered faster than we dequeue.
const MAX_QUEUE = 500
const OUTPUT_FPS = 25

function resolveFfmpegPath(): string {
  if (process.platform === 'darwin') {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (existsSync(p)) return p
    }
  }
  return ffmpegStatic!
}

const CLASS_COLORS: Record<string, string> = {
  car: '#3b82f6',
  truck: '#f59e0b',
  bus: '#10b981',
  motorcycle: '#8b5cf6',
}

type Box = { id: number; class: string; speedKmh: number | null; x1: number; y1: number; x2: number; y2: number }

export class MJPEGStreamer extends EventEmitter {
  private ffmpegProc: ReturnType<typeof ffmpeg> | null = null
  private running = false

  private detector: Detector
  private tracker: Tracker
  private counter: DirectionCounter
  private speedCalc: SpeedCalculator | null

  private boxes: Box[] = []
  private counts = { AB: 0, BA: 0, speeders: 0 }
  private speeders = 0
  private countedSpeeders = new Set<number>()
  private frameIdx = 0
  private analysisRunning = false
  private actualWidth = 768
  private actualHeight = 576

  // Frame queue: ffmpeg delivers HLS frames in bursts; we dequeue at a fixed
  // rate so MJPEG output is smooth regardless of segment delivery timing.
  private frameQueue: Buffer[] = []
  private latestRawFrame: Buffer | null = null
  private dequeueTimer: ReturnType<typeof setInterval> | null = null

  // Video fps tracking (measures dequeue/display rate)
  private videoFpsCount = 0
  private videoFpsLastTime = Date.now()
  private videoFps = 0

  constructor(
    private readonly cameraId: string,
    private readonly streamUrl: string,
    private readonly lineA: number,
    private readonly lineB: number,
    private readonly maxSpeedKmh: number | null,
    private readonly homographyMatrix: number[] = [],
  ) {
    super()
    this.detector = new Detector(MODEL_PATH)
    this.tracker = new Tracker()
    this.counter = new DirectionCounter(576, lineA, lineB)
    this.speedCalc = homographyMatrix.length === 9
      ? new SpeedCalculator(homographyMatrix, OUTPUT_FPS, maxSpeedKmh ?? undefined)
      : null
  }

  async init(): Promise<void> {
    ffmpeg.setFfmpegPath(resolveFfmpegPath())
    await this.detector.init()
    console.log(`[mjpeg:${this.cameraId}] detector ready`)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.startDequeue()
    this.spawn()
  }

  stop(): void {
    this.running = false
    if (this.dequeueTimer) { clearInterval(this.dequeueTimer); this.dequeueTimer = null }
    this.frameQueue = []
    this.ffmpegProc?.kill('SIGTERM')
    this.ffmpegProc = null
  }

  isRunning(): boolean { return this.running }

  clientCount(): number { return this.listenerCount('frame') }

  // Dequeue one frame every 1/OUTPUT_FPS seconds. If the queue is empty
  // (between HLS segments), repeat the last frame so clients never freeze.
  private startDequeue(): void {
    this.dequeueTimer = setInterval(() => {
      const frame = this.frameQueue.shift() ?? this.latestRawFrame
      if (!frame) return
      this.latestRawFrame = frame

      this.videoFpsCount++
      const now = Date.now()
      if (now - this.videoFpsLastTime >= 1000) {
        this.videoFps = this.videoFpsCount
        this.videoFpsCount = 0
        this.videoFpsLastTime = now
      }

      this.onRawFrame(frame)
    }, 1000 / OUTPUT_FPS)
  }

  private spawn(): void {
    const pass = new PassThrough()

    const inputOpts = [
      // No -re: live HLS is already paced by the server; -re adds artificial
      // delays that stall at segment boundaries when source timing is uneven.
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
      .on('start', (cmd) => console.log(`[mjpeg:${this.cameraId}] ffmpeg: ${cmd}`))
      .on('error', (err: Error) => {
        if (!this.running) return
        console.error(`[mjpeg:${this.cameraId}] ffmpeg error: ${err.message}`)
        setTimeout(() => { if (this.running) this.spawn() }, 1000)
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

  private onRawFrame(jpeg: Buffer): void {
    this.frameIdx++

    // Run analysis on every frame the hardware can keep up with
    if (!this.analysisRunning) {
      this.analysisRunning = true
      this.analyse(jpeg).finally(() => { this.analysisRunning = false })
    }

    // Annotate and push to MJPEG clients
    this.annotate(jpeg).then((annotated) => this.emit('frame', annotated)).catch(() => this.emit('frame', jpeg))
  }

  private async analyse(jpeg: Buffer): Promise<void> {
    const img = await loadImage(jpeg)
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

    const lost = new Set(this.boxes.map((b) => b.id))
    for (const v of tracked) lost.delete(v.id)
    for (const id of lost) { this.speedCalc?.removeVehicle(id); this.countedSpeeders.delete(id) }

    for (const v of tracked) this.counter.updateVehicle(v.id, v.bcy)
    const counts = this.counter.getCounts()

    const boxes: Box[] = []
    for (const v of tracked) {
      let speedKmh: number | null = null
      if (this.speedCalc) {
        this.speedCalc.addPosition(v.id, v.bcx, v.bcy, Date.now())
        speedKmh = this.speedCalc.getSpeed(v.id)
        if (this.speedCalc.isSpeeder(v.id) && !this.countedSpeeders.has(v.id)) {
          this.countedSpeeders.add(v.id); this.speeders++
        }
      }
      boxes.push({ id: v.id, class: v.class, speedKmh, x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2 })
    }

    this.boxes = boxes
    this.counts = { ...counts, speeders: this.speeders }

    emitFrame({
      cameraId: this.cameraId,
      timestamp: Date.now(),
      vehicles: boxes.map((b) => ({ ...b, direction: null })),
      counts: this.counts,
      frameWidth: width,
      frameHeight: height,
      videoFps: this.videoFps,
    })
  }

  private async annotate(jpeg: Buffer): Promise<Buffer> {
    const img = await loadImage(jpeg)
    const { width, height } = img
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)

    const aY = this.lineA * height
    const bY = this.lineB * height
    ctx.strokeStyle = 'rgba(255,220,0,0.85)'
    ctx.lineWidth = 2
    ctx.setLineDash([10, 5])
    ctx.beginPath(); ctx.moveTo(0, aY); ctx.lineTo(width, aY); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, bY); ctx.lineTo(width, bY); ctx.stroke()
    ctx.setLineDash([])
    ctx.font = 'bold 11px monospace'
    ctx.fillStyle = 'rgba(255,220,0,0.9)'
    ctx.fillText('A', 4, aY - 3)
    ctx.fillText('B', 4, bY - 3)

    for (const v of this.boxes) {
      const color = CLASS_COLORS[v.class] ?? '#fff'
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.strokeRect(v.x1, v.y1, v.x2 - v.x1, v.y2 - v.y1)
      const label = v.speedKmh !== null ? `${v.class} ${Math.round(v.speedKmh)}km/h` : v.class
      ctx.font = '11px monospace'
      const tw = ctx.measureText(label).width + 6
      const ly = Math.max(14, v.y1)
      ctx.fillStyle = color
      ctx.fillRect(v.x1, ly - 14, tw, 14)
      ctx.fillStyle = '#000'
      ctx.fillText(label, v.x1 + 3, ly - 3)
    }

    return canvas.toBuffer('image/jpeg', 80)
  }

  async dispose(): Promise<void> {
    this.stop()
    this.tracker.reset()
    this.counter.reset()
    this.speedCalc = null
    this.countedSpeeders.clear()
  }

  resetDailyCounts(): void {
    this.counter.reset()
    this.speeders = 0
    this.countedSpeeders.clear()
  }
}
