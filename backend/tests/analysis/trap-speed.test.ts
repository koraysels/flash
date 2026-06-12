import { describe, it, expect } from 'vitest'
import { TrapSpeedCalculator } from '../../src/analysis/trap-speed'

// Pixel → world scale: 0.05 m/px, no rotation/perspective
const H_SCALE = [0.05, 0, 0, 0, 0.05, 0, 0, 0, 1]

const FRAME_H = 600
const LINE_A = 0.4   // py 240
const LINE_B = 0.55  // py 330

const ny = (py: number) => py / FRAME_H

describe('TrapSpeedCalculator', () => {
  it('interpolates crossing times between frames (sub-frame timing)', () => {
    // Vehicle moves straight down 60 px per 400 ms (150 px/s = 7.5 m/s).
    // Line A (py 240) is crossed at t=66.7ms, line B (py 330) at t=666.7ms
    // → true dt 0.6 s over 90 px = 4.5 m → 7.5 m/s = 27 km/h.
    // Naive first-frame-below timing would give dt 0.4 s → 40.5 km/h.
    const calc = new TrapSpeedCalculator(H_SCALE)
    const pys = [230, 290, 350, 410]
    pys.forEach((py, i) => calc.update(1, 100, py, ny(py), LINE_A, LINE_B, i * 400))

    const speed = calc.getSpeed(1)
    expect(speed).not.toBeNull()
    expect(speed!).toBeCloseTo(27, 0)
  })

  it('measures the actual travelled path, not the vertical line gap (diagonal motion)', () => {
    // Vehicle moves down 60 px AND right 80 px per 400 ms → path 100 px/frame.
    // Crossing A at (113.33, 240) t=66.7ms; crossing B at (233.33, 330) t=666.7ms.
    // World distance hypot(120, 90)·0.05 = 7.5 m over 0.6 s → 12.5 m/s = 45 km/h.
    const calc = new TrapSpeedCalculator(H_SCALE)
    const frames = [
      { px: 100, py: 230 },
      { px: 180, py: 290 },
      { px: 260, py: 350 },
      { px: 340, py: 410 },
    ]
    frames.forEach((f, i) => calc.update(1, f.px, f.py, ny(f.py), LINE_A, LINE_B, i * 400))

    const speed = calc.getSpeed(1)
    expect(speed).not.toBeNull()
    expect(speed!).toBeCloseTo(45, 0)
  })

  it('does not fabricate a first-line crossing for vehicles first seen between the lines', () => {
    const calc = new TrapSpeedCalculator(H_SCALE)
    // First observation already between A and B
    calc.update(1, 100, 300, ny(300), LINE_A, LINE_B, 0)
    calc.update(1, 100, 360, ny(360), LINE_A, LINE_B, 400)
    calc.update(1, 100, 420, ny(420), LINE_A, LINE_B, 800)

    expect(calc.getSpeed(1)).toBeNull()
  })

  it('reports direction BA for upward-moving vehicles', () => {
    const calc = new TrapSpeedCalculator(H_SCALE)
    const pys = [410, 350, 290, 230]
    pys.forEach((py, i) => calc.update(1, 100, py, ny(py), LINE_A, LINE_B, i * 400))

    expect(calc.getSpeed(1)).not.toBeNull()
    const recent = calc.getRecentMeasurements()
    expect(recent).toHaveLength(1)
    expect(recent[0].direction).toBe('BA')
  })

  it('rejects crossings faster than the minimum crossing time', () => {
    const calc = new TrapSpeedCalculator(H_SCALE)
    // Both lines crossed within 100 ms — below MIN_CROSSING_S
    calc.update(1, 100, 230, ny(230), LINE_A, LINE_B, 0)
    calc.update(1, 100, 410, ny(410), LINE_A, LINE_B, 100)

    expect(calc.getSpeed(1)).toBeNull()
  })

  it('rejects implausible speeds', () => {
    // 90 px gap = 4.5 m crossed in 0.35 s → ~46 km/h is fine, but with a
    // tiny plausibility cap the measurement must be discarded
    const calc = new TrapSpeedCalculator(H_SCALE, undefined, 10)
    const pys = [230, 290, 350, 410]
    pys.forEach((py, i) => calc.update(1, 100, py, ny(py), LINE_A, LINE_B, i * 400))

    expect(calc.getSpeed(1)).toBeNull()
  })

  it('locks the speed in permanently and flags speeders', () => {
    const calc = new TrapSpeedCalculator(H_SCALE, 20)
    const pys = [230, 290, 350, 410, 470]
    pys.forEach((py, i) => calc.update(1, 100, py, ny(py), LINE_A, LINE_B, i * 400))

    const speed = calc.getSpeed(1)
    expect(speed).toBeCloseTo(27, 0)
    expect(calc.isSpeeder(1)).toBe(true)

    // Further updates don't change the locked speed
    calc.update(1, 100, 530, ny(530), LINE_A, LINE_B, 2000)
    expect(calc.getSpeed(1)).toBe(speed)
  })
})
