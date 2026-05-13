import { describe, it, expect } from 'vitest'
import { Detector } from '../../src/ai/detector'
import { existsSync } from 'fs'
import { join } from 'path'

const MODEL_PATH = join(__dirname, '../../models/yolov8n.onnx')

describe.skipIf(!existsSync(MODEL_PATH))('Detector', () => {
  it('initializes and runs inference on a blank image', async () => {
    const detector = new Detector(MODEL_PATH)
    await detector.init()

    // 640x640 black RGB buffer
    const blankBuffer = Buffer.alloc(640 * 640 * 3, 0)
    const results = await detector.detect(blankBuffer, 640, 640)

    expect(Array.isArray(results)).toBe(true)
    for (const r of results) {
      expect(r).toHaveProperty('x1')
      expect(r).toHaveProperty('y1')
      expect(r).toHaveProperty('x2')
      expect(r).toHaveProperty('y2')
      expect(r).toHaveProperty('confidence')
      expect(r).toHaveProperty('class')
    }
  }, 30000) // ONNX init can take a few seconds
})
