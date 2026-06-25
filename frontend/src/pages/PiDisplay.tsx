import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import Hls from 'hls.js'
import { resolveDisplay } from '../lib/api'

export default function PiDisplay() {
  const { cameraId: slug } = useParams<{ cameraId: string }>()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cameraId, setCameraId] = useState<string | null>(null)
  const [error, setError] = useState(false)

  // Resolve the URL slug — a fixed kiosk slot (FLASH-PI-01/02/03) or a raw camera
  // id — to the real cameraId. Re-poll periodically so re-assigning the slot in
  // the dashboard switches the Pi without touching the Pi.
  useEffect(() => {
    if (!slug) return
    let cancelled = false
    const resolve = () =>
      resolveDisplay(slug)
        .then((id) => { if (!cancelled) { setCameraId((prev) => (prev === id ? prev : id)); setError(false) } })
        .catch(() => { if (!cancelled) setError(true) })
    resolve()
    const t = setInterval(resolve, 15_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [slug])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !cameraId) return
    const src = `/api/cameras/${cameraId}/annotated/index.m3u8`

    let destroyed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let hls: Hls | null = null
    if (Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: false,
        liveSyncDurationCount: 4,
        liveMaxLatencyDurationCount: 12,
        maxBufferLength: 30,
        maxLiveSyncPlaybackRate: 1.5,
      })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          retryTimer = setTimeout(() => {
            if (!destroyed) { hls?.loadSource(src); hls?.startLoad() }
          }, 2000)
        }
      })
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src  // Safari/native HLS
    }
    return () => {
      destroyed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      hls?.destroy()
    }
  }, [cameraId])

  return (
    <div className="fixed inset-0 bg-black">
      {error && !cameraId && (
        <div className="absolute inset-0 flex items-center justify-center text-stone-500 text-sm uppercase tracking-widest">
          No camera assigned to "{slug}"
        </div>
      )}
      <video
        ref={videoRef}
        muted
        autoPlay
        playsInline
        className="w-full h-full"
        style={{ objectFit: 'contain' }}
      />
    </div>
  )
}
