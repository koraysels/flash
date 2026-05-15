import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { existsSync } from 'fs'

// On macOS, ffmpeg-static binaries fail Gatekeeper validation (SIGKILL on exec).
// Prefer system Homebrew ffmpeg when available.
function resolveFfmpegPath(): string {
  if (process.platform === 'darwin') {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (existsSync(p)) return p
    }
  }
  return ffmpegStatic!
}

const resolvedFfmpegPath = resolveFfmpegPath()
console.log(`[capturer] Using ffmpeg: ${resolvedFfmpegPath}`)
ffmpeg.setFfmpegPath(resolvedFfmpegPath)

export class FrameCapturer extends EventEmitter {
  private process: ReturnType<typeof ffmpeg> | null = null
  private running = false

  constructor(
    private readonly streamUrl: string,
    private readonly cameraId: string,
    private readonly fps = 2,
  ) {
    super()
  }

  private buildInputOptions(): string[] {
    const opts = [
      '-fflags', 'nobuffer',       // minimize buffering for live streams
      '-flags', 'low_delay',       // low latency mode
      '-timeout', '10000000',      // 10s connection timeout (µs)
    ]
    if (this.streamUrl.includes('hls.media.verkeerscentrum.be')) {
      // verkeerscentrum.be checks Referer AND blocks non-browser user-agents (e.g. Lavf/*)
      opts.push('-headers', 'Referer: https://www.verkeerscentrum.be/\r\nUser-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n')
    }
    return opts
  }

  start(): void {
    if (this.running) return
    this.running = true

    const passThrough = new PassThrough()

    this.process = ffmpeg(this.streamUrl)
      .inputOptions(this.buildInputOptions())
      .outputOptions([
        `-vf fps=${this.fps}`,
        '-f image2pipe',
        '-vcodec mjpeg',
        '-q:v 5',
      ])
      .output(passThrough as unknown as string)
      .on('start', (cmd: string) => {
        console.log(`[camera:${this.cameraId}] ffmpeg started`)
        console.log(`[camera:${this.cameraId}] cmd: ${cmd}`)
      })
      .on('error', (err: Error) => {
        console.error(`[camera:${this.cameraId}] ffmpeg error: ${err.message}`)
        if (this.running) {
          this.emit('error', err)
          setTimeout(() => {
            if (this.running) this.start()
          }, 5000)
        }
      })

    const SOI = Buffer.from([0xff, 0xd8])
    const EOI = Buffer.from([0xff, 0xd9])
    let buf = Buffer.alloc(0)

    passThrough.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      while (true) {
        const start = buf.indexOf(SOI)
        if (start === -1) { buf = Buffer.alloc(0); break }
        const end = buf.indexOf(EOI, start + 2)
        if (end === -1) { buf = start > 0 ? buf.slice(start) : buf; break }
        this.emit('frame', buf.slice(start, end + 2))
        buf = buf.slice(end + 2)
      }
    })

    this.process.run()
  }

  stop(): void {
    this.running = false
    this.process?.kill('SIGTERM')
    this.process = null
  }



  isRunning(): boolean {
    return this.running
  }
}
