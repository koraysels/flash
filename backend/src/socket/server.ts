import { Server as HttpServer } from 'http'
import { Server as SocketServer } from 'socket.io'

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

export type TrapMeasurement = { speedKmh: number; timestamp: number; isSpeeder: boolean }

export type FrameEvent = {
  cameraId: string
  timestamp: number
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
// Keep latest raw JPEG for the snapshot endpoint
const latestFrames = new Map<string, string>()

export function initSocketServer(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 2e6,
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
  if (rawJpeg) latestFrames.set(event.cameraId, rawJpeg)
  io?.to(`camera:${event.cameraId}`).emit('frame', event)
}

export function getLatestFrame(cameraId: string): string | undefined {
  return latestFrames.get(cameraId)
}

export function evictCameraFrame(cameraId: string): void {
  latestFrames.delete(cameraId)
}
