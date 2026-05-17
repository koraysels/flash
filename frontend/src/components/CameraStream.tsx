import { useEffect, useRef, useState } from 'react'
import { socket } from '../lib/socket'
import type { FrameEvent, VehicleInfo } from '../hooks/useCameraFeed'

const CLASS_COLORS: Record<string, string> = {
  car: '#3b82f6',
  truck: '#f59e0b',
  bus: '#10b981',
  motorcycle: '#8b5cf6',
}

const STALE_THRESHOLD_MS = 5_000
const WATCHDOG_INTERVAL_MS = 2_000
// Position lerp per rAF frame (~60fps). 0.2 → box reaches 96% of new position within 250ms,
// settling smoothly between AI detections (~5fps = 200ms apart).
const LERP = 0.2
// Keep a box alive this many detection cycles after it stops being detected,
// then fade and remove. At ~5fps AI this gives ~2s of tolerance before removal.
const MAX_MISSED = 10
// Per-rAF lerp factor for displayed speed — drifts the number continuously at 60fps
// rather than jumping at AI frame rate (~5fps). Reaches ~90% of target in ~56 frames (~0.9s).
const SPEED_LERP = 0.04

type SmoothVehicle = {
  id: number
  class: string
  speedKmh: number | null
  displaySpeed: number | null  // EMA-smoothed speed for display
  // Current displayed position (lerped)
  x1: number; y1: number; x2: number; y2: number
  // Target position from latest detection
  tx1: number; ty1: number; tx2: number; ty2: number
  missed: number  // detection cycles without a match
}

interface Props {
  cameraId: string
  vehicles: VehicleInfo[]
  frameSize: { width: number; height: number } | null
  lineA?: number
  lineB?: number
  lineAPoints?: number[]   // [x1,y1,x2,y2] normalised 0-1; overrides lineA if length===4
  lineBPoints?: number[]   // same for B
  maxSpeedKmh?: number | null
  className?: string
}

