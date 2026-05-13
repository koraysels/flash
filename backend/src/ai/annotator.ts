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
    const labelWidth = ctx.measureText(label).width + 8
    ctx.fillStyle = color
    ctx.fillRect(v.x1, v.y1 - 18, labelWidth, 18)
    ctx.fillStyle = '#000000'
    ctx.font = '12px monospace'
    ctx.fillText(label, v.x1 + 4, v.y1 - 4)
  }

  return canvas.toBuffer('image/jpeg', 80)
}
