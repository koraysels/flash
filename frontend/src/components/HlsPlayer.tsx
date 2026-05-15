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
        // Long segments (~9s) from verkeerscentrum — tune buffer accordingly
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 3,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        lowLatencyMode: false,
        // Retry on network errors
        fragLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 3,
        fragLoadingRetryDelay: 2000,
      })
      hlsRef.current = hls

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(src)
        setStatus('buffering')
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {})
      })
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (status !== 'playing') setStatus('playing')
      })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          setStatus('error')
          setErrorMsg(data.details ?? 'Stream error')
          // Try to recover network errors automatically
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setTimeout(() => hls.startLoad(), 3000)
          }
        }
      })

      hls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = src
      video.addEventListener('waiting', () => setStatus('buffering'), { once: true })
      video.addEventListener('playing', () => setStatus('playing'))
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

  // Update playing status when video actually starts playing
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlaying = () => setStatus('playing')
    const onWaiting = () => setStatus('buffering')
    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
    }
  }, [])

  const statusLabel = {
    connecting: 'Connecting...',
    buffering: 'Buffering (~10s for first segment)...',
    playing: null,
    error: errorMsg ?? 'Stream unavailable',
  }[status]

  return (
    <div className={`relative bg-gray-900 rounded-lg overflow-hidden ${className ?? ''}`}>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full h-full object-contain"
      />
      {statusLabel && (
        <div className={`absolute inset-0 flex items-center justify-center text-sm px-4 text-center
          ${status === 'error' ? 'text-red-400' : 'text-gray-400'}`}>
          {status === 'buffering' && (
            <div className="w-6 h-6 border-2 border-gray-600 border-t-blue-400 rounded-full animate-spin mr-2 flex-shrink-0" />
          )}
          {statusLabel}
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
