type VehicleState = {
  lastY: number
  crossedA: boolean
  crossedB: boolean
}

export type Counts = { AB: number; BA: number }

export class DirectionCounter {
  private vehicles = new Map<number, VehicleState>()
  private counts: Counts = { AB: 0, BA: 0 }
  private readonly lineAY: number
  private readonly lineBY: number

  constructor(frameHeight: number, lineAFraction: number, lineBFraction: number) {
    this.lineAY = frameHeight * lineAFraction
    this.lineBY = frameHeight * lineBFraction
  }

  updateVehicle(vehicleId: number, cy: number): void {
    if (!this.vehicles.has(vehicleId)) {
      this.vehicles.set(vehicleId, { lastY: cy, crossedA: false, crossedB: false })
      return
    }

    const state = this.vehicles.get(vehicleId)!
    const movingDown = cy > state.lastY

    if (movingDown) {
      // A→B: must cross A first, then B
      if (!state.crossedA && cy >= this.lineAY) state.crossedA = true
      if (state.crossedA && !state.crossedB && cy >= this.lineBY) {
        state.crossedB = true
        this.counts.AB++
      }
    } else {
      // B→A: must cross B first (from above), then A
      if (!state.crossedB && cy <= this.lineBY) state.crossedB = true
      if (state.crossedB && !state.crossedA && cy <= this.lineAY) {
        state.crossedA = true
        this.counts.BA++
      }
    }

    state.lastY = cy
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
