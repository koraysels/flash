const BASE = '/api'

export type Camera = {
  id: string
  name: string
  location: string
  streamUrl: string
  active: boolean
  maxSpeedKmh: number | null
  homographyMatrix: number[]
  calibrationPoints: unknown
  countingLineA: number
  countingLineB: number
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
}

export async function saveCalibration(
  id: string,
  pairs: CalibrationPoint[],
  maxSpeedKmh: number | null,
  countingLineA: number,
  countingLineB: number,
): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras/${id}/calibration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairs, maxSpeedKmh, countingLineA, countingLineB }),
  })
  if (!res.ok) throw new Error('Failed to save calibration')
  return res.json()
}

export async function getCameraSnapshot(id: string): Promise<string> {
  const res = await fetch(`${BASE}/cameras/${id}/snapshot`)
  if (!res.ok) throw new Error('No snapshot available')
  const data = await res.json()
  return data.frame as string
}
