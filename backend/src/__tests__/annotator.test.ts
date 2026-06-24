import { describe, it, expect } from 'vitest'
import { annotateFrame } from '../ai/annotator'
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas'

async function makeImage(w: number, h: number): Promise<Image> {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#222'
  ctx.fillRect(0, 0, w, h)
  return loadImage(c.toBuffer('image/jpeg'))
}

describe('annotateFrame', () => {
  it('returns a JPEG larger than 0 bytes with HUD enabled', async () => {
    const img = await makeImage(640, 480)
    const out = annotateFrame(
      img,
      [{ id: 1, class: 'car', x1: 10, y1: 10, x2: 100, y2: 80 } as any],
      0.4,
      0.6,
      { ab: 3, ba: 5, speeders: 1, maxSpeedKmh: 120 },
    )
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]).toBe(0xff)   // JPEG SOI
    expect(out[1]).toBe(0xd8)
  })

  it('draws angled counting lines from the 4-point spec without throwing', async () => {
    const img = await makeImage(768, 576)
    const out = annotateFrame(
      img, [], 0.4, 0.6,
      { ab: 0, ba: 0, speeders: 0, maxSpeedKmh: null },
      [0, 0.45, 1, 0.55],   // angled line A
      [0, 0.65, 1, 0.72],   // angled line B
    )
    expect(out.length).toBeGreaterThan(0)
  })
})
