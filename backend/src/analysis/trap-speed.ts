import { applyHomography } from './homography'

type WorldPoint = { wx: number; wy: number }

type Crossing = { t: number; world: WorldPoint }

type TrapEntry = {
  crossA: Crossing | null
  crossB: Crossing | null
  prevBelowA: boolean
  prevBelowB: boolean
  prevPx: number
  prevPy: number
  prevNy: number
  prevTs: number
  seenOutside: boolean
  speed: number | null
}

const MIN_CROSSING_S = 0.3
const MAX_CROSSING_S = 30
const MAX_RECENT = 10

export type TrapMeasurement = { speedKmh: number; timestamp: number; isSpeeder: boolean; direction: 'AB' | 'BA' }

/**
 * Measures vehicle speed by timing the travel between two counting lines
 * (trajectcontrole). Crossing times are interpolated between the two frames
 * straddling a line, and the distance is the world-space length of the
 * vehicle's own path between its two crossing points — so lane position and
 * diagonal travel are measured correctly. Speed locks in permanently per
 * track ID once both lines are crossed.
 */
export class TrapSpeedCalculator {
  private entries = new Map<number, TrapEntry>()
  private recent: TrapMeasurement[] = []

  constructor(
    private readonly homographyMatrix: number[],
    private readonly maxSpeedKmh?: number,
    private readonly plausibilityKmh: number = 170,
  ) {}

  /**
   * @param px,py  bottom-center of the bounding box in frame pixels
   * @param ny     bottom-center Y normalised to [0,1]
   * @param lineAY,lineBY  normalised Y of each counting line at the vehicle's X
   */
  update(id: number, px: number, py: number, ny: number, lineAY: number, lineBY: number, timestamp: number): void {
    const belowA = ny > lineAY
    const belowB = ny > lineBY
    const entry = this.entries.get(id)

    if (!entry) {
      // A vehicle first seen between the lines has already passed one of them
      // unobserved — fabricating that crossing time would corrupt the
      // measurement, so such vehicles are never measured.
      this.entries.set(id, {
        crossA: null,
        crossB: null,
        prevBelowA: belowA,
        prevBelowB: belowB,
        prevPx: px,
        prevPy: py,
        prevNy: ny,
        prevTs: timestamp,
        seenOutside: belowA === belowB,
        speed: null,
      })
      return
    }

    if (entry.speed !== null) return

    if (entry.seenOutside) {
      if (belowA !== entry.prevBelowA) {
        entry.crossA = interpolateCrossing(this.homographyMatrix, entry, px, py, ny, lineAY, timestamp)
      }
      if (belowB !== entry.prevBelowB) {
        entry.crossB = interpolateCrossing(this.homographyMatrix, entry, px, py, ny, lineBY, timestamp)
      }
    }
    entry.prevBelowA = belowA
    entry.prevBelowB = belowB
    entry.prevPx = px
    entry.prevPy = py
    entry.prevNy = ny
    entry.prevTs = timestamp
    if (belowA === belowB) entry.seenOutside = true

    if (entry.crossA !== null && entry.crossB !== null) {
      const { crossA, crossB } = entry
      const dtS = Math.abs(crossB.t - crossA.t) / 1000
      if (dtS >= MIN_CROSSING_S && dtS <= MAX_CROSSING_S) {
        const dx = crossB.world.wx - crossA.world.wx
        const dy = crossB.world.wy - crossA.world.wy
        const speedKmh = (Math.sqrt(dx * dx + dy * dy) / dtS) * 3.6
        if (speedKmh > this.plausibilityKmh) return
        entry.speed = speedKmh
        const direction: 'AB' | 'BA' = crossA.t <= crossB.t ? 'AB' : 'BA'
        this.recent.push({ speedKmh, timestamp, isSpeeder: this.maxSpeedKmh !== undefined && speedKmh > this.maxSpeedKmh, direction })
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

// Linear interpolation between the previous and current observation to find
// where and when the vehicle's path intersected the line.
function interpolateCrossing(
  H: number[],
  entry: TrapEntry,
  px: number,
  py: number,
  ny: number,
  lineY: number,
  timestamp: number,
): Crossing {
  const denom = ny - entry.prevNy
  const f = Math.abs(denom) < 1e-9 ? 1 : Math.min(1, Math.max(0, (lineY - entry.prevNy) / denom))
  const crossPx = entry.prevPx + f * (px - entry.prevPx)
  const crossPy = entry.prevPy + f * (py - entry.prevPy)
  return {
    t: entry.prevTs + f * (timestamp - entry.prevTs),
    world: applyHomography(H, crossPx, crossPy),
  }
}
