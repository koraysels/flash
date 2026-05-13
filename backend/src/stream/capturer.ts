import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

ffmpeg.setFfmpegPath(ffmpegStatic!)

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

  start(): void {
    if (this.running) return
    this.running = true

    const passThrough = new PassThrough()

    this.process = ffmpeg(this.streamUrl)
      .inputOptions(['-re'])
      .outputOptions([
        `-vf fps=${this.fps}`,
        '-f image2pipe',
        '-vcodec mjpeg',
        '-q:v 5',
      ])
      .output(passThrough as unknown as string)
      .on('error', (err: Error) => {
        if (this.running) {
          this.emit('error', err)
          setTimeout(() => {
            if (this.running) this.start()
          }, 5000)
        }
      })

    passThrough.on('data', (chunk: Buffer) => {
      const jpegStart = chunk.indexOf(Buffer.from([0xff, 0xd8]))
      const jpegEnd = chunk.lastIndexOf(Buffer.from([0xff, 0xd9]))
      if (jpegStart !== -1 && jpegEnd !== -1) {
        this.emit('frame', chunk.slice(jpegStart, jpegEnd + 2))
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
