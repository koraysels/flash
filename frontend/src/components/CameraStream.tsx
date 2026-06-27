import { useEffect, useRef, useState } from 'react'
import { socket } from '../lib/socket'
import type { FrameEvent, VehicleInfo } from '../hooks/useCameraFeed'
import { useMjpegStream } from '../hooks/useMjpegStream'

const CLASS_COLORS: Record<string, string> = {
  car: '#3b82f6',
  truck: '#f59e0b',
  bus: '#10b981',
  motorcycle: '#8b5cf6',
}

const STALE_THRESHOLD_MS = 15_000
const WATCHDOG_INTERVAL_MS = 2_000
// Cap the draw loop at ~20fps (the AI detection rate). Drawing faster than the
// data arrives just burns client CPU; 20fps keeps motion smooth without it.
const DRAW_FPS = 20
const DRAW_INTERVAL_MS = 1000 / DRAW_FPS
// Position lerp per draw frame. Tuned for the DRAW_FPS loop (≈3× a 60fps factor)
// so a box still reaches its new target within ~2 detection cycles.
const LERP = 0.45
// Keep a box alive this many detection cycles after it stops being detected,
// then fade and remove. At 20fps AI this gives ~0.5s of tolerance before removal.
const MAX_MISSED = 10
// Per-draw lerp factor for displayed speed — drifts the number smoothly rather
// than jumping at the AI frame rate.
const SPEED_LERP = 0.11
// Speeder strobe: when a box first exceeds the limit, flash it white a few times,
// very fast — a camera-flash punch on the offender. 4 on/off cycles × 90ms ≈ 360ms.
const STROBE_FLASHES = 4
const STROBE_PERIOD_MS = 90

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
  wasSpeeder: boolean       // latched once it first exceeds the limit
  strobeStart: number | null // performance.now() when the white strobe began
}

interface Props {
  cameraId: string
  lineA?: number
  lineB?: number
  lineAPoints?: number[]   // [x1,y1,x2,y2] normalised 0-1; overrides lineA if length===4
  lineBPoints?: number[]   // same for B
  maxSpeedKmh?: number | null
  className?: string
}

