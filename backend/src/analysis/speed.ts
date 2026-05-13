import { applyHomography } from './homography'

type Position = { wx: number; wy: number; timestamp: number }

export class SpeedCalculator {
  private history = new Map<number, Position[]>()
  private readonly smoothingWindow = 5

  constructor(
    private readonly homographyMatrix: number[],
    private readonly fps: number,
    private readonly maxSpeedKmh?: number,
  ) {}

  addPosition(vehicleId: number, px: number, py: number, timestamp: number): void {
    const world = applyHomography(this.homographyMatrix, px, py)
    const positions = this.history.get(vehicleId) ?? []
    positions.push({ ...world, timestamp })
    if (positions.length > this.smoothingWindow) positions.shift()
    this.history.set(vehicleId, positions)
  }

  getSpeed(vehicleId: number): number | null {
    const positions = this.history.get(vehicleId)
    if (!positions || positions.length < 2) return null

    const oldest = positions[0]
    const newest = positions[positions.length - 1]
    const dt = (newest.timestamp - oldest.timestamp) / 1000
    if (dt <= 0) return null

    const dx = newest.wx - oldest.wx
    const dy = newest.wy - oldest.wy
    return Math.sqrt(dx * dx + dy * dy) / dt * 3.6  // m/s → km/u
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
