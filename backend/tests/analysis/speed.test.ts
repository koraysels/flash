import { describe, it, expect } from 'vitest'
import { SpeedCalculator } from '../../src/analysis/speed'

describe('SpeedCalculator', () => {
  it('calculates speed from pixel trajectory via homography', () => {
    // H: 1px = 0.1m (scale-only: [[0.1,0,0],[0,0.1,0],[0,0,1]])
    const H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1]
    const calc = new SpeedCalculator(H, 2) // 2 fps

    const t0 = Date.now() - 500
    const t1 = Date.now()
    calc.addPosition(1, 0, 0, t0)
    calc.addPosition(1, 20, 0, t1)  // 20px = 2m in 0.5s = 4 m/s = 14.4 km/u

    const speed = calc.getSpeed(1)
    expect(speed).not.toBeNull()
    expect(speed!).toBeGreaterThan(0)
    expect(speed!).toBeLessThan(200)
  })

  it('returns null if fewer than 2 positions', () => {
    const H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1]
    const calc = new SpeedCalculator(H, 2)
    calc.addPosition(2, 0, 0, Date.now())
    expect(calc.getSpeed(2)).toBeNull()
  })

  it('detects speeders when speed exceeds maxSpeedKmh', () => {
    const H = [1, 0, 0, 0, 1, 0, 0, 0, 1]  // 1px = 1m
    const calc = new SpeedCalculator(H, 2, 10)  // maxSpeed = 10 km/u

    const t0 = Date.now() - 500
    const t1 = Date.now()
    calc.addPosition(3, 0, 0, t0)
    calc.addPosition(3, 100, 0, t1)  // 100m in 0.5s = 200m/s = 720 km/u → definitely a speeder

    expect(calc.isSpeeder(3)).toBe(true)
  })

  it('not a speeder if speed is under limit', () => {
    const H = [0.001, 0, 0, 0, 0.001, 0, 0, 0, 1]  // 1px = 1mm
    const calc = new SpeedCalculator(H, 2, 100)

    const t0 = Date.now() - 500
    const t1 = Date.now()
    calc.addPosition(4, 0, 0, t0)
    calc.addPosition(4, 5, 0, t1)  // 5mm in 0.5s = 0.01m/s = 0.036 km/u → way under 100

    expect(calc.isSpeeder(4)).toBe(false)
  })

  it('removeVehicle cleans up history', () => {
    const H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1]
    const calc = new SpeedCalculator(H, 2)
    calc.addPosition(5, 0, 0, Date.now())
    calc.removeVehicle(5)
    expect(calc.getSpeed(5)).toBeNull()
  })
})
