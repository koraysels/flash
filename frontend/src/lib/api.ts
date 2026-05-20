const BASE = '/api'

export type TrackerConfig = {
  highConfidence: number
  iouStage1: number
  iouStage2: number
  maxPredictedGap: number
  maxMissedFrames: number
  minConfirmedFrames: number
  boxEmaAlpha: number
  qPos: number
  qVel: number
  speedPlausibilityKmh: number
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  highConfidence: 0.55,
  iouStage1: 0.35,
  iouStage2: 0.12,
  maxPredictedGap: 3,
  maxMissedFrames: 30,
  minConfirmedFrames: 2,
  boxEmaAlpha: 0.60,
  qPos: 1.0,
  qVel: 0.05,
  speedPlausibilityKmh: 170,
}

export type Camera = {
  id: string
  name: string
  location: string
  streamUrl: string
  active: boolean
  maxSpeedKmh: number | null
  homographyMatrix: number[]
  calibrationPoints: Array<{ px: number; py: number; wx: number; wy: number; lat?: number; lng?: number }> | null
  countingLineA: number
  countingLineB: number
  countingLineAPoints: number[]
  countingLineBPoints: number[]
  trapSpeedEnabled: boolean
  trackingConfig: TrackerConfig | null
  createdAt: string
  updatedAt: string
}

export async function getCameras(): Promise<Camera[]> {
  const res = await fetch(`${BASE}/cameras`)
  if (!res.ok) throw new Error('Failed to fetch cameras')
  return res.json()
}

export async function createCamera(data: Pick<Camera, 'name' | 'location' | 'streamUrl'>): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to create camera')
  return res.json()
}

export async function updateCamera(id: string, data: Partial<Camera>): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Failed to update camera')
  return res.json()
}

export async function deleteCamera(id: string): Promise<void> {
  const res = await fetch(`${BASE}/cameras/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete camera')
}

export type CalibrationPoint = {
  px: number
  py: number
  wx: number
  wy: number
  lat?: number
  lng?: number
}

export async function saveCalibration(
  id: string,
  pairs: CalibrationPoint[],
  maxSpeedKmh: number | null,
  countingLineA: number,
  countingLineB: number,
  countingLineAPoints?: number[],
  countingLineBPoints?: number[],
  trapSpeedEnabled?: boolean,
): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras/${id}/calibration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairs, maxSpeedKmh, countingLineA, countingLineB, countingLineAPoints, countingLineBPoints, trapSpeedEnabled }),
  })
  if (!res.ok) throw new Error('Failed to save calibration')
  return res.json()
}

export async function resetCounts(id: string): Promise<void> {
  const res = await fetch(`${BASE}/cameras/${id}/reset-counts`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to reset counts')
}

export async function saveTrackingConfig(id: string, config: TrackerConfig): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras/${id}/tracking-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) throw new Error('Failed to save tracking config')
  return res.json()
}

export async function getCameraSnapshot(id: string): Promise<string> {
  const res = await fetch(`${BASE}/cameras/${id}/snapshot`)
  if (!res.ok) throw new Error('No snapshot available')
  const data = await res.json()
  return data.frame as string
}
