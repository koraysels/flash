import { applyHomography } from './homography'

type Position = { wx: number; wy: number; timestamp: number }

const EMA_ALPHA           = 0.3    // world-position smoothing — low = smooth but laggier
const MIN_DT_S            = 0.04   // ignore pairs < 40 ms apart (KF update noise)
const MAX_SPEED_KMH       = 200    // discard outliers above this
const MAX_HISTORY         = 12

export class SpeedCalculator {
  private history = new Map<number, Position[]>()

  constructor(
    private readonly homographyMatrix: number[],
    private readonly maxSpeedKmh?: number,
  ) {}

  /** px, py should be the bottom-center of the bounding box (ground contact point) */
  addPosition(vehicleId: number, px: number, py: number, timestamp: number): void {
    const world     = applyHomography(this.homographyMatrix, px, py)
    const positions = this.history.get(vehicleId) ?? []

    // EMA on world-space position before storing.
    // Homography is non-linear, so pixel-space KF smoothing doesn't eliminate
    // world-space jitter — a separate EMA here is necessary.
    if (positions.length > 0) {
      const last = positions[positions.length - 1]
      world.wx = EMA_ALPHA * world.wx + (1 - EMA_ALPHA) * last.wx
      world.wy = EMA_ALPHA * world.wy + (1 - EMA_ALPHA) * last.wy
    }

    positions.push({ ...world, timestamp })
    if (positions.length > MAX_HISTORY) positions.shift()
    this.history.set(vehicleId, positions)
  }

  getSpeed(vehicleId: number): number | null {
    const positions = this.history.get(vehicleId)
    if (!positions || positions.length < 2) return null

    const instantSpeeds: number[] = []
    for (let i = 1; i < positions.length; i++) {
      const dt = (positions[i].timestamp - positions[i - 1].timestamp) / 1000
      if (dt < MIN_DT_S) continue   // too close together — unreliable

      const dx = positions[i].wx - positions[i - 1].wx
      const dy = positions[i].wy - positions[i - 1].wy
      const kmh = (Math.sqrt(dx * dx + dy * dy) / dt) * 3.6
      if (kmh > MAX_SPEED_KMH) continue   // outlier — KF bbox glitch or bad homography

      instantSpeeds.push(kmh)
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
