import { useEffect, useRef, useState } from 'react'
import { socket } from '../lib/socket'

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
}

export function useCameraFeed(cameraId: string) {
  const [aiFps, setAiFps] = useState(0)
  const [videoFps, setVideoFps] = useState(0)
  const [counts, setCounts] = useState<{ AB: number; BA: number; speeders: number }>({ AB: 0, BA: 0, speeders: 0 })
  const [avgSpeedKmh, setAvgSpeedKmh] = useState<number | null>(null)
  const [vehicles, setVehicles] = useState<VehicleInfo[]>([])
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null)
  const [active, setActive] = useState(false)
  const [recentTrapMeasurements, setRecentTrapMeasurements] = useState<TrapMeasurement[]>([])
  const aiFrameCount = useRef(0)
  const lastFpsTime = useRef(Date.now())
  const avgSpeedRef = useRef<number | null>(null)

  useEffect(() => {
    setAiFps(0)
    setVideoFps(0)
    setCounts({ AB: 0, BA: 0, speeders: 0 })
    setAvgSpeedKmh(null)
    setVehicles([])
    setFrameSize(null)
    setActive(false)
    setRecentTrapMeasurements([])
    aiFrameCount.current = 0
    lastFpsTime.current = Date.now()
    avgSpeedRef.current = null

    const subscribe = () => socket.emit('subscribe', cameraId)
    subscribe()
    socket.on('connect', subscribe)  // re-subscribe after socket reconnect

    const handler = (event: FrameEvent) => {
      if (event.cameraId !== cameraId) return
      setActive(true)
      if (event.counts) setCounts(event.counts)
      setVehicles(event.vehicles)
      if (event.frameWidth && event.frameHeight) {
        setFrameSize({ width: event.frameWidth, height: event.frameHeight })
      }
      if (event.videoFps) setVideoFps(event.videoFps)
      if (event.recentTrapMeasurements?.length) setRecentTrapMeasurements(event.recentTrapMeasurements)

      const speeds = event.vehicles.map((v) => v.speedKmh).filter((s): s is number => s !== null)
      if (speeds.length > 0) {
        const raw = speeds.reduce((a, b) => a + b, 0) / speeds.length
        avgSpeedRef.current = avgSpeedRef.current === null ? raw : 0.15 * raw + 0.85 * avgSpeedRef.current
        setAvgSpeedKmh(Math.round(avgSpeedRef.current))
      }

      aiFrameCount.current++
      const now = Date.now()
      if (now - lastFpsTime.current >= 1000) {
        setAiFps(aiFrameCount.current)
        aiFrameCount.current = 0
        lastFpsTime.current = now
      }
    }

    socket.on('frame', handler)
    return () => {
      socket.off('connect', subscribe)
      socket.off('frame', handler)
      socket.emit('unsubscribe', cameraId)
    }
  }, [cameraId])

  return { aiFps, videoFps, counts, avgSpeedKmh, vehicles, frameSize, active, recentTrapMeasurements }
}
