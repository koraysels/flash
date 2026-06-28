const BASE = '/api'
const TOKEN_KEY = 'flash_token'

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
  motionGated: boolean
  trackDebug: boolean
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
  motionGated: false,
  trackDebug: false,
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
  displaySlot: string | null
  roiPolygon: number[]
  directionZones: Array<{ polygon: number[]; arrow: number[] }> | null
  createdAt: string
  updatedAt: string
}

export async function saveDirectionZones(id: string, directionZones: Array<{ polygon: number[]; arrow: number[] }>): Promise<void> {
  const res = await fetch(`${BASE}/cameras/${id}/direction-zones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ directionZones }),
  })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('Failed to save direction zones')
}


export const DISPLAY_SLOTS = ['FLASH-PI-01', 'FLASH-PI-02', 'FLASH-PI-03'] as const

export async function setDisplaySlot(id: string, slot: string | null): Promise<void> {
  const res = await fetch(`${BASE}/cameras/${id}/display-slot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ slot }),
  })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('Failed to set display slot')
}

export async function resolveDisplay(slug: string): Promise<string> {
  const res = await fetch(`${BASE}/display/${encodeURIComponent(slug)}`)
  if (!res.ok) throw new Error('Unknown display slug')
  return (await res.json()).cameraId as string
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function clearAuthAndReload(): never {
  localStorage.removeItem(TOKEN_KEY)
  window.location.reload()
  throw new Error('Session expired')
}

export type MqttTestResult = { ok: boolean; connected: boolean; payload: Record<string, unknown> }

export async function testMqttFlash(cameraId?: string): Promise<MqttTestResult> {
  const res = await fetch(`${BASE}/mqtt/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(cameraId ? { cameraId } : {}),
  })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('MQTT test failed')
  return res.json()
}

export type HealthStatus = {
  mqtt: {
    connected: boolean
    configured: boolean
    host: string
    topic: string
    publishCount: number
    lastPublishAt: number | null
    lastEvent: { speedKmh: number; location: string; direction: 'AB' | 'BA' | null; ts: number } | null
  }
  pis: Array<{
    slot: string
    ip: string
    online: boolean
    camera: string | null
    pageAlive: boolean
    streaming: boolean
  }>
}

export async function getHealth(): Promise<HealthStatus> {
  const res = await fetch(`${BASE}/health`)
  if (!res.ok) throw new Error('Health check failed')
  return res.json()
}

export async function reloadKiosk(slug: string): Promise<void> {
  const res = await fetch(`${BASE}/kiosk/${slug}/reload`, { method: 'POST', headers: authHeaders() })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('Reload failed')
}

export type DailyCountRow = {
  id: string
  cameraId: string
  date: string
  directionAB: number
  directionBA: number
  speeders: number
  camera?: { name: string }
}

export async function getDailyHistory(days = 14): Promise<DailyCountRow[]> {
  const res = await fetch(`${BASE}/daily?days=${days}`)
  if (!res.ok) throw new Error('History fetch failed')
  return res.json()
}

export async function getCameras(): Promise<Camera[]> {
  const res = await fetch(`${BASE}/cameras`)
  if (!res.ok) throw new Error('Failed to fetch cameras')
  return res.json()
}

export async function createCamera(data: Pick<Camera, 'name' | 'location' | 'streamUrl'>): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('Failed to create camera')
  return res.json()
}

export async function updateCamera(id: string, data: Partial<Camera>): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('Failed to update camera')
  return res.json()
}

export async function deleteCamera(id: string): Promise<void> {
  const res = await fetch(`${BASE}/cameras/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('Failed to delete camera')
}

export async function duplicateCamera(id: string): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras/${id}/duplicate`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('Failed to duplicate camera')
  return res.json()
}

export type CalibrationPoint = {
  px: number
  py: number
  wx: number
  wy: number
  lat?: number
  lng?: number
}

export type CalibrationError = {
  perPointM: number[]
  rmsM: number
  maxM: number
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
  frameWidth?: number,
  frameHeight?: number,
): Promise<Camera & { calibrationError?: CalibrationError }> {
  const res = await fetch(`${BASE}/cameras/${id}/calibration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ pairs, maxSpeedKmh, countingLineA, countingLineB, countingLineAPoints, countingLineBPoints, trapSpeedEnabled, frameWidth, frameHeight }),
  })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('Failed to save calibration')
  return res.json()
}

export async function resetCounts(id: string): Promise<void> {
  const res = await fetch(`${BASE}/cameras/${id}/reset-counts`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('Failed to reset counts')
}

export async function saveTrackingConfig(id: string, config: TrackerConfig): Promise<Camera> {
  const res = await fetch(`${BASE}/cameras/${id}/tracking-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(config),
  })
  if (res.status === 401) clearAuthAndReload()
  if (!res.ok) throw new Error('Failed to save tracking config')
  return res.json()
}

export async function getCameraSnapshot(id: string): Promise<string> {
  const res = await fetch(`${BASE}/cameras/${id}/snapshot`)
  if (!res.ok) throw new Error('No snapshot available')
  const data = await res.json()
  return data.frame as string
}
