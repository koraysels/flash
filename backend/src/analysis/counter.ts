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

    // Skip stationary vehicles to avoid spurious flag changes
    if (cy === state.lastY) return

    const movingDown = cy > state.lastY

    if (movingDown) {
      // A→B: cross lineA first, then lineB
      if (!state.crossedA && cy >= this.lineAY) state.crossedA = true
      if (state.crossedA && !state.crossedB && cy >= this.lineBY) {
        this.counts.AB++
        // After counting AB the vehicle is south of lineB.
        // Mark crossedB=true so continued southward movement doesn't re-trigger,
        // and keep crossedA=false so a northward reversal can build a BA count
        // by first setting crossedB via the upward check (which is already true,
        // so we clear it here) then crossedA via crossing lineA upward.
        // Cleanest reset: clear both, but also clear crossedA eagerly when the
        // vehicle is still above lineA — handled by setting lastY before return.
        // We set crossedA=false, crossedB=true to prevent immediate AB re-count
        // while still allowing BA detection (which requires !crossedA first, then !crossedA at lineA).
        // For BA after AB: going up from south of lineB:
        //   cy <= lineBY → crossedB already true (skip first check), proceed to second
        //   wait — second check needs crossedB=true AND !crossedA AND cy<=lineAY
        //   crossedB=true ✓, crossedA=false ✓ → will count BA when cy<=lineAY ✓
        state.crossedA = false
        state.crossedB = true
      }
    } else {
      // B→A: cross lineB first (from above), then lineA
      if (!state.crossedB && cy <= this.lineBY) state.crossedB = true
      if (state.crossedB && !state.crossedA && cy <= this.lineAY) {
        this.counts.BA++
        // After counting BA the vehicle is north of lineA.
        // Set crossedA=true to prevent immediate BA re-count on continued northward movement.
        // For AB after BA: going down from north of lineA:
        //   cy >= lineAY → crossedA already true (skip first check)
        //   second check needs crossedA=true AND !crossedB AND cy>=lineBY ✓
        state.crossedA = true
        state.crossedB = false
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
