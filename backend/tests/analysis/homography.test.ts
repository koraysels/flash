import { describe, it, expect } from 'vitest'
import { computeHomography, applyHomography, latlngToMeters } from '../../src/analysis/homography'

describe('computeHomography', () => {
  it('computes H that maps image points to world points (scale transform)', () => {
    // Image 100x100px maps to 10x10m world
    const pairs = [
      { px: 0,   py: 0,   wx: 0,  wy: 0  },
      { px: 100, py: 0,   wx: 10, wy: 0  },
      { px: 100, py: 100, wx: 10, wy: 10 },
      { px: 0,   py: 100, wx: 0,  wy: 10 },
    ]
    const H = computeHomography(pairs)
    expect(H).toHaveLength(9)

    const result = applyHomography(H, 50, 50)
    expect(result.wx).toBeCloseTo(5, 0)
    expect(result.wy).toBeCloseTo(5, 0)
  })

  it('throws if fewer than 4 point pairs', () => {
    expect(() => computeHomography([
      { px: 0, py: 0, wx: 0, wy: 0 },
      { px: 1, py: 0, wx: 1, wy: 0 },
      { px: 1, py: 1, wx: 1, wy: 1 },
    ])).toThrow('At least 4 point pairs required')
  })
})

describe('latlngToMeters', () => {
  it('converts lat/lng offset to approximate meters', () => {
    // ~111km per degree latitude
    const result = latlngToMeters(50, 4, 50.001, 4)
    expect(result.wy).toBeCloseTo(111.2, 0) // ~111m per 0.001 degree
    expect(result.wx).toBeCloseTo(0, 1)
  })
})
