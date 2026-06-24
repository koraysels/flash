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
    // Bottom-centre info bar, monospace, sized relative to frame height so it
    // stays readable after the downscale to 480p.
    const fs = Math.max(14, Math.round(img.height * 0.045))
    ctx.font = `bold ${fs}px monospace`
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
    // TODO: max-speed limit sign (red ring + limit number) top-right — needs
    // maxSpeedKmh threaded into this hud object from ai-worker.ts.
  }

  return canvas.toBuffer('image/jpeg', 80)
}
