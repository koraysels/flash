import { spawn, ChildProcess } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { resolveFfmpegPath } from './ffmpeg-path'

const IDLE_MS = 15_000
const OUT_FPS = 20

type Codec = 'nvenc' | 'libx264'

export class AnnotatedEncoder {
  private proc: ChildProcess | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private writeTimer: ReturnType<typeof setInterval> | null = null
  private active = false
  private triedFallback = false
  private lastStderr = ''
  private lastFrame: Buffer | null = null
  readonly playlistPath: string

  constructor(private readonly cameraId: string, private readonly outDir: string) {
    this.playlistPath = join(outDir, 'index.m3u8')
  }

  isActive(): boolean { return this.active }

  start(): void {
    if (this.active) { this.armIdle(); return }
    this.active = true
    this.triedFallback = false
    this.armIdle()
    try { mkdirSync(this.outDir, { recursive: true }) } catch { /* dir may exist */ }
    this.spawnEncoder('nvenc')
    if (!this.writeTimer) {
      this.writeTimer = setInterval(() => {
        if (this.active && this.proc?.stdin?.writable && this.lastFrame) {
          this.proc.stdin.write(this.lastFrame)
        }
      }, 1000 / OUT_FPS)
    }
  }

  private codecArgs(codec: Codec): string[] {
    // Pi-friendly H.264: High profile @ level 4.0, NO B-frames, bounded CBR
    // bitrate, one keyframe per 1s segment. Raspberry Pi 4/5 hardware-decode this
    // reliably; NVENC defaults (B-frames, unbounded rate) push the Pi into slow
    // software decode → stutter.
    // Pi-decode-essential flags only: no B-frames + High@4.0 + yuv420p (set below)
    // + one keyframe per 1s segment. Rate control left to the encoder's smooth
    // default (a bounded VBR cap, not constant high CBR) — forcing CBR 3M made
    // the stream spiky and stall through the tunnel.
    const enc = codec === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll',
         '-profile:v', 'high', '-level', '4.0', '-bf', '0', '-forced-idr', '1',
         '-rc', 'vbr', '-maxrate', '2M', '-bufsize', '2M']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
         '-profile:v', 'high', '-level', '4.0', '-bf', '0',
         '-maxrate', '2M', '-bufsize', '2M',
         '-x264-params', 'keyint=20:min-keyint=20:scenecut=0']
    return [
      '-f', 'image2pipe', '-framerate', String(OUT_FPS), '-i', 'pipe:0',
      ...enc, '-pix_fmt', 'yuv420p', '-g', String(OUT_FPS),
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+append_list+omit_endlist',
      '-hls_segment_filename', join(this.outDir, 'seg_%05d.ts'),
      this.playlistPath,
    ]
  }

  private spawnEncoder(codec: Codec): void {
    if (!this.active) return
    this.lastStderr = ''
    try {
      const ff = resolveFfmpegPath()
      const proc = spawn(ff, this.codecArgs(codec), { stdio: ['pipe', 'ignore', 'pipe'] })
      this.proc = proc
      proc.stderr?.on('data', (d: Buffer) => { this.lastStderr = (this.lastStderr + d.toString()).slice(-2000) })
      proc.on('error', (err) => this.onExit(codec, `spawn error: ${err}`))
      proc.on('exit', (code, signal) => this.onExit(codec, `exit code=${code} signal=${signal}`))
    } catch (err) {
      this.onExit(codec, `spawn threw: ${err}`)
    }
  }

  private onExit(codec: Codec, reason: string): void {
    this.proc = null
    if (!this.active) return  // normal stop()
    const tail = this.lastStderr.trim().split('\n').slice(-3).join(' | ')
    if (codec === 'nvenc' && !this.triedFallback) {
      this.triedFallback = true
      console.warn(`[annotated:${this.cameraId}] nvenc failed (${reason}); stderr: ${tail}; falling back to libx264`)
      this.spawnEncoder('libx264')
      return
    }
    this.active = false
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.writeTimer) { clearInterval(this.writeTimer); this.writeTimer = null }
    console.warn(`[annotated:${this.cameraId}] encoder exited (${reason}); stderr: ${tail}; will restart on next request`)
  }

  pushFrame(jpeg: Buffer): void {
    this.lastFrame = jpeg
  }

  touch(): void { if (this.active) this.armIdle() }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS)
  }

  stop(): void {
    this.active = false
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    if (this.writeTimer) { clearInterval(this.writeTimer); this.writeTimer = null }
    this.proc?.stdin?.end()
    this.proc?.kill('SIGTERM')
    this.proc = null
  }
}
