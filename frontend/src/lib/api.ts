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
