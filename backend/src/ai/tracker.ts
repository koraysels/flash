import { DetectionResult } from './detector'

export type TrackedVehicle = DetectionResult & {
  id: number
  cx: number
  cy: number
  history: Array<{ cx: number; cy: number; timestamp: number }>
  missedFrames: number
}

export class Tracker {
  private tracks: TrackedVehicle[] = []
  private nextId = 1
  private readonly maxMissedFrames = 5
  private readonly iouThreshold = 0.3

  update(detections: DetectionResult[]): TrackedVehicle[] {
    const now = Date.now()
    const usedDetections = new Set<number>()

    // Match detections to existing tracks by IoU
    for (const track of this.tracks) {
      let bestIou = this.iouThreshold
      let bestIdx = -1

      for (let idx = 0; idx < detections.length; idx++) {
        if (usedDetections.has(idx)) continue
        const score = iou(track, detections[idx])
        if (score > bestIou) {
          bestIou = score
          bestIdx = idx
        }
      }

      if (bestIdx !== -1) {
        const det = detections[bestIdx]
        const cx = (det.x1 + det.x2) / 2
        const cy = (det.y1 + det.y2) / 2
        track.x1 = det.x1
        track.y1 = det.y1
        track.x2 = det.x2
        track.y2 = det.y2
        track.cx = cx
        track.cy = cy
        track.confidence = det.confidence
        track.history.push({ cx, cy, timestamp: now })
        if (track.history.length > 30) track.history.shift()
        track.missedFrames = 0
        usedDetections.add(bestIdx)
      } else {
        track.missedFrames++
      }
    }

    // Remove lost tracks
    this.tracks = this.tracks.filter((t) => t.missedFrames < this.maxMissedFrames)

    // Create new tracks for unmatched detections
    for (let idx = 0; idx < detections.length; idx++) {
      if (usedDetections.has(idx)) continue
      const det = detections[idx]
      const cx = (det.x1 + det.x2) / 2
      const cy = (det.y1 + det.y2) / 2
      this.tracks.push({
        ...det,
        id: this.nextId++,
        cx,
        cy,
        history: [{ cx, cy, timestamp: now }],
        missedFrames: 0,
      })
    }

    return this.tracks.filter((t) => t.missedFrames === 0)
  }

  reset(): void {
    this.tracks = []
  }
}

function iou(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): number {
  const ix1 = Math.max(a.x1, b.x1)
  const iy1 = Math.max(a.y1, b.y1)
  const ix2 = Math.min(a.x2, b.x2)
  const iy2 = Math.min(a.y2, b.y2)
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
  const aArea = (a.x2 - a.x1) * (a.y2 - a.y1)
  const bArea = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (aArea + bArea - inter)
}
