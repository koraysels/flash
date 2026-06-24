import { useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import Hls from 'hls.js'

export default function PiDisplay() {
  const { cameraId } = useParams<{ cameraId: string }>()
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !cameraId) return
    const src = `/api/cameras/${cameraId}/annotated/index.m3u8`

    let destroyed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let hls: Hls | null = null
    if (Hls.isSupported()) {
      hls = new Hls({ liveSyncDuration: 3, lowLatencyMode: false })
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
