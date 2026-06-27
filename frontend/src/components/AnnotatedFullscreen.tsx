import { useEffect, useRef } from 'react'
import Hls from 'hls.js'

/** Fullscreen, chrome-less player of a camera's baked annotated HLS stream.
 *  Shared by the direct /camera/:id route and the assignable /display/:slug kiosk route. */
export function AnnotatedFullscreen({ cameraId }: { cameraId: string | null }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // Kiosk: kill the Cast / Remote-Playback button (the JSX prop doesn't always
    // take, so also force it on the element after mount).
    video.disableRemotePlayback = true
    if (!cameraId) return
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
    <video
      ref={videoRef}
      muted
      autoPlay
      playsInline
      disableRemotePlayback
      {...{ 'x-webkit-airplay': 'deny' }}
      className="w-full h-full"
      style={{ objectFit: 'contain' }}
    />
  )
}
