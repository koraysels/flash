import { spawn, ChildProcess } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { resolveFfmpegPath } from './ffmpeg-path'

const IDLE_MS = 15_000
const OUT_FPS = 20

export class AnnotatedEncoder {
  private proc: ChildProcess | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private active = false
  readonly playlistPath: string

  constructor(private readonly cameraId: string, private readonly outDir: string) {
    this.playlistPath = join(outDir, 'index.m3u8')
  }

  isActive(): boolean { return this.active }

  start(): void {
    if (this.active) { this.armIdle(); return }
    this.active = true
    this.armIdle()
    try {
      mkdirSync(this.outDir, { recursive: true })
      const ff = resolveFfmpegPath()
      const args = [
        '-f', 'image2pipe', '-framerate', String(OUT_FPS), '-i', 'pipe:0',
        '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-pix_fmt', 'yuv420p',
        '-g', String(OUT_FPS * 2),
        '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+append_list+omit_endlist',
        '-hls_segment_filename', join(this.outDir, 'seg_%05d.ts'),
        this.playlistPath,
      ]
      this.proc = spawn(ff, args, { stdio: ['pipe', 'ignore', 'pipe'] })
      this.proc.stderr?.on('data', () => { /* swallow; NVENC may warn */ })
      this.proc.on('exit', () => { this.handleExit() })
      // If NVENC fails immediately, restart once with libx264.
      // Note: the `if (!this.active) return` guard in fallbackToLibx264 prevents a restart after stop().
      this.proc.on('error', (err) => { console.warn(`[annotated:${this.cameraId}] nvenc spawn failed, falling back to libx264: ${err}`); this.fallbackToLibx264() })
    } catch (err) {
      console.warn(`[annotated:${this.cameraId}] nvenc spawn failed, falling back to libx264`)
      this.fallbackToLibx264()
    }
  }

  private fallbackToLibx264(): void {
    if (!this.active) return
    try {
      const ff = resolveFfmpegPath()
      const args = [
        '-f', 'image2pipe', '-framerate', String(OUT_FPS), '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
        '-g', String(OUT_FPS * 2),
        '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+append_list+omit_endlist',
        '-hls_segment_filename', join(this.outDir, 'seg_%05d.ts'),
        this.playlistPath,
      ]
      this.proc = spawn(ff, args, { stdio: ['pipe', 'ignore', 'pipe'] })
      this.proc.stderr?.on('data', () => {})
      this.proc.on('exit', () => { this.handleExit() })
    } catch { /* give up; routes will 404 until restart */ }
  }

  pushFrame(jpeg: Buffer): void {
    if (this.active && this.proc?.stdin?.writable) {
      this.proc.stdin.write(jpeg)
    }
  }

  touch(): void { if (this.active) this.armIdle() }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS)
  }

  private handleExit(): void {
    this.proc = null
    if (this.active) {
      this.active = false
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
      console.warn(`[annotated:${this.cameraId}] encoder exited unexpectedly; will restart on next request`)
    }
  }

  stop(): void {
    this.active = false
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    this.proc?.stdin?.end()
    this.proc?.kill('SIGTERM')
    this.proc = null
  }
}
