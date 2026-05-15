import { applyHomography } from './homography'

type Position = { wx: number; wy: number; timestamp: number }

export class SpeedCalculator {
  private history = new Map<number, Position[]>()
  private readonly maxHistory = 12

  constructor(
    private readonly homographyMatrix: number[],
    private readonly fps: number,
    private readonly maxSpeedKmh?: number,
  ) {}

  /** px, py should be the bottom-center of the bounding box (ground contact point) */
  addPosition(vehicleId: number, px: number, py: number, timestamp: number): void {
    const world = applyHomography(this.homographyMatrix, px, py)
    const positions = this.history.get(vehicleId) ?? []

    // EMA on world position to dampen homography projection noise
    if (positions.length > 0) {
      const last = positions[positions.length - 1]
      world.wx = 0.65 * world.wx + 0.35 * last.wx
      world.wy = 0.65 * world.wy + 0.35 * last.wy
    }

    positions.push({ ...world, timestamp })
    if (positions.length > this.maxHistory) positions.shift()
    this.history.set(vehicleId, positions)
  }

  getSpeed(vehicleId: number): number | null {
    const positions = this.history.get(vehicleId)
    if (!positions || positions.length < 2) return null

    // Compute instant speed for each consecutive pair, then take the median.
    // Median is robust to single-frame projection outliers.
    const instantSpeeds: number[] = []
    for (let i = 1; i < positions.length; i++) {
      const dt = (positions[i].timestamp - positions[i - 1].timestamp) / 1000
      if (dt <= 0) continue
      const dx = positions[i].wx - positions[i - 1].wx
      const dy = positions[i].wy - positions[i - 1].wy
      instantSpeeds.push(Math.sqrt(dx * dx + dy * dy) / dt * 3.6)
    }

    if (instantSpeeds.length === 0) return null
    instantSpeeds.sort((a, b) => a - b)
    return instantSpeeds[Math.floor(instantSpeeds.length / 2)]
  }

  isSpeeder(vehicleId: number): boolean {
    if (this.maxSpeedKmh === undefined) return false
    const speed = this.getSpeed(vehicleId)
    return speed !== null && speed > this.maxSpeedKmh
  }

  removeVehicle(vehicleId: number): void {
    this.history.delete(vehicleId)
  }
}
