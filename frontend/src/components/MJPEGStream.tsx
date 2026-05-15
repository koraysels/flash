import { useEffect, useRef, useState } from 'react'
import { socket } from '../lib/socket'
import type { FrameEvent } from '../hooks/useCameraFeed'

const STALE_THRESHOLD_MS = 5_000
const WATCHDOG_INTERVAL_MS = 2_000

interface Props {
  cameraId: string
  className?: string
}

export function MJPEGStream({ cameraId, className }: Props) {
  const [stale, setStale] = useState(false)
  const [imgKey, setImgKey] = useState(0)
  // Tracks last frame-event or last reload attempt; 0 = stream never seen
  const lastActivityRef = useRef(0)

  // Passive listener — parent already subscribes; we only track timestamp
  useEffect(() => {
    const handler = (event: FrameEvent) => {
      if (event.cameraId !== cameraId) return
      lastActivityRef.current = Date.now()
      setStale(false)
    }
    socket.on('frame', handler)
    return () => { socket.off('frame', handler) }
  }, [cameraId])

  // Watchdog: if stream goes quiet for STALE_THRESHOLD_MS, force img reload and keep retrying
  useEffect(() => {
    const id = setInterval(() => {
      if (lastActivityRef.current === 0) return
      if (Date.now() - lastActivityRef.current > STALE_THRESHOLD_MS) {
        setStale(true)
        setImgKey((k) => k + 1)
        // Reset to now so the watchdog waits another STALE_THRESHOLD_MS before retrying,
        // enabling continuous automatic reconnect without user interaction
        lastActivityRef.current = Date.now()
      }
    }, WATCHDOG_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={`relative overflow-hidden bg-black ${className ?? ''}`}>
      <img
        key={imgKey}
        src={`/api/cameras/${cameraId}/mjpeg`}
        className="w-full h-full object-contain"
        alt=""
      />
      {stale && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <span className="text-white text-sm font-medium">Reconnecting…</span>
        </div>
      )}
    </div>
  )
}
