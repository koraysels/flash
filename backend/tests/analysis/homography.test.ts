import { describe, it, expect } from 'vitest'
import { computeHomography, applyHomography, latlngToMeters, reprojectionError, scaleHomography } from '../../src/analysis/homography'

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

describe('reprojectionError', () => {
  it('reports near-zero error for an exact 4-point calibration', () => {
    const pairs = [
      { px: 0,   py: 0,   wx: 0,  wy: 0  },
      { px: 100, py: 0,   wx: 10, wy: 0  },
      { px: 100, py: 100, wx: 10, wy: 10 },
      { px: 0,   py: 100, wx: 0,  wy: 10 },
    ]
    const H = computeHomography(pairs)
    const err = reprojectionError(H, pairs)
    expect(err.perPointM).toHaveLength(4)
    expect(err.rmsM).toBeLessThan(0.01)
    expect(err.maxM).toBeLessThan(0.01)
  })

  it('reports the residual for an inconsistent (overdetermined) calibration', () => {
    // 5th point deliberately off by 2 m — least squares cannot fit all 5 exactly
    const pairs = [
      { px: 0,   py: 0,   wx: 0,  wy: 0  },
      { px: 100, py: 0,   wx: 10, wy: 0  },
      { px: 100, py: 100, wx: 10, wy: 10 },
      { px: 0,   py: 100, wx: 0,  wy: 10 },
      { px: 50,  py: 50,  wx: 5,  wy: 7  },
    ]
    const H = computeHomography(pairs)
    const err = reprojectionError(H, pairs)
    expect(err.maxM).toBeGreaterThan(0.5)
  })
})

describe('scaleHomography', () => {
  it('adapts a homography calibrated at one resolution to another', () => {
    // Calibrated at 100x100: pixel (100,100) → world (10,10)
    const pairs = [
      { px: 0,   py: 0,   wx: 0,  wy: 0  },
      { px: 100, py: 0,   wx: 10, wy: 0  },
      { px: 100, py: 100, wx: 10, wy: 10 },
      { px: 0,   py: 100, wx: 0,  wy: 10 },
    ]
    const H = computeHomography(pairs)

    // Frame is now 200x200 — the same scene point sits at pixel (200,200)
    const H2 = scaleHomography(H, 100, 100, 200, 200)
    const result = applyHomography(H2, 200, 200)
    expect(result.wx).toBeCloseTo(10, 1)
    expect(result.wy).toBeCloseTo(10, 1)
  })

  it('returns the same matrix when dimensions are unchanged', () => {
    const H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1]
    expect(scaleHomography(H, 768, 576, 768, 576)).toEqual(H)
  })
})
