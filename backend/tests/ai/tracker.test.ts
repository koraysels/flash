import { describe, it, expect, beforeEach } from 'vitest'
import { Tracker } from '../../src/ai/tracker'
import { DetectionResult } from '../../src/ai/detector'

const car = (x1: number, y1: number): DetectionResult => ({
  x1, y1, x2: x1 + 100, y2: y1 + 100, confidence: 0.9, class: 'car',
})

describe('Tracker', () => {
  let tracker: Tracker

  beforeEach(() => {
    tracker = new Tracker()
  })

  it('assigns persistent IDs across frames (confirmed after 2 frames)', () => {
    // Frame 1 — track created but not yet confirmed
    tracker.update([car(100, 100)])

    // Frame 2 — same vehicle, now confirmed; ID is stable
    const tracked2 = tracker.update([car(110, 105)])
    expect(tracked2).toHaveLength(1)
    expect(typeof tracked2[0].id).toBe('number')

    // Frame 3 — ID persists
    const tracked3 = tracker.update([car(120, 110)])
    expect(tracked3).toHaveLength(1)
    expect(tracked3[0].id).toBe(tracked2[0].id)
  })

  it('suppresses single-frame ghost detections', () => {
    // Only one frame — not yet confirmed, should not be reported
    const result = tracker.update([car(100, 100)])
    expect(result).toHaveLength(0)
  })

  it('assigns new ID for new vehicle after confirmation', () => {
    // Confirm the first vehicle across 2 frames
    tracker.update([car(100, 100)])
    const confirmed1 = tracker.update([car(100, 100)])
    expect(confirmed1).toHaveLength(1)

    // New vehicle appears alongside the confirmed one
    tracker.update([car(100, 100), car(400, 400)])
    const confirmed2 = tracker.update([car(100, 100), car(400, 400)])
    expect(confirmed2).toHaveLength(2)
    const ids = confirmed2.map((t) => t.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toContain(confirmed1[0].id)
  })

  it('removes track after maxMissedFrames consecutive misses', () => {
    // Confirm the track first
    tracker.update([car(100, 100)])
    tracker.update([car(100, 100)])

    // Miss enough frames to expire the track
    for (let i = 0; i < 9; i++) tracker.update([])

    expect(tracker.update([])).toHaveLength(0)
  })

  it('reset clears all tracks', () => {
    tracker.update([car(100, 100)])
    tracker.update([car(100, 100)])  // confirm
    tracker.reset()

    // After reset, new track needs 2 frames again
    tracker.update([car(100, 100)])
    const result = tracker.update([car(100, 100)])
    expect(result).toHaveLength(1)
    expect(typeof result[0].id).toBe('number')
  })
})
