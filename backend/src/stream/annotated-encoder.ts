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
  private active = false
  private triedFallback = false
  private lastStderr = ''
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
  }

  private codecArgs(codec: Codec): string[] {
    const enc = codec === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency']
    return [
      '-f', 'image2pipe', '-framerate', String(OUT_FPS), '-i', 'pipe:0',
      ...enc, '-pix_fmt', 'yuv420p', '-g', String(OUT_FPS * 2),
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
    console.warn(`[annotated:${this.cameraId}] encoder exited (${reason}); stderr: ${tail}; will restart on next request`)
  }

  pushFrame(jpeg: Buffer): void {
    if (this.active && this.proc?.stdin?.writable) this.proc.stdin.write(jpeg)
  }

  touch(): void { if (this.active) this.armIdle() }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS)
  }

  stop(): void {
    this.active = false
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    this.proc?.stdin?.end()
    this.proc?.kill('SIGTERM')
    this.proc = null
  }
}
