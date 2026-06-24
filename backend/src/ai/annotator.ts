import { createCanvas, loadImage } from '@napi-rs/canvas'
import { TrackedVehicle } from './tracker'

const CLASS_COLORS: Record<string, string> = {
  car: '#3b82f6',
  truck: '#f59e0b',
  bus: '#10b981',
  motorcycle: '#8b5cf6',
}

export async function annotateFrame(
  jpegBuffer: Buffer,
  vehicles: TrackedVehicle[],
  lineAFraction: number,
  lineBFraction: number,
  hud?: { ab: number; ba: number; speeders: number },
): Promise<Buffer> {
  const img = await loadImage(jpegBuffer)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')

  ctx.drawImage(img, 0, 0)

  // Draw counting lines
  const lineAY = img.height * lineAFraction
  const lineBY = img.height * lineBFraction

  ctx.strokeStyle = 'rgba(255,255,0,0.6)'
  ctx.lineWidth = 2
  ctx.setLineDash([8, 4])
  ctx.beginPath()
  ctx.moveTo(0, lineAY)
  ctx.lineTo(img.width, lineAY)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(0, lineBY)
  ctx.lineTo(img.width, lineBY)
  ctx.stroke()
  ctx.setLineDash([])

  // Draw bounding boxes and labels
  for (const v of vehicles) {
    const color = CLASS_COLORS[v.class] ?? '#ffffff'
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.strokeRect(v.x1, v.y1, v.x2 - v.x1, v.y2 - v.y1)

    const label = `#${v.id} ${v.class}`
    ctx.font = '12px monospace'
    const labelWidth = ctx.measureText(label).width + 8
    ctx.fillStyle = color
    const labelY = Math.max(18, v.y1)
    ctx.fillRect(v.x1, labelY - 18, labelWidth, 18)
    ctx.fillStyle = '#000000'
    ctx.fillText(label, v.x1 + 4, labelY - 4)
  }

  if (hud) {
    // TODO: rename the "spd" HUD label to "FLASH" (speeders = flashes fired)
    const text = `A→B ${hud.ab}   B→A ${hud.ba}   spd ${hud.speeders}`
    ctx.font = 'bold 16px sans-serif'
    const w = ctx.measureText(text).width + 16
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(8, 8, w, 26)
    ctx.fillStyle = '#fff'
    ctx.fillText(text, 16, 26)
    // TODO: draw a max-speed limit sign (red ring + bold limit number) in the
    // TOP-RIGHT corner. Needs maxSpeedKmh threaded into this hud object: add
    // `maxSpeedKmh: number | null` to the hud param, pass it from ai-worker.ts
    // (it has maxSpeedKmh in WorkerInitData), and skip drawing when null.
  }

  return canvas.toBuffer('image/jpeg', 80)
}
