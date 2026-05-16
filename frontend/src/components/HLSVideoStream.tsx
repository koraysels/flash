import { useEffect, useRef } from 'react'
import Hls from 'hls.js'
import type { VehicleInfo } from '../hooks/useCameraFeed'

const CLASS_COLORS: Record<string, string> = {
  car: '#3b82f6',
  truck: '#f59e0b',
  bus: '#10b981',
  motorcycle: '#8b5cf6',
}

interface Props {
  cameraId: string
  vehicles: VehicleInfo[]
  frameSize: { width: number; height: number } | null
  lineA?: number
  lineB?: number
  className?: string
}

export function HLSVideoStream({ cameraId, vehicles, frameSize, lineA, lineB, className }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hlsRef = useRef<Hls | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const src = `/api/cameras/${cameraId}/hls`

    function initHls() {
      if (!video) return
      if (Hls.isSupported()) {
        const hls = new Hls()
        hlsRef.current = hls
        hls.loadSource(src)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {})
        })
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal) {
            hls.destroy()
            if (hlsRef.current === hls) {
              hlsRef.current = null
              setTimeout(initHls, 3_000)
            }
          }
        })
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src
        video.play().catch(() => {})
      }
    }

    initHls()

    return () => {
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [cameraId])

  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const rect = video.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    ctx.clearRect(0, 0, rect.width, rect.height)

    const fw = frameSize?.width ?? video.videoWidth
    const fh = frameSize?.height ?? video.videoHeight
    if (fw === 0 || fh === 0) return

    // Compute the actual video render rect within the container (object-contain letterboxing)
    const videoAspect = fw / fh
    const containerAspect = rect.width / rect.height
    let renderW: number, renderH: number, offsetX: number, offsetY: number
    if (videoAspect > containerAspect) {
      renderW = rect.width
      renderH = rect.width / videoAspect
      offsetX = 0
      offsetY = (rect.height - renderH) / 2
    } else {
      renderH = rect.height
      renderW = rect.height * videoAspect
      offsetX = (rect.width - renderW) / 2
      offsetY = 0
    }

    const scaleX = renderW / fw
    const scaleY = renderH / fh

    // Counting lines
    if (lineA !== undefined) {
      const aY = offsetY + lineA * renderH
      ctx.strokeStyle = 'rgba(255,220,0,0.85)'
      ctx.lineWidth = 2
      ctx.setLineDash([10, 5])
      ctx.beginPath(); ctx.moveTo(offsetX, aY); ctx.lineTo(offsetX + renderW, aY); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,220,0,0.9)'
      ctx.font = 'bold 11px monospace'
      ctx.fillText('A', offsetX + 4, aY - 3)
    }
    if (lineB !== undefined) {
      const bY = offsetY + lineB * renderH
      ctx.strokeStyle = 'rgba(255,220,0,0.85)'
      ctx.lineWidth = 2
      ctx.setLineDash([10, 5])
      ctx.beginPath(); ctx.moveTo(offsetX, bY); ctx.lineTo(offsetX + renderW, bY); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,220,0,0.9)'
      ctx.font = 'bold 11px monospace'
      ctx.fillText('B', offsetX + 4, bY - 3)
    }

    // Detection boxes
    for (const v of vehicles) {
      const color = CLASS_COLORS[v.class] ?? '#fff'
      const x1 = offsetX + v.x1 * scaleX
      const y1 = offsetY + v.y1 * scaleY
      const x2 = offsetX + v.x2 * scaleX
      const y2 = offsetY + v.y2 * scaleY

      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.setLineDash([])
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)

      const label = v.speedKmh !== null ? `${v.class} ${Math.round(v.speedKmh)}km/h` : v.class
      ctx.font = '11px monospace'
      const tw = ctx.measureText(label).width + 6
      const ly = Math.max(y1, offsetY + 14)
      ctx.fillStyle = color
      ctx.fillRect(x1, ly - 14, tw, 14)
      ctx.fillStyle = '#000'
      ctx.fillText(label, x1 + 3, ly - 3)
    }
  }, [vehicles, frameSize, lineA, lineB])

  return (
    <div className={`relative overflow-hidden bg-black ${className ?? ''}`}>
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        autoPlay
        muted
        playsInline
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  )
}
