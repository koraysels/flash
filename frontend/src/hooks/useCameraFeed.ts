import { useEffect, useRef, useState } from 'react'
import { socket } from '../lib/socket'

export type FrameEvent = {
  cameraId: string
  frame: string
  timestamp: number
  vehicles: Array<{ id: number; class: string; speedKmh: number | null; direction: 'AB' | 'BA' | null }>
  counts: { AB: number; BA: number; speeders: number }
}

export function useCameraFeed(cameraId: string) {
  const [lastFrame, setLastFrame] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const [counts, setCounts] = useState<{ AB: number; BA: number; speeders: number }>({ AB: 0, BA: 0, speeders: 0 })
  const [avgSpeedKmh, setAvgSpeedKmh] = useState<number | null>(null)
  const frameCount = useRef(0)
  const lastFpsTime = useRef(Date.now())

  useEffect(() => {
    // Reset state when switching cameras
    setLastFrame(null)
    setFps(0)
    setCounts({ AB: 0, BA: 0, speeders: 0 })
    setAvgSpeedKmh(null)
    frameCount.current = 0
    lastFpsTime.current = Date.now()

    socket.emit('subscribe', cameraId)

    const handler = (event: FrameEvent) => {
      if (event.cameraId !== cameraId) return
      setLastFrame(event.frame)
      if (event.counts) setCounts(event.counts)

      const speeds = event.vehicles.map((v) => v.speedKmh).filter((s): s is number => s !== null)
      if (speeds.length > 0) setAvgSpeedKmh(speeds.reduce((a, b) => a + b, 0) / speeds.length)

      frameCount.current++
      const now = Date.now()
      if (now - lastFpsTime.current >= 1000) {
        setFps(frameCount.current)
        frameCount.current = 0
        lastFpsTime.current = now
      }
    }

    socket.on('frame', handler)
    return () => {
      socket.off('frame', handler)
      socket.emit('unsubscribe', cameraId)
    }
  }, [cameraId])

  return { lastFrame, fps, counts, avgSpeedKmh }
}
