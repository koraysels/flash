type VehicleState = {
  lastX: number
  lastY: number
  crossedA: boolean
  crossedB: boolean
}

export type Counts = { AB: number; BA: number }

// Normalised line: [x1, y1, x2, y2] in [0, 1] space
type Line = [number, number, number, number]

// Y value of the line at a given normalised X (extrapolated outside segment)
function lineYAt([x1, y1, x2, y2]: Line, nx: number): number {
  if (Math.abs(x2 - x1) < 1e-6) return (y1 + y2) / 2
  return y1 + ((y2 - y1) / (x2 - x1)) * (nx - x1)
}

export class DirectionCounter {
  private vehicles = new Map<number, VehicleState>()
  private counts: Counts = { AB: 0, BA: 0 }
  private lineA: Line
  private lineB: Line

  /**
   * lineA / lineB can each be a Y fraction (horizontal line) or a
   * [x1,y1,x2,y2] tuple of normalised 0-1 coordinates.
   */
  constructor(
    _frameHeight: number,       // kept for call-site compatibility
    lineAFraction: number,
    lineBFraction: number,
    lineAPoints?: number[],     // [x1,y1,x2,y2] normalised; takes priority if length===4
    lineBPoints?: number[],     // same for B
  ) {
    this.lineA = (lineAPoints?.length === 4)
      ? lineAPoints as Line
      : [0, lineAFraction, 1, lineAFraction]
    this.lineB = (lineBPoints?.length === 4)
      ? lineBPoints as Line
      : [0, lineBFraction, 1, lineBFraction]
  }

  /**
   * @param nx  bottom-centre X, normalised to [0,1] (bcx / frameWidth)
   * @param ny  bottom-centre Y, normalised to [0,1] (bcy / frameHeight)
   */
  updateVehicle(vehicleId: number, nx: number, ny: number): void {
    const threshA = lineYAt(this.lineA, nx)
    const threshB = lineYAt(this.lineB, nx)

    if (!this.vehicles.has(vehicleId)) {
      this.vehicles.set(vehicleId, { lastX: nx, lastY: ny, crossedA: false, crossedB: false })
      return
    }

    const state = this.vehicles.get(vehicleId)!
    if (ny === state.lastY && nx === state.lastX) return

    const movingDown = ny > state.lastY

    if (movingDown) {
      if (!state.crossedA && ny >= threshA) state.crossedA = true
      if (state.crossedA && !state.crossedB && ny >= threshB) {
        this.counts.AB++
        state.crossedA = false
        state.crossedB = true
      }
    } else {
      if (!state.crossedB && ny <= threshB) state.crossedB = true
      if (state.crossedB && !state.crossedA && ny <= threshA) {
        this.counts.BA++
        state.crossedA = true
        state.crossedB = false
      }
    }

    state.lastX = nx
    state.lastY = ny
  }

  removeVehicle(vehicleId: number): void {
    this.vehicles.delete(vehicleId)
  }

  getCounts(): Counts {
    return { ...this.counts }
  }

  reset(): void {
    this.vehicles.clear()
    this.counts = { AB: 0, BA: 0 }
  }
}