export function CameraStream({ cameraId, vehicles, frameSize, lineA, lineB, lineAPoints, lineBPoints, maxSpeedKmh, className }: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastActivityRef = useRef(0)
  const [imgKey, setImgKey] = useState(0)
  const [stale, setStale] = useState(false)

  // Persisted smooth state — survives re-renders, updated by detection events
  const smoothRef = useRef<Map<number, SmoothVehicle>>(new Map())
  // Cached canvas layout — only recomputed on container resize
  const layoutRef = useRef<{
    dpr: number; w: number; h: number
    offsetX: number; offsetY: number
    renderW: number; renderH: number
    scaleX: number; scaleY: number
  } | null>(null)
  // Refs for latest props, readable from the rAF loop without stale closures
  const frameSizeRef = useRef(frameSize)
  const lineARef = useRef(lineA)
  const lineBRef = useRef(lineB)
  const lineAPointsRef = useRef(lineAPoints)
  const lineBPointsRef = useRef(lineBPoints)

  useEffect(() => { frameSizeRef.current = frameSize }, [frameSize])
  useEffect(() => { lineARef.current = lineA }, [lineA])
  useEffect(() => { lineBRef.current = lineB }, [lineB])
  useEffect(() => { lineAPointsRef.current = lineAPoints }, [lineAPoints])
  useEffect(() => { lineBPointsRef.current = lineBPoints }, [lineBPoints])

  // Recompute canvas size and layout whenever the container changes
  const recomputeLayout = () => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return

    const rect = img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)

    const fw = frameSizeRef.current?.width ?? img.naturalWidth
    const fh = frameSizeRef.current?.height ?? img.naturalHeight
    if (fw === 0 || fh === 0) { layoutRef.current = null; return }

    const frameAspect = fw / fh
    const containerAspect = rect.width / rect.height
    let renderW: number, renderH: number, offsetX: number, offsetY: number
    if (frameAspect > containerAspect) {
      renderW = rect.width; renderH = rect.width / frameAspect
      offsetX = 0; offsetY = (rect.height - renderH) / 2
    } else {
      renderH = rect.height; renderW = rect.height * frameAspect
      offsetX = (rect.width - renderW) / 2; offsetY = 0
    }

    layoutRef.current = {
      dpr, w: rect.width, h: rect.height,
      offsetX, offsetY, renderW, renderH,
      scaleX: renderW / fw, scaleY: renderH / fh,
    }
  }

  // Update smooth vehicle targets whenever the AI sends new detections
  useEffect(() => {
    const smooth = smoothRef.current
    const seen = new Set(vehicles.map(v => v.id))

    for (const v of vehicles) {
      const s = smooth.get(v.id)
      if (s) {
        s.tx1 = v.x1; s.ty1 = v.y1; s.tx2 = v.x2; s.ty2 = v.y2
        s.speedKmh = v.speedKmh
        s.missed = 0
      } else {
        // New vehicle: start display position at target (no initial jump)
        smooth.set(v.id, {
          id: v.id, class: v.class, speedKmh: v.speedKmh,
          displaySpeed: v.speedKmh,
          x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2,
          tx1: v.x1, ty1: v.y1, tx2: v.x2, ty2: v.y2,
          missed: 0,
        })
      }
    }

    for (const [id, s] of smooth) {
      if (!seen.has(id)) {
        s.missed++
        if (s.missed > MAX_MISSED) smooth.delete(id)
      }
    }
  }, [vehicles])

  // rAF loop: lerp box positions toward targets, redraw at ~60fps
  useEffect(() => {
    let rafId: number

    const draw = () => {
      const canvas = canvasRef.current
      const img = imgRef.current
      if (!canvas || !img) { rafId = requestAnimationFrame(draw); return }

      const layout = layoutRef.current
      if (!layout) { rafId = requestAnimationFrame(draw); return }

      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, layout.w, layout.h)

      const { offsetX, offsetY, renderW, renderH, scaleX, scaleY } = layout

      // Counting lines (horizontal fallback or angled via normalised 4-point spec)
      for (const [pts, frac, label] of [
        [lineAPointsRef.current, lineARef.current, 'A'],
        [lineBPointsRef.current, lineBRef.current, 'B'],
      ] as [number[] | undefined, number | undefined, string][]) {
        let x1c: number, y1c: number, x2c: number, y2c: number
        if (pts?.length === 4) {
          x1c = offsetX + pts[0] * renderW; y1c = offsetY + pts[1] * renderH
          x2c = offsetX + pts[2] * renderW; y2c = offsetY + pts[3] * renderH
        } else if (frac !== undefined) {
          const y = offsetY + frac * renderH
          x1c = offsetX; y1c = y; x2c = offsetX + renderW; y2c = y
        } else {
          continue
        }
        ctx.strokeStyle = 'rgba(255,220,0,0.85)'
        ctx.lineWidth = 2
        ctx.setLineDash([10, 5])
        ctx.beginPath(); ctx.moveTo(x1c, y1c); ctx.lineTo(x2c, y2c); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(255,220,0,0.9)'
        ctx.font = 'bold 11px monospace'
        ctx.fillText(label, x1c + 4, y1c - 3)
      }

      // Lerp and draw each tracked vehicle
      for (const s of smoothRef.current.values()) {
        s.x1 += (s.tx1 - s.x1) * LERP
        s.y1 += (s.ty1 - s.y1) * LERP
        s.x2 += (s.tx2 - s.x2) * LERP
        s.y2 += (s.ty2 - s.y2) * LERP
        if (s.speedKmh !== null) {
          s.displaySpeed = s.displaySpeed === null
            ? s.speedKmh
            : s.displaySpeed + (s.speedKmh - s.displaySpeed) * SPEED_LERP
        }

        const color = CLASS_COLORS[s.class] ?? '#fff'
        const x1 = offsetX + s.x1 * scaleX
        const y1 = offsetY + s.y1 * scaleY
        const x2 = offsetX + s.x2 * scaleX
        const y2 = offsetY + s.y2 * scaleY

        // Fade boxes that haven't been detected recently
        ctx.globalAlpha = s.missed > 0 ? 0.35 : 1
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.setLineDash([])
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)

        const label = s.displaySpeed !== null ? `${s.class} ${Math.round(s.displaySpeed)}km/h` : s.class
        ctx.font = '11px monospace'
        const tw = ctx.measureText(label).width + 6
        const ly = Math.max(y1, offsetY + 14)
        ctx.fillStyle = color
        ctx.fillRect(x1, ly - 14, tw, 14)
        ctx.fillStyle = '#000'
        ctx.fillText(label, x1 + 3, ly - 3)
        ctx.globalAlpha = 1
      }

      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [])

  // Recompute layout on container resize and when frameSize arrives from backend
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const ro = new ResizeObserver(recomputeLayout)
    ro.observe(img)
    return () => ro.disconnect()
  }, [])

  useEffect(() => { recomputeLayout() }, [frameSize])

  // Stale watchdog: reconnect MJPEG when socket goes quiet
  useEffect(() => {
    const handler = (event: FrameEvent) => {
      if (event.cameraId !== cameraId) return
      lastActivityRef.current = Date.now()
      setStale(false)
    }
    socket.on('frame', handler)
    return () => { socket.off('frame', handler) }
  }, [cameraId])

  useEffect(() => {
    const id = setInterval(() => {
      if (lastActivityRef.current === 0) return
      if (Date.now() - lastActivityRef.current > STALE_THRESHOLD_MS) {
        setStale(true)
        setImgKey(k => k + 1)
        lastActivityRef.current = Date.now()
      }
    }, WATCHDOG_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={`relative overflow-hidden bg-black ${className ?? ''}`}>
      <img
        key={imgKey}
        ref={imgRef}
        src={`/api/cameras/${cameraId}/mjpeg`}
        className="w-full h-full object-contain"
        alt=""
        onLoad={recomputeLayout}
        onError={() => setTimeout(() => setImgKey(k => k + 1), 2_000)}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: '100%', height: '100%' }}
      />
      {maxSpeedKmh != null && (
        <div className="absolute top-2 right-2 pointer-events-none select-none flex flex-col items-center">
          <svg width="54" height="54" viewBox="0 0 54 54" xmlns="http://www.w3.org/2000/svg"
            style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.7))' }}>
            {/* White fill */}
            <circle cx="27" cy="27" r="27" fill="white" />
            {/* Red border ring */}
            <circle cx="27" cy="27" r="27" fill="none" stroke="#cc0000" strokeWidth="7" />
            {/* Speed number */}
            <text
              x="27" y="27"
              dominantBaseline="central"
              textAnchor="middle"
              fontFamily="'Arial Narrow', Arial, sans-serif"
              fontWeight="900"
              fontSize={maxSpeedKmh >= 100 ? 17 : 20}
              fill="#111"
            >
              {maxSpeedKmh}
            </text>
          </svg>
        </div>
      )}
      {stale && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <span className="flex items-center gap-2 text-white text-sm font-medium">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            Reconnecting…
          </span>
        </div>
      )}
    </div>
  )
}
