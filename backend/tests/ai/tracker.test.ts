import { describe, it, expect, beforeEach } from 'vitest'
import { Tracker, KF2D } from '../../src/ai/tracker'
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

    // Miss enough frames that the track is no longer emitted
    for (let i = 0; i < 13; i++) tracker.update([])

    expect(tracker.update([])).toHaveLength(0)
  })

  it('keeps a confirmed track visible for short detector dropouts', () => {
    tracker.update([car(100, 100)])
    const confirmed = tracker.update([car(110, 100)])
    expect(confirmed).toHaveLength(1)

    const missed1 = tracker.update([])
    expect(missed1).toHaveLength(1)
    expect(missed1[0].id).toBe(confirmed[0].id)
    expect(missed1[0].isPredicted).toBe(true)

    const recovered = tracker.update([car(130, 100)])
    expect(recovered).toHaveLength(1)
    expect(recovered[0].id).toBe(confirmed[0].id)
    expect(recovered[0].isPredicted).toBe(false)
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

  it('does not swap IDs when two vehicles move in opposite directions', () => {
    const localTracker = new Tracker({ iouStage1: 0.05 })
    const t = [0, 200, 400, 600, 800]

    localTracker.update([car(100, 300), car(400, 300)], t[0])
    const frame2 = localTracker.update([car(110, 300), car(390, 300)], t[1])
    expect(frame2).toHaveLength(2)
    const idA = frame2.find(v => v.cx < 250)!.id
    const idB = frame2.find(v => v.cx >= 250)!.id

    localTracker.update([car(200, 300), car(300, 300)], t[2])
    localTracker.update([car(280, 300), car(220, 300)], t[3])

    const frame5 = localTracker.update([car(350, 300), car(150, 300)], t[4])
    expect(frame5).toHaveLength(2)

    const rightTrack = frame5.find(v => v.cx > 250)
    const leftTrack  = frame5.find(v => v.cx <= 250)
    expect(rightTrack?.id).toBe(idA)
    expect(leftTrack?.id).toBe(idB)
  })

  it('uses only IoU when track velocity is below threshold', () => {
    // Track with low velocity (< VEL_MAG_THRESHOLD = 20 px/s)
    // Direction score should be neutral (0.5) and not affect outcome
    const localTracker = new Tracker()
    // Frame 1 & 2: confirm a slow-moving track (1px per 200ms = 5 px/s)
    localTracker.update([car(100, 100)], 0)
    const confirmed = localTracker.update([car(101, 100)], 200)
    expect(confirmed).toHaveLength(1)
    const id = confirmed[0].id

    // Frame 3: detection is slightly off in an unexpected direction — should still match
    // because direction score is neutral at low speed
    const frame3 = localTracker.update([car(99, 100)], 400)
    expect(frame3).toHaveLength(1)
    expect(frame3[0].id).toBe(id)
  })
})

describe('KF2D', () => {
  it('initialises with zero velocity', () => {
    const kf = new KF2D(100, 200, 1.0, 0.05)
    expect(kf.cx).toBe(100)
    expect(kf.cy).toBe(200)
    expect(kf.vx).toBe(0)
    expect(kf.vy).toBe(0)
    expect(kf.velMag()).toBe(0)
  })

  it('predict moves position by velocity * dt', () => {
    const kf = new KF2D(100, 200, 1.0, 0.05)
    kf.update(150, 200, 4)
    kf.predict(1.0)
    expect(kf.cx).toBeGreaterThan(140)
  })

  it('velMag returns correct magnitude', () => {
    const kf = new KF2D(0, 0, 1.0, 0.05)
    kf.update(3, 4, 4)
    kf.predict(1.0)
    kf.update(6, 8, 4)
    kf.predict(1.0)
    kf.update(9, 12, 4)
    expect(kf.velMag()).toBeGreaterThan(0)
  })

  it('velAngle returns correct direction', () => {
    const kf = new KF2D(0, 0, 1.0, 0.05)
    for (let i = 1; i <= 5; i++) kf.update(i * 10, 0, 4)
    expect(Math.abs(kf.velAngle())).toBeLessThan(0.1)
  })
})

describe('Tracker class voting', () => {
  it('reports the majority class over matched detections, not the first one', () => {
    const tracker = new Tracker()
    const det = (cls: string): DetectionResult => ({
      x1: 100, y1: 100, x2: 200, y2: 200, confidence: 0.9, class: cls,
    })

    // First detection misclassified as van, then consistently car
    tracker.update([det('van')])
    tracker.update([det('car')])
    tracker.update([det('car')])
    const tracked = tracker.update([det('car')])

    expect(tracked).toHaveLength(1)
    expect(tracked[0].class).toBe('car')
  })
})
