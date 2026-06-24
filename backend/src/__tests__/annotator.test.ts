import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { annotateFrame } from '../ai/annotator'

// A tiny valid JPEG fixture already used elsewhere, or generate one with canvas.
import { createCanvas } from '@napi-rs/canvas'

function makeJpeg(w: number, h: number): Buffer {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#222'
  ctx.fillRect(0, 0, w, h)
  return c.toBuffer('image/jpeg')
}

describe('annotateFrame', () => {
  it('returns a JPEG larger than 0 bytes with HUD enabled', async () => {
    const src = makeJpeg(640, 480)
    const out = await annotateFrame(
      src,
      [{ id: 1, class: 'car', x1: 10, y1: 10, x2: 100, y2: 80 } as any],
      0.4,
      0.6,
      { ab: 3, ba: 5, speeders: 1 },
    )
    expect(Buffer.isBuffer(out)).toBe(true)
    expect(out.length).toBeGreaterThan(0)
    // JPEG SOI marker
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
  })

  it('works without HUD arg (backward compatible)', async () => {
    const src = makeJpeg(320, 240)
    const out = await annotateFrame(src, [], 0.4, 0.6)
    expect(out.length).toBeGreaterThan(0)
  })
})
