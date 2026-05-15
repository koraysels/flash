import { describe, it, expect } from 'vitest'
import { Detector } from '../../src/ai/detector'
import { existsSync } from 'fs'
import { join } from 'path'

const MODEL_PATH = join(__dirname, '../../models/yolov8n.onnx')

describe.skipIf(!existsSync(MODEL_PATH))('Detector', () => {
  it('initializes and runs inference on a blank letterboxed frame', async () => {
    const detector = new Detector(MODEL_PATH)
    await detector.init()

    // 640×640 blank RGBA (simulates a letterboxed frame with no padding)
    const blankRgba = new Uint8ClampedArray(640 * 640 * 4).fill(128)
    const results = await detector.detect(blankRgba, 0, 0, 1.0, 640, 640)

    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(0) // blank frame should produce no detections
    for (const r of results) {
      expect(r).toHaveProperty('x1')
      expect(r).toHaveProperty('y1')
      expect(r).toHaveProperty('x2')
      expect(r).toHaveProperty('y2')
      expect(r).toHaveProperty('confidence')
      expect(r).toHaveProperty('class')
    }

    await detector.dispose()
  }, 30000)
})
