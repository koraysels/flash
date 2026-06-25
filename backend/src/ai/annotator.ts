import { createCanvas, GlobalFonts, type Canvas, type Image } from '@napi-rs/canvas'
import { existsSync } from 'fs'
import { TrackedVehicle } from './tracker'

// The container has no system fonts, so the generic "monospace" family doesn't
// resolve. Register DejaVu Sans Mono (apt fonts-dejavu-core) and use it by name.
const MONO = 'DejaVu Sans Mono'
const MONO_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
if (existsSync(MONO_PATH)) GlobalFonts.registerFromPath(MONO_PATH, MONO)

// Sans-serif for the speed-limit sign (real road signs are sans, not mono).
const SANS = 'DejaVu Sans'
const SANS_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
if (existsSync(SANS_PATH)) GlobalFonts.registerFromPath(SANS_PATH, SANS)

// Speed-limit sign is rendered ONCE per limit value into an offscreen canvas and
// cached; each frame just composites it with drawImage (no per-frame redraw).
const signCache = new Map<number, Canvas>()
function getSpeedSign(limit: number): Canvas {
  const cached = signCache.get(limit)
  if (cached) return cached
  const S = 200
  const c = createCanvas(S, S)
  const g = c.getContext('2d')
  const cx = S / 2, cy = S / 2, r = S / 2 - 4
  const ring = Math.round(r * 0.18)
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill()
  g.lineWidth = ring; g.strokeStyle = '#d11414'
  g.beginPath(); g.arc(cx, cy, r - ring / 2, 0, Math.PI * 2); g.stroke()
  g.fillStyle = '#000000'
  g.font = `bold ${Math.round(r * 0.85)}px "${SANS}", sans-serif`
  g.textAlign = 'center'; g.textBaseline = 'middle'
  g.fillText(String(limit), cx, cy + Math.round(r * 0.06))
  signCache.set(limit, c)
  return c
}

const CLASS_COLORS: Record<string, string> = {
  car: '#3b82f6',
  truck: '#f59e0b',
  bus: '#10b981',
  motorcycle: '#8b5cf6',
}

export function annotateFrame(
  img: Image,
  vehicles: TrackedVehicle[],
  lineAFraction: number,
  lineBFraction: number,
  hud?: { ab: number; ba: number; speeders: number; maxSpeedKmh?: number | null },
  lineAPoints?: number[],
  lineBPoints?: number[],
  speederIds?: Set<number>,
): Buffer {
  // img is the already-decoded frame from the worker — no second JPEG decode here.
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')

  ctx.drawImage(img, 0, 0)

  // Draw counting lines — use the angled 4-point spec ([x1,y1,x2,y2] normalised)
  // when present (matches the calibration/homography), else a horizontal fallback
  // at the scalar fraction.
  const drawLine = (pts: number[] | undefined, frac: number): void => {
    ctx.beginPath()
    if (pts && pts.length === 4) {
      ctx.moveTo(pts[0] * img.width, pts[1] * img.height)
      ctx.lineTo(pts[2] * img.width, pts[3] * img.height)
    } else {
      const y = img.height * frac
      ctx.moveTo(0, y)
      ctx.lineTo(img.width, y)
    }
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(255,255,0,0.6)'
  ctx.lineWidth = 2
  ctx.setLineDash([8, 4])
  drawLine(lineAPoints, lineAFraction)
  drawLine(lineBPoints, lineBFraction)
  ctx.setLineDash([])

  // Draw bounding boxes and labels
  for (const v of vehicles) {
    // Guard: never draw a box with non-finite coords (a coasted Kalman track can
    // in theory blow up) — that would throw and freeze the whole stream.
    if (!Number.isFinite(v.x1) || !Number.isFinite(v.y1) || !Number.isFinite(v.x2) || !Number.isFinite(v.y2)) continue

    const color = CLASS_COLORS[v.class] ?? '#ffffff'
    // Offender: strobe a red fill (~1.7 Hz) for as long as it's in frame.
    if (speederIds?.has(v.id) && Date.now() % 600 < 300) {
      ctx.fillStyle = 'rgba(255,0,0,0.5)'
      ctx.fillRect(v.x1, v.y1, v.x2 - v.x1, v.y2 - v.y1)
    }
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    // Coasted (predicted) boxes get a dashed outline so a bridged detector gap
    // reads as a prediction, not a fresh detection.
    ctx.setLineDash(v.isPredicted ? [6, 4] : [])
    ctx.strokeRect(v.x1, v.y1, v.x2 - v.x1, v.y2 - v.y1)
    ctx.setLineDash([])

    // Short display id (rotates 000-999) — the full numeric id stays internal /
    // in MQTT for dedupe. Class is conveyed by the box colour, so no class text.
    const label = `#${String(v.id % 1000).padStart(3, '0')}`
    ctx.font = '12px monospace'
    const labelWidth = ctx.measureText(label).width + 8
    ctx.fillStyle = color
    const labelY = Math.max(18, v.y1)
    ctx.fillRect(v.x1, labelY - 18, labelWidth, 18)
    ctx.fillStyle = '#000000'
    ctx.fillText(label, v.x1 + 4, labelY - 4)
  }

  if (hud) {
    // Bottom-centre info bar, monospace, sized relative to frame height so it
    // stays readable after the downscale to 480p.
    const fs = Math.max(14, Math.round(img.height * 0.045))
    ctx.font = `bold ${fs}px "${MONO}", monospace`
    const text = `A→B ${hud.ab}   B→A ${hud.ba}   FLASH ${hud.speeders}`
    const padX = fs, padY = Math.round(fs * 0.4)
    const tw = ctx.measureText(text).width
    const barW = tw + padX, barH = fs + padY * 2
    const barX = Math.round((img.width - barW) / 2)
    const barY = img.height - barH - Math.round(fs * 0.5)
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(barX, barY, barW, barH)
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'top'
    ctx.fillText(text, barX + padX / 2, barY + padY)

    // Speed-limit sign top-right — cached canvas, just composited here.
    if (hud.maxSpeedKmh) {
      const size = Math.round(img.height * 0.15)
      const m = Math.round(img.height * 0.03)
      ctx.drawImage(getSpeedSign(hud.maxSpeedKmh), img.width - size - m, m, size, size)
    }
  }

  return canvas.toBuffer('image/jpeg', 80)
}
