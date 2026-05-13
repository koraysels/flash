import { Server as HttpServer } from 'http'
import { Server as SocketServer } from 'socket.io'

export type VehicleInfo = {
  id: number
  class: string
  speedKmh: number | null
  direction: 'AB' | 'BA' | null
}

export type FrameEvent = {
  cameraId: string
  frame: string
  timestamp: number
  vehicles: VehicleInfo[]
  counts: { AB: number; BA: number; speeders: number }
}

let io: SocketServer | null = null
const latestFrames = new Map<string, string>()

export function initSocketServer(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 5e6,
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

export function emitFrame(event: FrameEvent): void {
  latestFrames.set(event.cameraId, event.frame)
  io?.to(`camera:${event.cameraId}`).emit('frame', event)
}

export function getLatestFrame(cameraId: string): string | undefined {
  return latestFrames.get(cameraId)
}
