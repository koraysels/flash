type TrapEntry = {
  tA: number | null
  tB: number | null
  prevBelowA: boolean
  prevBelowB: boolean
  speed: number | null
}

const MIN_CROSSING_S = 0.3
const MAX_CROSSING_S = 30
const MAX_RECENT = 10

export type TrapMeasurement = { speedKmh: number; timestamp: number; isSpeeder: boolean }

/**
 * Measures vehicle speed by timing how long it takes to travel between two
 * counting lines. Speed is null until both lines are crossed; it then locks in
 * permanently for that track ID (like a real trajectcontrole measurement).
 */
export class TrapSpeedCalculator {
  private entries = new Map<number, TrapEntry>()
  private recent: TrapMeasurement[] = []

  constructor(
    private readonly lineDistanceM: number,
    private readonly maxSpeedKmh?: number,
    private readonly plausibilityKmh: number = 170,
  ) {}

  update(id: number, ny: number, lineAY: number, lineBY: number, timestamp: number): void {
    const belowA = ny > lineAY
    const belowB = ny > lineBY
    const entry = this.entries.get(id)

    if (!entry) {
      // If the vehicle first appears BETWEEN the lines, it's already past the first line.
      // Use the current timestamp as an approximation of the first crossing so we can
      // still measure the time to the second line — better than no measurement at all.
      const betweenLines = belowA !== belowB
      this.entries.set(id, {
        tA: betweenLines ? timestamp : null,
        tB: null,
        prevBelowA: belowA,
        prevBelowB: belowB,
        speed: null,
      })
      return
    }

    if (entry.speed !== null) return

    if (belowA !== entry.prevBelowA) { entry.tA = timestamp; entry.prevBelowA = belowA }
    if (belowB !== entry.prevBelowB) { entry.tB = timestamp; entry.prevBelowB = belowB }

    if (entry.tA !== null && entry.tB !== null) {
      const dtS = Math.abs(entry.tB - entry.tA) / 1000
      if (dtS >= MIN_CROSSING_S && dtS <= MAX_CROSSING_S) {
        const speedKmh = (this.lineDistanceM / dtS) * 3.6
        if (speedKmh > this.plausibilityKmh) return
        entry.speed = speedKmh
        this.recent.push({ speedKmh, timestamp, isSpeeder: this.maxSpeedKmh !== undefined && speedKmh > this.maxSpeedKmh })
        if (this.recent.length > MAX_RECENT) this.recent.shift()
      }
    }
  }

  getSpeed(id: number): number | null {
    return this.entries.get(id)?.speed ?? null
  }

  isSpeeder(id: number): boolean {
    if (this.maxSpeedKmh === undefined) return false
    const speed = this.getSpeed(id)
    return speed !== null && speed > this.maxSpeedKmh
  }

  getRecentMeasurements(): TrapMeasurement[] {
    return [...this.recent].reverse()  // most recent first
  }

  removeVehicle(id: number): void {
    this.entries.delete(id)
  }

  reset(): void {
    this.entries.clear()
    this.recent = []
  }
}
