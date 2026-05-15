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

const MODEL_PATH = join(process.cwd(), 'models/yolov8n.onnx')

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

// Run YOLO every N frames — keeps analysis at ~5fps when source is ~25fps
const ANALYSIS_STRIDE = 5

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
      ? new SpeedCalculator(homographyMatrix, 25, maxSpeedKmh ?? undefined)
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
    this.spawn()
  }

  stop(): void {
    this.running = false
    this.ffmpegProc?.kill('SIGTERM')
    this.ffmpegProc = null
  }

  isRunning(): boolean { return this.running }

  /** Number of active frame listeners (= connected MJPEG clients) */
  clientCount(): number { return this.listenerCount('frame') }

  private spawn(): void {
    const pass = new PassThrough()

    const inputOpts = [
      '-re',                  // read at native frame rate — gives smooth 25fps output instead of burst
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
        '-q:v', '4',         // JPEG quality (1=best, 31=worst)
        // No -vf fps filter → full source frame rate via -re
      ])
      .output(pass as unknown as string)
      .on('start', (cmd) => console.log(`[mjpeg:${this.cameraId}] ffmpeg: ${cmd}`))
      .on('error', (err: Error) => {
        if (!this.running) return
        console.error(`[mjpeg:${this.cameraId}] ffmpeg error: ${err.message}`)
        setTimeout(() => { if (this.running) this.spawn() }, 5000)
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
        this.onRawFrame(frame)
      }
    })

    this.ffmpegProc.run()
  }

  private onRawFrame(jpeg: Buffer): void {
    this.frameIdx++

    // Kick off analysis asynchronously — never blocks the frame loop
    if (this.frameIdx % ANALYSIS_STRIDE === 0 && !this.analysisRunning) {
      this.analysisRunning = true
      this.analyse(jpeg).finally(() => { this.analysisRunning = false })
    }

    // Annotate and push to MJPEG clients (fire-and-forget)
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

    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const rgba = ctx.getImageData(0, 0, width, height).data
    const rgb = Buffer.allocUnsafe(width * height * 3)
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]
    }

    const detections = await this.detector.detect(rgb, width, height)
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
    })
  }

  private async annotate(jpeg: Buffer): Promise<Buffer> {
    const img = await loadImage(jpeg)
    const { width, height } = img
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)

    // Counting lines
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

    // Vehicle boxes with latest known detections
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
