import { describe, it, expect } from 'vitest'
import { DirectionCounter } from '../../src/analysis/counter'

describe('DirectionCounter', () => {
  it('counts AB crossing when vehicle moves downward past lineB', () => {
    // Frame 100px tall, lineA at 40% (y=40), lineB at 60% (y=60)
    const counter = new DirectionCounter(100, 0.4, 0.6)

    // Vehicle moves from y=30 to y=70 (crosses lineA then lineB downward = A→B)
    counter.updateVehicle(1, 30)
    counter.updateVehicle(1, 50)
    counter.updateVehicle(1, 70)

    expect(counter.getCounts()).toEqual({ AB: 1, BA: 0 })
  })

  it('counts BA crossing when vehicle moves upward past lineA', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)

    counter.updateVehicle(2, 70)
    counter.updateVehicle(2, 50)
    counter.updateVehicle(2, 30)

    expect(counter.getCounts()).toEqual({ AB: 0, BA: 1 })
  })

  it('does not double-count the same vehicle', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)

    // Pass through multiple times in same direction — should only count once per crossing
    counter.updateVehicle(3, 30)
    counter.updateVehicle(3, 50)
    counter.updateVehicle(3, 70)
    counter.updateVehicle(3, 80) // continues past lineB — no second count

    expect(counter.getCounts().AB).toBe(1)
  })

  it('resets counts', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)
    counter.updateVehicle(1, 30)
    counter.updateVehicle(1, 70)
    counter.reset()
    expect(counter.getCounts()).toEqual({ AB: 0, BA: 0 })
  })

  it('removeVehicle cleans up state', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)
    counter.updateVehicle(5, 30)
    counter.removeVehicle(5)
    // After removal, re-adding same ID starts fresh
    counter.updateVehicle(5, 30)
    counter.updateVehicle(5, 70)
    expect(counter.getCounts().AB).toBe(1)
  })
})
