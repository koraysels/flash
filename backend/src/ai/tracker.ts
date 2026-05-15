import { DetectionResult } from './detector'

export type TrackedVehicle = DetectionResult & {
  id: number
  cx: number
  cy: number
  /** Bottom-center x — ground-plane contact point, use for speed/counting */
  bcx: number
  /** Bottom-center y — ground-plane contact point, use for speed/counting */
  bcy: number
  history: Array<{ cx: number; cy: number; timestamp: number }>
  missedFrames: number
  confirmedFrames: number
}

// EMA weight for box smoothing — lower = smoother but laggier
const BOX_ALPHA = 0.55

export class Tracker {
  private tracks: TrackedVehicle[] = []
  private nextId = 1
  private readonly maxMissedFrames = 8
  private readonly iouThreshold = 0.2
  // A track must be confirmed for this many frames before being reported
  private readonly minConfirmedFrames = 2

  update(detections: DetectionResult[]): TrackedVehicle[] {
    const now = Date.now()
    const usedDetections = new Set<number>()

    // Match detections to existing tracks using predicted positions
    for (const track of this.tracks) {
      const predicted = predictBox(track)
      let bestIou = this.iouThreshold
      let bestIdx = -1

      for (let idx = 0; idx < detections.length; idx++) {
        if (usedDetections.has(idx)) continue
        const score = iou(predicted, detections[idx])
        if (score > bestIou) {
          bestIou = score
          bestIdx = idx
        }
      }

      if (bestIdx !== -1) {
        const det = detections[bestIdx]

        // Smooth bounding box with EMA to reduce visual jitter
        track.x1 = BOX_ALPHA * det.x1 + (1 - BOX_ALPHA) * track.x1
        track.y1 = BOX_ALPHA * det.y1 + (1 - BOX_ALPHA) * track.y1
        track.x2 = BOX_ALPHA * det.x2 + (1 - BOX_ALPHA) * track.x2
        track.y2 = BOX_ALPHA * det.y2 + (1 - BOX_ALPHA) * track.y2
        track.cx = (track.x1 + track.x2) / 2
        track.cy = (track.y1 + track.y2) / 2
        track.bcx = track.cx
        track.bcy = track.y2  // bottom-center = ground contact point
        track.confidence = det.confidence
        track.history.push({ cx: track.cx, cy: track.cy, timestamp: now })
        if (track.history.length > 20) track.history.shift()
        track.missedFrames = 0
        track.confirmedFrames++
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
        bcx: cx,
        bcy: det.y2,
        history: [{ cx, cy, timestamp: now }],
        missedFrames: 0,
        confirmedFrames: 1,
      })
    }

    // Only return tracks that have been confirmed for enough frames and are currently seen
    return this.tracks.filter((t) => t.missedFrames === 0 && t.confirmedFrames >= this.minConfirmedFrames)
  }

  reset(): void {
    this.tracks = []
  }
}

/** Predict next box position using last two history points (constant-velocity model) */
function predictBox(track: TrackedVehicle): { x1: number; y1: number; x2: number; y2: number } {
  if (track.history.length < 2) return track

  const n = track.history.length
  const last = track.history[n - 1]
  const prev = track.history[n - 2]
  const dt = last.timestamp - prev.timestamp
  if (dt <= 0) return track

  // Velocity in px/ms, project ~500ms ahead (matches 2fps interval)
  const vx = (last.cx - prev.cx) / dt
  const vy = (last.cy - prev.cy) / dt
  const ahead = Math.min(dt * 1.5, 600)

  const w = track.x2 - track.x1
  const h = track.y2 - track.y1
  const pcx = last.cx + vx * ahead
  const pcy = last.cy + vy * ahead

  return { x1: pcx - w / 2, y1: pcy - h / 2, x2: pcx + w / 2, y2: pcy + h / 2 }
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
