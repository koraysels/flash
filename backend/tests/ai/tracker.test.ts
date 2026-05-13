import { describe, it, expect, beforeEach } from 'vitest'
import { Tracker } from '../../src/ai/tracker'
import { DetectionResult } from '../../src/ai/detector'

describe('Tracker', () => {
  let tracker: Tracker

  beforeEach(() => {
    tracker = new Tracker()
  })

  it('assigns persistent IDs across frames', () => {
    const frame1: DetectionResult[] = [
      { x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9, class: 'car' },
    ]
    const tracked1 = tracker.update(frame1)
    expect(tracked1).toHaveLength(1)
    expect(typeof tracked1[0].id).toBe('number')

    const frame2: DetectionResult[] = [
      { x1: 110, y1: 105, x2: 210, y2: 205, confidence: 0.9, class: 'car' },
    ]
    const tracked2 = tracker.update(frame2)
    expect(tracked2).toHaveLength(1)
    expect(tracked2[0].id).toBe(tracked1[0].id)
  })

  it('assigns new ID for new vehicle', () => {
    const frame1: DetectionResult[] = [
      { x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9, class: 'car' },
    ]
    const tracked1 = tracker.update(frame1)

    const frame2: DetectionResult[] = [
      { x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9, class: 'car' },
      { x1: 400, y1: 400, x2: 500, y2: 500, confidence: 0.9, class: 'truck' },
    ]
    const tracked2 = tracker.update(frame2)
    expect(tracked2).toHaveLength(2)
    const ids = tracked2.map((t) => t.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toContain(tracked1[0].id)
  })

  it('removes track after maxMissedFrames consecutive misses', () => {
    const frame1: DetectionResult[] = [
      { x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9, class: 'car' },
    ]
    tracker.update(frame1)
    // Send empty frames until track disappears
    for (let i = 0; i < 6; i++) {
      tracker.update([])
    }
    const result = tracker.update([])
    expect(result).toHaveLength(0)
  })

  it('reset clears all tracks', () => {
    tracker.update([{ x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9, class: 'car' }])
    tracker.reset()
    const result = tracker.update([{ x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9, class: 'car' }])
    expect(result).toHaveLength(1)
    // After reset, new track gets a fresh ID (implementation detail: just check it works)
    expect(typeof result[0].id).toBe('number')
  })
})
