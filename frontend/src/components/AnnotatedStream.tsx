import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { VehicleInfo } from '../hooks/useCameraFeed'

const CLASS_COLORS: Record<string, string> = {
  car: '#3b82f6',
  truck: '#f59e0b',
  bus: '#10b981',
  motorcycle: '#8b5cf6',
}

interface Props {
  cameraId: string
  vehicles: VehicleInfo[]
  frameWidth: number | null
  frameHeight: number | null
  lineA: number
  lineB: number
  className?: string
}

export function AnnotatedStream({ cameraId, vehicles, frameWidth, frameHeight, lineA, lineB, className }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [videoStatus, setVideoStatus] = useState<'connecting' | 'buffering' | 'playing' | 'error'>('connecting')

  // HLS player setup
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    setVideoStatus('connecting')
    const src = `/api/cameras/${cameraId}/hls/playlist.m3u8`

    if (Hls.isSupported()) {
      const hls = new Hls({
        // Stream only has 3 segments (~9.6s each). liveSyncDurationCount must be < 3.
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 3,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        lowLatencyMode: false,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 1500,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
        backBufferLength: 20,
      })

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(src)
        setVideoStatus('buffering')
      })

      let started = false
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (!started) { started = true; video.play().catch(() => {}) }
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}) })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
          else setVideoStatus('error')
        }
      })

      hls.attachMedia(video)
      return () => hls.destroy()
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
      video.play().catch(() => {})
    }
  }, [cameraId])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlaying = () => setVideoStatus('playing')
    const onWaiting = () => setVideoStatus((s) => s === 'error' ? s : 'buffering')
    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    return () => { video.removeEventListener('playing', onPlaying); video.removeEventListener('waiting', onWaiting) }
  }, [])

  // Draw overlay whenever detection data changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Sync canvas pixel dimensions to its CSS display size
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0) return
    canvas.width = rect.width
    canvas.height = rect.height

    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Scale from AI frame space → canvas display space
    const fw = frameWidth ?? 768
    const fh = frameHeight ?? 576
    const scaleX = canvas.width / fw
    const scaleY = canvas.height / fh

    // Counting lines (sent from server as fractions of frame height)
    const lineAY = lineA * canvas.height
    const lineBY = lineB * canvas.height
    ctx.save()
    ctx.strokeStyle = 'rgba(255,230,0,0.8)'
    ctx.lineWidth = 2
    ctx.setLineDash([10, 5])
    ctx.beginPath(); ctx.moveTo(0, lineAY); ctx.lineTo(canvas.width, lineAY); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, lineBY); ctx.lineTo(canvas.width, lineBY); ctx.stroke()
    ctx.setLineDash([])
    // Line labels
    ctx.font = 'bold 11px monospace'
    ctx.fillStyle = 'rgba(255,230,0,0.9)'
    ctx.fillText('Line A', 6, lineAY - 4)
    ctx.fillText('Line B', 6, lineBY - 4)
    ctx.restore()

    // Vehicle bounding boxes
    for (const v of vehicles) {
      const x = v.x1 * scaleX
      const y = v.y1 * scaleY
      const w = (v.x2 - v.x1) * scaleX
      const h = (v.y2 - v.y1) * scaleY
      const color = CLASS_COLORS[v.class] ?? '#ffffff'

      ctx.save()
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.strokeRect(x, y, w, h)

      // Label background
      const label = v.speedKmh !== null
        ? `${v.class} ${Math.round(v.speedKmh)} km/h`
        : `${v.class} #${v.id}`
      ctx.font = '11px monospace'
      const tw = ctx.measureText(label).width + 6
      const labelY = Math.max(16, y)
      ctx.fillStyle = color
      ctx.fillRect(x, labelY - 14, tw, 14)
      ctx.fillStyle = '#000'
      ctx.fillText(label, x + 3, labelY - 3)
      ctx.restore()
    }
  }, [vehicles, frameWidth, frameHeight, lineA, lineB])

  return (
    <div className={`relative overflow-hidden bg-black rounded-lg ${className ?? ''}`}>
      {/* HLS video — fills container */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full h-full object-contain"
      />

      {/* Canvas overlay — exact same size, pointer-events-none so clicks pass through */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />

      {/* Status overlay (only when not playing) */}
      {videoStatus !== 'playing' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-gray-400">
          {videoStatus !== 'error' && (
            <div className="w-5 h-5 border-2 border-gray-600 border-t-blue-400 rounded-full animate-spin flex-shrink-0" />
          )}
          {videoStatus === 'connecting' && 'Connecting...'}
          {videoStatus === 'buffering' && 'Buffering...'}
          {videoStatus === 'error' && <span className="text-red-400">Stream unavailable</span>}
        </div>
      )}

      {/* Live badge */}
      {videoStatus === 'playing' && (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-black/60 px-2 py-0.5 rounded text-xs text-green-400">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          Live
        </div>
      )}
    </div>
  )
}
