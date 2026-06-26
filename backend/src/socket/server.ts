import { Server as HttpServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import { writeFile, readFile, mkdir } from 'fs/promises'
import { join } from 'path'

export type VehicleInfo = {
  id: number
  class: string
  speedKmh: number | null
  direction: 'AB' | 'BA' | null
  x1: number
  y1: number
  x2: number
  y2: number
}

export type TrapMeasurement = { speedKmh: number; timestamp: number; isSpeeder: boolean; direction: 'AB' | 'BA' }

export type FrameEvent = {
  cameraId: string
  timestamp: number
  frameSeq: number
  vehicles: VehicleInfo[]
  counts: { AB: number; BA: number; speeders: number }
  frameWidth: number
  frameHeight: number
  videoFps: number
  recentTrapMeasurements: TrapMeasurement[]
  timing?: {
    decodeMs: number
    canvasMs: number
    inferenceMs: number
    trackMs: number
    totalMs: number
  }
}

let io: SocketServer | null = null
// Keep latest raw JPEG for the snapshot endpoint (in-memory, hot path)
const latestFrames = new Map<string, string>()

// Persist the last snapshot to disk so a preview is available instantly even on a
// cold start or while a camera is restarting (in-memory map is empty then). Writes
// are throttled per camera so the 5fps feed doesn't thrash the disk.
const SNAP_DIR = join(process.cwd(), 'data', 'snapshots')
const SNAP_WRITE_INTERVAL_MS = 5000
const lastDiskWrite = new Map<string, number>()
let snapDirReady = false

async function persistSnapshot(cameraId: string, base64: string): Promise<void> {
  const now = Date.now()
  if (now - (lastDiskWrite.get(cameraId) ?? 0) < SNAP_WRITE_INTERVAL_MS) return
  lastDiskWrite.set(cameraId, now)
  try {
    if (!snapDirReady) { await mkdir(SNAP_DIR, { recursive: true }); snapDirReady = true }
    await writeFile(join(SNAP_DIR, `${cameraId}.jpg`), Buffer.from(base64, 'base64'))
  } catch { /* best-effort cache; never break the frame path */ }
}

export function initSocketServer(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 2e6,
    // Generous keepalive: a tight pingTimeout drops sockets on any tunnel/network
    // jitter, causing reconnect loops where the client never starts streaming
    // frames (camera shows "STARTING"). These match socket.io defaults.
    pingInterval: 25_000,
    pingTimeout: 20_000,
  })

  io.on('connection', (socket) => {
    socket.on('subscribe', (cameraId: string) => {
      socket.join(`camera:${cameraId}`)
    })
    socket.on('unsubscribe', (cameraId: string) => {
      socket.leave(`camera:${cameraId}`)
    })
  })

  return io
}

export function emitFrame(event: FrameEvent, rawJpeg?: string): void {
  if (rawJpeg) {
    latestFrames.set(event.cameraId, rawJpeg)
    void persistSnapshot(event.cameraId, rawJpeg)
  }
  io?.to(`camera:${event.cameraId}`).emit('frame', event)
}

export function getLatestFrame(cameraId: string): string | undefined {
  return latestFrames.get(cameraId)
}

// Latest live frame if present, else the last persisted snapshot from disk. Lets a
// preview render the last-known frame immediately while a fresh one is fetched.
export async function getLatestFrameOrDisk(cameraId: string): Promise<string | undefined> {
  const mem = latestFrames.get(cameraId)
  if (mem) return mem
  try {
    const buf = await readFile(join(SNAP_DIR, `${cameraId}.jpg`))
    return buf.toString('base64')
  } catch {
    return undefined
  }
}

export function evictCameraFrame(cameraId: string): void {
  latestFrames.delete(cameraId)
}
