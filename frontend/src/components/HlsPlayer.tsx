import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'

interface Props {
  cameraId: string
  className?: string
}

export function HlsPlayer({ cameraId, className }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [status, setStatus] = useState<'connecting' | 'buffering' | 'playing' | 'error'>('connecting')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    setStatus('connecting')
    setErrorMsg(null)

    const src = `/api/cameras/${cameraId}/hls/playlist.m3u8`

    if (Hls.isSupported()) {
      const hls = new Hls({
        // The upstream chunklist only ever has 3 segments (~9.6s each = ~29s total).
        // liveSyncDurationCount must be < 3 so HLS.js can find its start position.
        // Set to 1 → start 1 segment behind the live edge (9.6s latency is fine).
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 3,  // never fall beyond all available segments
        maxBufferLength: 30,             // keep up to 30s buffered for smooth playback
        maxMaxBufferLength: 60,
        lowLatencyMode: false,
        // Retry config
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 1500,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
        maxFragLookUpTolerance: 0.5,
        backBufferLength: 20,
      })
      hlsRef.current = hls

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(src)
        setStatus('buffering')
      })

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {})
      })

      // First fragment ready in buffer — try to ensure playback starts
      let playStarted = false
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (!playStarted) {
          playStarted = true
          video.play().catch(() => {})
        }
      })

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // Auto-recover network errors (stale segment URLs on stream rotation)
            hls.startLoad()
          } else {
            setStatus('error')
            setErrorMsg(data.details ?? 'Stream error')
          }
        }
      })

      hls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = src
      video.addEventListener('waiting', () => setStatus('buffering'), { once: true })
      video.addEventListener('error', () => { setStatus('error'); setErrorMsg('Stream error') })
      video.play().catch(() => {})
    } else {
      setStatus('error')
      setErrorMsg('HLS not supported in this browser')
    }

    return () => {
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [cameraId])

  // Track playing/waiting via the video element's own events (not HLS.js events)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlaying = () => setStatus('playing')
    const onWaiting = () => setStatus((s) => s === 'error' ? s : 'buffering')
    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
    }
  }, [])

  const overlay = status === 'connecting' ? 'Connecting...'
    : status === 'buffering' ? 'Buffering...'
    : status === 'error' ? (errorMsg ?? 'Stream unavailable')
    : null

  return (
    <div className={`relative bg-black rounded-lg overflow-hidden ${className ?? ''}`}>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full h-full object-contain"
      />
      {overlay && (
        <div className={`absolute inset-0 flex items-center justify-center text-sm gap-2
          ${status === 'error' ? 'text-red-400' : 'text-gray-400'}`}>
          {(status === 'connecting' || status === 'buffering') && (
            <div className="w-5 h-5 border-2 border-gray-600 border-t-blue-400 rounded-full animate-spin flex-shrink-0" />
          )}
          {overlay}
        </div>
      )}
      {status === 'playing' && (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-black/60 px-2 py-0.5 rounded text-xs text-green-400">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          Live
        </div>
      )}
    </div>
  )
}
