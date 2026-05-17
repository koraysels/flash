import { describe, it, expect } from 'vitest'
import { DirectionCounter } from '../../src/analysis/counter'

// Helpers: frame is normalised to [0,1]; old tests used pixel values in a
// 100px frame, so ny = pixel / 100. Lines are horizontal so nx doesn't matter.
const move = (counter: DirectionCounter, id: number, ...ys: number[]) =>
  ys.forEach((y) => counter.updateVehicle(id, 0.5, y / 100))

describe('DirectionCounter', () => {
  it('counts AB crossing when vehicle moves downward past lineB', () => {
    // Frame normalised; lineA at 40%, lineB at 60%
    const counter = new DirectionCounter(100, 0.4, 0.6)
    move(counter, 1, 30, 50, 70)
    expect(counter.getCounts()).toEqual({ AB: 1, BA: 0 })
  })

  it('counts BA crossing when vehicle moves upward past lineA', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)
    move(counter, 2, 70, 50, 30)
    expect(counter.getCounts()).toEqual({ AB: 0, BA: 1 })
  })

  it('does not double-count the same vehicle', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)
    move(counter, 3, 30, 50, 70, 80)
    expect(counter.getCounts().AB).toBe(1)
  })

  it('resets counts', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)
    move(counter, 1, 30, 70)
    counter.reset()
    expect(counter.getCounts()).toEqual({ AB: 0, BA: 0 })
  })

  it('removeVehicle cleans up state', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)
    move(counter, 5, 30)
    counter.removeVehicle(5)
    move(counter, 5, 30, 70)
    expect(counter.getCounts().AB).toBe(1)
  })

  it('counts correctly when vehicle crosses AB then reverses to BA', () => {
    const counter = new DirectionCounter(100, 0.4, 0.6)
    move(counter, 6, 10, 45, 70)
    expect(counter.getCounts()).toEqual({ AB: 1, BA: 0 })
    move(counter, 6, 50, 35)
    expect(counter.getCounts()).toEqual({ AB: 1, BA: 1 })
  })
})