export function CameraStream({ cameraId, lineA, lineB, lineAPoints, lineBPoints, maxSpeedKmh, className }: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastActivityRef = useRef(0)
  const [stale, setStale] = useState(false)

  // MJPEG stream parsed client-side so we know exact seq for each rendered frame
  const mjpegFrame = useMjpegStream(cameraId)

  // frameSize learned from socket events
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null)

  // Buffer of vehicles indexed by frameSeq — applied only when matching MJPEG frame renders
  const vehicleBufferRef = useRef<Map<number, VehicleInfo[]>>(new Map())

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
  const maxSpeedRef = useRef(maxSpeedKmh)

  useEffect(() => { frameSizeRef.current = frameSize }, [frameSize])
  useEffect(() => { lineARef.current = lineA }, [lineA])
  useEffect(() => { lineBRef.current = lineB }, [lineB])
  useEffect(() => { lineAPointsRef.current = lineAPoints }, [lineAPoints])
  useEffect(() => { lineBPointsRef.current = lineBPoints }, [lineBPoints])
  useEffect(() => { maxSpeedRef.current = maxSpeedKmh }, [maxSpeedKmh])

  // Recompute canvas size and layout whenever the container changes
  const recomputeLayout = () => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return

    const rect = img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    const dpr = window.devicePixelRatio || 1
    const cw = Math.round(rect.width * dpr)
    const ch = Math.round(rect.height * dpr)
    const ctx = canvas.getContext('2d')!
    // Only resize when the dimensions actually change — assigning canvas.width/height
    // clears the canvas, and recomputeLayout runs on every MJPEG frame. Clearing it
    // each frame made the overlay flicker between the clear and the next draw.
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.scale(dpr, dpr)
    }

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

  // Buffer incoming socket detections by frameSeq; apply them when the matching MJPEG frame loads
  useEffect(() => {
    const handler = (event: FrameEvent) => {
      if (event.cameraId !== cameraId) return
      vehicleBufferRef.current.set(event.frameSeq, event.vehicles)
      if (event.frameWidth && event.frameHeight) {
        setFrameSize({ width: event.frameWidth, height: event.frameHeight })
      }
      // Keep buffer small — only the most recent 60 entries
      if (vehicleBufferRef.current.size > 60) {
        const oldest = [...vehicleBufferRef.current.keys()].sort((a, b) => a - b)[0]
        vehicleBufferRef.current.delete(oldest)
      }
    }
    socket.on('frame', handler)
    return () => { socket.off('frame', handler) }
  }, [cameraId])

  // Apply vehicles from the buffer when the corresponding MJPEG frame renders
  const applyVehicles = (vehicles: VehicleInfo[]) => {
    const smooth = smoothRef.current
    const seen = new Set(vehicles.map(v => v.id))

    for (const v of vehicles) {
      const s = smooth.get(v.id)
      if (s) {
        s.tx1 = v.x1; s.ty1 = v.y1; s.tx2 = v.x2; s.ty2 = v.y2
        s.speedKmh = v.speedKmh
        s.missed = 0
      } else {
        smooth.set(v.id, {
          id: v.id, class: v.class, speedKmh: v.speedKmh,
          displaySpeed: v.speedKmh,
          x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2,
          tx1: v.x1, ty1: v.y1, tx2: v.x2, ty2: v.y2,
          missed: 0,
          wasSpeeder: false, strobeStart: null,
        })
      }
    }

    for (const [id, s] of smooth) {
      if (!seen.has(id)) {
        s.missed++
        if (s.missed > MAX_MISSED) smooth.delete(id)
      }
    }
  }

  // rAF loop (throttled to DRAW_FPS): lerp box positions toward targets, redraw.
  useEffect(() => {
    let rafId: number
    let lastDraw = 0

    const draw = (now: number) => {
      rafId = requestAnimationFrame(draw)
      // Throttle to DRAW_FPS — skip frames that arrive sooner.
      if (now - lastDraw < DRAW_INTERVAL_MS) return
      lastDraw = now

      const canvas = canvasRef.current
      const img = imgRef.current
      if (!canvas || !img) return

      const layout = layoutRef.current
      if (!layout) return

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

        // Speeder strobe: latch on the first frame this box exceeds the limit, then
        // flash its interior white for STROBE_FLASHES fast on/off cycles.
        const max = maxSpeedRef.current
        if (s.speedKmh !== null && max != null && s.speedKmh > max && !s.wasSpeeder) {
          s.wasSpeeder = true
          s.strobeStart = performance.now()
        }
        if (s.strobeStart !== null) {
          const elapsed = performance.now() - s.strobeStart
          if (elapsed >= STROBE_FLASHES * STROBE_PERIOD_MS) {
            s.strobeStart = null
          } else if (Math.floor(elapsed / (STROBE_PERIOD_MS / 2)) % 2 === 0) {
            ctx.save()
            ctx.globalAlpha = 1
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(x1, y1, x2 - x1, y2 - y1)
            ctx.restore()
          }
        }

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

  // Stale overlay: show reconnecting when socket goes quiet
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
      if (Date.now() - lastActivityRef.current > STALE_THRESHOLD_MS) setStale(true)
    }, WATCHDOG_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={`relative overflow-hidden bg-black ${className ?? ''}`}>
      <img
        ref={imgRef}
        src={mjpegFrame.src || undefined}
        data-seq={mjpegFrame.seq}
        className="w-full h-full object-contain"
        alt=""
        onLoad={(e) => {
          const seq = parseInt((e.target as HTMLImageElement).dataset.seq ?? '0')
          // AI processes only some frames, so exact seq match is rare.
          // Find the latest buffered result at or before the current frame.
          let best: VehicleInfo[] | undefined
          let bestSeq = -1
          for (const [k, v] of vehicleBufferRef.current) {
            if (k <= seq && k > bestSeq) { bestSeq = k; best = v }
          }
          if (best) {
            applyVehicles(best)
            for (const k of vehicleBufferRef.current.keys()) {
              if (k <= bestSeq) vehicleBufferRef.current.delete(k)
            }
          }
          recomputeLayout()
        }}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: '100%', height: '100%' }}
      />
      {maxSpeedKmh != null && (
        <div className="absolute top-2 right-2 pointer-events-none select-none flex flex-col items-center">
          <svg width="54" height="54" viewBox="0 0 54 54" xmlns="http://www.w3.org/2000/svg"
            overflow="visible"
            style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.7))' }}>
            <circle cx="27" cy="27" r="23" fill="white" />
            <circle cx="27" cy="27" r="23" fill="none" stroke="#cc0000" strokeWidth="7" />
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
