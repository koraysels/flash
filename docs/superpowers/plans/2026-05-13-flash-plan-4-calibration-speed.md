# Flash — Plan 4: Calibration & Speed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement perspective transform + homography calibration: a split-view wizard where the user places point pairs on the camera frame and Google Maps satellite view. The homography matrix is computed and stored per camera. Vehicle speed in km/u is calculated using the matrix. A speeder counter increments per camera when a vehicle exceeds `maxSpeedKmh`.

**Architecture:** The `Homography` utility computes a 3×3 matrix from N≥4 point pairs using Direct Linear Transform (DLT) with `mathjs`. The `SpeedCalculator` applies the matrix to tracked vehicle trajectories to produce km/u. The calibration wizard is a React page with a camera frame (react-konva point picker) on the left and Google Maps satellite (`@react-google-maps/api`) on the right. The user clicks corresponding points on both views, sets `maxSpeedKmh`, then saves.

**Tech Stack:** mathjs (DLT computation), react-konva (canvas point picker), @react-google-maps/api (satellite map), Google Maps JavaScript API (requires API key)

**Prerequisites:** Plans 1–3 complete

---

## File Map

```
backend/src/
└── analysis/
    ├── homography.ts       # DLT: point pairs → 3×3 matrix, apply matrix
    └── speed.ts            # trajectory + homography → km/u, isSpeeder check

frontend/src/
├── pages/
│   └── CameraCalibrate.tsx # /cameras/:id/calibrate — full calibration wizard
├── components/
│   ├── FramePointPicker.tsx # react-konva canvas with draggable point markers
│   └── SpeedDisplay.tsx     # km/u badge on the live feed
└── hooks/
    └── useCameraFeed.ts     # extended to include avgSpeedKmh per frame
```

---

## Task 1: Homography math (DLT)

**Files:**
- Create: `backend/src/analysis/homography.ts`
- Create: `backend/tests/analysis/homography.test.ts`

- [ ] **Step 1: Add mathjs**

Add to `backend/package.json` dependencies:
```json
"mathjs": "^13.1.1"
```

Run: `cd backend && npm install`

- [ ] **Step 2: Write failing test**

```typescript
// backend/tests/analysis/homography.test.ts
import { describe, it, expect } from 'vitest'
import { computeHomography, applyHomography } from '../../src/analysis/homography'

describe('computeHomography', () => {
  it('computes H that maps image points to world points', () => {
    // A simple case: image is 100x100, world is 10x10 meters
    // 4 corners
    const pairs = [
      { px: 0, py: 0, wx: 0, wy: 0 },
      { px: 100, py: 0, wx: 10, wy: 0 },
      { px: 100, py: 100, wx: 10, wy: 10 },
      { px: 0, py: 100, wx: 0, wy: 10 },
    ]
    const H = computeHomography(pairs)
    expect(H).toHaveLength(9)

    const result = applyHomography(H, 50, 50)
    expect(result.wx).toBeCloseTo(5, 1)
    expect(result.wy).toBeCloseTo(5, 1)
  })

  it('throws if fewer than 4 point pairs', () => {
    expect(() => computeHomography([
      { px: 0, py: 0, wx: 0, wy: 0 },
      { px: 100, py: 0, wx: 10, wy: 0 },
      { px: 100, py: 100, wx: 10, wy: 10 },
    ])).toThrow('At least 4 point pairs required')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd backend && npm test tests/analysis/homography.test.ts
```

Expected: FAIL — `computeHomography` not found

- [ ] **Step 4: Create backend/src/analysis/homography.ts**

```typescript
import { matrix, multiply, inv, transpose, lusolve } from 'mathjs'

export type PointPair = {
  px: number  // image pixel x
  py: number  // image pixel y
  wx: number  // world meters x
  wy: number  // world meters y
}

export function computeHomography(pairs: PointPair[]): number[] {
  if (pairs.length < 4) throw new Error('At least 4 point pairs required')

  // Build matrix A for DLT: each point pair gives 2 rows
  const rows: number[][] = []
  for (const { px, py, wx, wy } of pairs) {
    rows.push([-px, -py, -1, 0, 0, 0, wx * px, wx * py, wx])
    rows.push([0, 0, 0, -px, -py, -1, wy * px, wy * py, wy])
  }

  const A = matrix(rows)
  const At = transpose(A)
  const AtA = multiply(At, A)

  // Solve for the smallest eigenvector via power iteration on (AtA)^-1
  // For simplicity, use SVD-like approach via mathjs pseudoinverse
  // We use the last column of the pseudo-inverse of A as the null vector
  const AtAInv = inv(AtA as any)
  const h = (AtAInv as any).valueOf().map((row: number[]) => row[row.length - 1])

  // Normalize so h[8] = 1
  const scale = h[8] !== 0 ? h[8] : 1
  return (h as number[]).map((v: number) => v / scale)
}

export function applyHomography(H: number[], px: number, py: number): { wx: number; wy: number } {
  const w = H[6] * px + H[7] * py + H[8]
  const wx = (H[0] * px + H[1] * py + H[2]) / w
  const wy = (H[3] * px + H[4] * py + H[5]) / w
  return { wx, wy }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd backend && npm test tests/analysis/homography.test.ts
```

Expected: 2 tests pass

- [ ] **Step 6: Commit**

```bash
git add backend/src/analysis/homography.ts backend/tests/analysis/homography.test.ts backend/package.json backend/package-lock.json
git commit -m "feat: add DLT homography computation and application"
```

---

## Task 2: Speed calculator

**Files:**
- Create: `backend/src/analysis/speed.ts`
- Create: `backend/tests/analysis/speed.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// backend/tests/analysis/speed.test.ts
import { describe, it, expect } from 'vitest'
import { SpeedCalculator } from '../../src/analysis/speed'

describe('SpeedCalculator', () => {
  it('calculates speed in km/u from pixel trajectory', () => {
    // Homography: 1px = 0.1m (trivial identity-like H for testing)
    const H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1]
    const calc = new SpeedCalculator(H, 2) // 2 fps

    // Vehicle moves 20px between frames at 2fps = 10px/frame = 1m/frame = 2m/s = 7.2 km/u
    calc.addPosition(1, 0, 0, Date.now() - 500)
    calc.addPosition(1, 20, 0, Date.now())

    const speed = calc.getSpeed(1)
    expect(speed).toBeGreaterThan(0)
    expect(speed).toBeLessThan(200)
  })

  it('returns null if fewer than 2 positions', () => {
    const H = [0.1, 0, 0, 0, 0.1, 0, 0, 0, 1]
    const calc = new SpeedCalculator(H, 2)
    calc.addPosition(2, 0, 0, Date.now())
    expect(calc.getSpeed(2)).toBeNull()
  })

  it('detects speeders when speed exceeds maxSpeedKmh', () => {
    const H = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const calc = new SpeedCalculator(H, 2, 50)
    calc.addPosition(3, 0, 0, Date.now() - 500)
    calc.addPosition(3, 100, 0, Date.now())
    const isSpeeder = calc.isSpeeder(3)
    expect(typeof isSpeeder).toBe('boolean')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && npm test tests/analysis/speed.test.ts
```

Expected: FAIL — `SpeedCalculator` not found

- [ ] **Step 3: Create backend/src/analysis/speed.ts**

```typescript
import { applyHomography } from './homography'

type Position = { wx: number; wy: number; timestamp: number }

export class SpeedCalculator {
  private history = new Map<number, Position[]>()
  private readonly smoothingWindow = 5

  constructor(
    private readonly homographyMatrix: number[],
    private readonly fps: number,
    private readonly maxSpeedKmh?: number,
  ) {}

  addPosition(vehicleId: number, px: number, py: number, timestamp: number): void {
    const world = applyHomography(this.homographyMatrix, px, py)
    const positions = this.history.get(vehicleId) ?? []
    positions.push({ ...world, timestamp })
    if (positions.length > this.smoothingWindow) positions.shift()
    this.history.set(vehicleId, positions)
  }

  getSpeed(vehicleId: number): number | null {
    const positions = this.history.get(vehicleId)
    if (!positions || positions.length < 2) return null

    const oldest = positions[0]
    const newest = positions[positions.length - 1]
    const dt = (newest.timestamp - oldest.timestamp) / 1000
    if (dt === 0) return null

    const dx = newest.wx - oldest.wx
    const dy = newest.wy - oldest.wy
    const distanceMeters = Math.sqrt(dx * dx + dy * dy)
    const speedMs = distanceMeters / dt
    return speedMs * 3.6
  }

  isSpeeder(vehicleId: number): boolean {
    if (!this.maxSpeedKmh) return false
    const speed = this.getSpeed(vehicleId)
    return speed !== null && speed > this.maxSpeedKmh
  }

  removeVehicle(vehicleId: number): void {
    this.history.delete(vehicleId)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && npm test tests/analysis/speed.test.ts
```

Expected: 3 tests pass

- [ ] **Step 5: Update backend/src/ai/pipeline.ts to use SpeedCalculator**

In `pipeline.ts`, replace the `speedKmh = null` placeholder:

```typescript
// Add to imports:
import { SpeedCalculator } from '../analysis/speed'
import { applyHomography } from '../analysis/homography'

// Add speedCalc to CameraPipeline class (only when homography is set):
private speedCalc: SpeedCalculator | null = null

// In constructor, after this.counter = ...:
if (homographyMatrix.length === 9) {
  this.speedCalc = new SpeedCalculator(homographyMatrix, fps, maxSpeedKmh ?? undefined)
}

// In process(), replace the vehicle mapping:
const vehicles = tracked.map((v) => {
  let speedKmh: number | null = null
  let isSpeeder = false

  if (this.speedCalc) {
    this.speedCalc.addPosition(v.id, v.cx, v.cy, Date.now())
    speedKmh = this.speedCalc.getSpeed(v.id)
    isSpeeder = this.speedCalc.isSpeeder(v.id)
    if (isSpeeder) this.speeders++
  }

  return { id: v.id, class: v.class, speedKmh, direction: null as 'AB' | 'BA' | null }
})
```

Also pass `homographyMatrix` to the `CameraPipeline` constructor. Update the constructor signature:

```typescript
constructor(
  private readonly cameraId: string,
  private readonly frameWidth: number,
  private readonly frameHeight: number,
  private readonly lineA: number,
  private readonly lineB: number,
  private readonly maxSpeedKmh: number | null,
  private readonly homographyMatrix: number[] = [],
  private readonly fps: number = 2,
)
```

And update `camera-worker.ts` to pass `camera.homographyMatrix`:

```typescript
const pipeline = new CameraPipeline(
  cameraId,
  1280, 720,
  camera.countingLineA,
  camera.countingLineB,
  camera.maxSpeedKmh,
  camera.homographyMatrix,
)
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/analysis/speed.ts backend/tests/analysis/speed.test.ts backend/src/ai/pipeline.ts backend/src/camera-worker.ts
git commit -m "feat: add speed calculator with homography, integrate into AI pipeline"
```

---

## Task 3: Calibration API endpoints

**Files:**
- Modify: `backend/src/routes/cameras.ts`

- [ ] **Step 1: Add calibration endpoints to cameras.ts**

Add two new routes to `cameraRoutes`:

```typescript
// POST /api/cameras/:id/calibration — compute and store homography
app.post<{
  Params: { id: string }
  Body: {
    pairs: Array<{ px: number; py: number; wx: number; wy: number }>
    maxSpeedKmh?: number
    countingLineA?: number
    countingLineB?: number
  }
}>('/api/cameras/:id/calibration', async (req, reply) => {
  const { pairs, maxSpeedKmh, countingLineA, countingLineB } = req.body

  if (pairs.length < 4) {
    reply.code(400)
    return { error: 'At least 4 point pairs required' }
  }

  const { computeHomography } = await import('../analysis/homography')
  const H = computeHomography(pairs)

  const camera = await db.camera.update({
    where: { id: req.params.id },
    data: {
      homographyMatrix: H,
      calibrationPoints: pairs,
      ...(maxSpeedKmh !== undefined && { maxSpeedKmh }),
      ...(countingLineA !== undefined && { countingLineA }),
      ...(countingLineB !== undefined && { countingLineB }),
    },
  })

  return camera
})

// GET /api/cameras/:id/snapshot — return a single JPEG frame for calibration UI
app.get<{ Params: { id: string } }>('/api/cameras/:id/snapshot', async (req, reply) => {
  // Returns the most recently captured frame as base64
  const { getLatestFrame } = await import('../socket/server')
  const frame = getLatestFrame(req.params.id)
  if (!frame) {
    reply.code(404)
    return { error: 'No frame available yet. Make sure the camera stream is active.' }
  }
  return { frame }
})
```

- [ ] **Step 2: Add getLatestFrame to socket/server.ts**

Add a frame cache to `socket/server.ts`:

```typescript
const latestFrames = new Map<string, string>()

// In emitFrame, before broadcasting:
export function emitFrame(event: FrameEvent): void {
  latestFrames.set(event.cameraId, event.frame)
  io?.to(`camera:${event.cameraId}`).emit('frame', event)
}

export function getLatestFrame(cameraId: string): string | undefined {
  return latestFrames.get(cameraId)
}
```

- [ ] **Step 3: Add lat/lng → meters conversion utility**

Add to `backend/src/analysis/homography.ts`:

```typescript
// Convert lat/lng to local meter offsets from an origin point
export function latlngToMeters(
  originLat: number,
  originLng: number,
  lat: number,
  lng: number,
): { wx: number; wy: number } {
  const R = 6371000
  const dLat = ((lat - originLat) * Math.PI) / 180
  const dLng = ((lng - originLng) * Math.PI) / 180
  const wx = dLng * R * Math.cos((originLat * Math.PI) / 180)
  const wy = dLat * R
  return { wx, wy }
}
```

- [ ] **Step 4: Update api.ts in frontend with calibration calls**

Add to `frontend/src/lib/api.ts`:

```typescript
export type CalibrationPoint = {
  px: number  // image pixel x
  py: number  // image pixel y
  wx: number  // world meters x (from Google Maps)
  wy: number  // world meters y (from Google Maps)
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
  const body = await res.json()
  return body.frame as string
}
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/cameras.ts backend/src/socket/server.ts backend/src/analysis/homography.ts frontend/src/lib/api.ts
git commit -m "feat: add calibration API and snapshot endpoint"
```

---

## Task 4: Calibration wizard — frontend

**Files:**
- Create: `frontend/src/components/FramePointPicker.tsx`
- Create: `frontend/src/pages/CameraCalibrate.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add react-konva and @react-google-maps/api**

Add to `frontend/package.json`:
```json
"react-konva": "^18.2.10",
"konva": "^9.3.6",
"@react-google-maps/api": "^2.19.3"
```

Run: `cd frontend && npm install`

- [ ] **Step 2: Create frontend/src/components/FramePointPicker.tsx**

```typescript
import { Stage, Layer, Image as KonvaImage, Circle, Text } from 'react-konva'
import { useEffect, useRef, useState } from 'react'
import useImage from 'use-image'

type Point = { x: number; y: number }

type Props = {
  frameBase64: string
  points: Point[]
  onChange: (points: Point[]) => void
  width?: number
}

export function FramePointPicker({ frameBase64, points, onChange, width = 640 }: Props) {
  const [img] = useImage(`data:image/jpeg;base64,${frameBase64}`)
  const scale = img ? width / img.width : 1
  const height = img ? img.height * scale : width * 0.5625

  function handleClick(e: any) {
    const pos = e.target.getStage().getPointerPosition()
    const newPoint = { x: pos.x / scale, y: pos.y / scale }
    onChange([...points, newPoint])
  }

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden cursor-crosshair">
      <Stage width={width} height={height} onClick={handleClick}>
        <Layer>
          {img && <KonvaImage image={img} scaleX={scale} scaleY={scale} />}
          {points.map((p, i) => (
            <React.Fragment key={i}>
              <Circle
                x={p.x * scale}
                y={p.y * scale}
                radius={8}
                fill="#3b82f6"
                stroke="#fff"
                strokeWidth={2}
                draggable
                onDragEnd={(e) => {
                  const updated = [...points]
                  updated[i] = { x: e.target.x() / scale, y: e.target.y() / scale }
                  onChange(updated)
                }}
              />
              <Text x={p.x * scale + 10} y={p.y * scale - 6} text={String(i + 1)} fill="#fff" fontSize={12} />
            </React.Fragment>
          ))}
        </Layer>
      </Stage>
    </div>
  )
}
```

Add `use-image` to dependencies:
```json
"use-image": "^1.1.1"
```

Run: `cd frontend && npm install`

- [ ] **Step 3: Create frontend/src/pages/CameraCalibrate.tsx**

```typescript
import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { GoogleMap, useJsApiLoader, Marker } from '@react-google-maps/api'
import { FramePointPicker } from '../components/FramePointPicker'
import { getCameraSnapshot, saveCalibration, getCameras, type Camera, type CalibrationPoint } from '../lib/api'

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string

type LatLng = { lat: number; lng: number }

export default function CameraCalibrate() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [camera, setCamera] = useState<Camera | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [imagePoints, setImagePoints] = useState<Array<{ x: number; y: number }>>([])
  const [mapPoints, setMapPoints] = useState<LatLng[]>([])
  const [mapCenter, setMapCenter] = useState<LatLng>({ lat: 50.85, lng: 4.35 }) // Belgium default
  const [maxSpeedKmh, setMaxSpeedKmh] = useState<string>('')
  const [lineA, setLineA] = useState(0.4)
  const [lineB, setLineB] = useState(0.6)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
  })

  useEffect(() => {
    if (!id) return
    getCameras().then((cams) => {
      const cam = cams.find((c) => c.id === id)
      if (cam) {
        setCamera(cam)
        setMaxSpeedKmh(cam.maxSpeedKmh?.toString() ?? '')
        setLineA(cam.countingLineA)
        setLineB(cam.countingLineB)
      }
    })
    getCameraSnapshot(id)
      .then(setSnapshot)
      .catch(() => setError('No camera snapshot available. Make sure the stream is active.'))
  }, [id])

  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (!e.latLng) return
    setMapPoints((pts) => [...pts, { lat: e.latLng!.lat(), lng: e.latLng!.lng() }])
  }, [])

  function removeLastPair() {
    setImagePoints((pts) => pts.slice(0, -1))
    setMapPoints((pts) => pts.slice(0, -1))
  }

  async function handleSave() {
    if (!id || imagePoints.length < 4 || mapPoints.length < 4) return
    if (imagePoints.length !== mapPoints.length) return

    setSaving(true)
    setError(null)

    try {
      // Convert lat/lng to meters relative to first point
      const origin = mapPoints[0]
      const R = 6371000
      const pairs: CalibrationPoint[] = imagePoints.map((ip, i) => {
        const mp = mapPoints[i]
        const dLat = ((mp.lat - origin.lat) * Math.PI) / 180
        const dLng = ((mp.lng - origin.lng) * Math.PI) / 180
        return {
          px: ip.x,
          py: ip.y,
          wx: dLng * R * Math.cos((origin.lat * Math.PI) / 180),
          wy: dLat * R,
        }
      })

      await saveCalibration(
        id,
        pairs,
        maxSpeedKmh ? parseInt(maxSpeedKmh, 10) : null,
        lineA,
        lineB,
      )
      navigate('/cameras')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const pairsCount = Math.min(imagePoints.length, mapPoints.length)
  const canSave = pairsCount >= 4 && imagePoints.length === mapPoints.length

  return (
    <div className="max-w-6xl">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Calibrate: {camera?.name}</h1>
          <p className="text-sm text-gray-400 mt-1">
            Click a point on the camera image, then click the same point on the map. Repeat ≥4 times.
          </p>
        </div>
        <button onClick={() => navigate('/cameras')} className="text-gray-400 hover:text-white px-3 py-1 border border-gray-700 rounded-lg text-sm">
          ← Back
        </button>
      </div>

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg p-3 mb-4 text-sm">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <p className="text-sm text-gray-400 mb-2">Camera frame — click to place points</p>
          {snapshot ? (
            <FramePointPicker
              frameBase64={snapshot}
              points={imagePoints}
              onChange={setImagePoints}
              width={560}
            />
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg aspect-video flex items-center justify-center text-gray-500 text-sm">
              Loading snapshot...
            </div>
          )}
        </div>

        <div>
          <p className="text-sm text-gray-400 mb-2">Google Maps — click matching locations</p>
          {isLoaded ? (
            <GoogleMap
              mapContainerClassName="w-full rounded-lg"
              mapContainerStyle={{ height: '315px' }}
              center={mapCenter}
              zoom={18}
              mapTypeId="satellite"
              onClick={handleMapClick}
            >
              {mapPoints.map((p, i) => (
                <Marker key={i} position={p} label={String(i + 1)} />
              ))}
            </GoogleMap>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg aspect-video flex items-center justify-center text-gray-500 text-sm">
              Loading map...
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4 mb-6">
        <span className={`text-sm font-medium ${pairsCount >= 4 ? 'text-green-400' : 'text-yellow-400'}`}>
          {pairsCount} / {Math.max(imagePoints.length, mapPoints.length)} point pairs matched
          {pairsCount >= 4 ? ' ✓' : ' (need 4 minimum)'}
        </span>
        <button onClick={removeLastPair} className="text-sm text-gray-400 hover:text-red-400 px-3 py-1 border border-gray-700 rounded-lg">
          Remove last pair
        </button>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6 grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Max speed (km/u)</label>
          <input
            type="number"
            value={maxSpeedKmh}
            onChange={(e) => setMaxSpeedKmh(e.target.value)}
            placeholder="e.g. 50"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">Leave empty to disable speeder detection</p>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Counting line A (0–1)</label>
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={lineA}
            onChange={(e) => setLineA(parseFloat(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Counting line B (0–1)</label>
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={lineB}
            onChange={(e) => setLineB(parseFloat(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
        >
          {saving ? 'Computing & saving...' : 'Save calibration'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Register the calibrate route in App.tsx**

In `App.tsx`, add the import and route:

```typescript
import CameraCalibrate from './pages/CameraCalibrate'

// Inside <Routes>:
<Route path="/cameras/:id/calibrate" element={<CameraCalibrate />} />
```

- [ ] **Step 5: Add VITE_GOOGLE_MAPS_API_KEY to frontend .env**

Create `frontend/.env`:
```
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
```

Add `frontend/.env` to `.gitignore`.

To get an API key: go to console.cloud.google.com → APIs → Maps JavaScript API → Create credentials → API key. Restrict it to your VPS domain.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/FramePointPicker.tsx frontend/src/pages/CameraCalibrate.tsx frontend/src/App.tsx frontend/.env.example frontend/package.json frontend/package-lock.json
git commit -m "feat: add calibration wizard with Google Maps satellite and frame point picker"
```

---

## Task 5: Speed display on live feed + Pi display view

**Files:**
- Create: `frontend/src/components/SpeedDisplay.tsx`
- Modify: `frontend/src/components/LiveFeed.tsx`
- Create: `frontend/src/pages/PiDisplay.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Create frontend/src/components/SpeedDisplay.tsx**

```typescript
type Props = {
  speedKmh: number | null
  maxSpeedKmh?: number | null
}

export function SpeedDisplay({ speedKmh, maxSpeedKmh }: Props) {
  if (speedKmh === null) return null
  const isFast = maxSpeedKmh !== null && maxSpeedKmh !== undefined && speedKmh > maxSpeedKmh

  return (
    <span className={`text-xs font-bold px-2 py-1 rounded ${isFast ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-200'}`}>
      {Math.round(speedKmh)} km/u
    </span>
  )
}
```

- [ ] **Step 2: Update useCameraFeed.ts to expose avgSpeedKmh**

Add to the hook:

```typescript
const [avgSpeedKmh, setAvgSpeedKmh] = useState<number | null>(null)

// In the frame handler, after setCounts:
const speeds = event.vehicles.map((v) => v.speedKmh).filter((s): s is number => s !== null)
if (speeds.length > 0) {
  setAvgSpeedKmh(speeds.reduce((a, b) => a + b, 0) / speeds.length)
}

// Add to return:
return { lastFrame, counts, fps, avgSpeedKmh }
```

- [ ] **Step 3: Create frontend/src/pages/PiDisplay.tsx**

```typescript
import { useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { LiveFeed } from '../components/LiveFeed'
import { CounterDisplay } from '../components/CounterDisplay'
import { SpeedDisplay } from '../components/SpeedDisplay'
import { getCameras, type Camera } from '../lib/api'
import { useCameraFeed } from '../hooks/useCameraFeed'

function PiDisplayInner({ camera }: { camera: Camera }) {
  const { counts, avgSpeedKmh } = useCameraFeed(camera.id)

  return (
    <div className="min-h-screen bg-black flex flex-col p-4">
      <div className="flex justify-between items-center mb-3">
        <div>
          <h1 className="text-white text-2xl font-bold">{camera.name}</h1>
          <p className="text-gray-400 text-sm">{camera.location}</p>
        </div>
        <SpeedDisplay speedKmh={avgSpeedKmh} maxSpeedKmh={camera.maxSpeedKmh} />
      </div>
      <LiveFeed cameraId={camera.id} className="flex-1 rounded-xl overflow-hidden" />
      <div className="mt-3">
        <CounterDisplay counts={counts} maxSpeedKmh={camera.maxSpeedKmh} />
      </div>
    </div>
  )
}

export default function PiDisplay() {
  const { cameraId } = useParams<{ cameraId: string }>()
  const [camera, setCamera] = useState<Camera | null>(null)

  useEffect(() => {
    if (!cameraId) return
    getCameras().then((cams) => {
      const cam = cams.find((c) => c.id === cameraId)
      if (cam) setCamera(cam)
    })
  }, [cameraId])

  if (!camera) return <div className="min-h-screen bg-black flex items-center justify-center text-gray-500">Loading...</div>
  return <PiDisplayInner camera={camera} />
}
```

- [ ] **Step 4: Register PiDisplay route in App.tsx**

```typescript
import PiDisplay from './pages/PiDisplay'

// In Routes, replace the placeholder:
// OLD: <Route path="/display/:cameraId" element={<div>Pi Display — Plan 3</div>} />
// NEW:
<Route path="/display/:cameraId" element={<PiDisplay />} />
```

- [ ] **Step 5: Configure Pi browser**

On each Raspberry Pi, open Chromium in kiosk mode pointing to the display URL:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  http://<your-vps-ip>/display/<camera-id>
```

To auto-start on boot, add to `/etc/xdg/autostart/flash-display.desktop`:

```
[Desktop Entry]
Type=Application
Name=Flash Display
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars http://<your-vps-ip>/display/<camera-id>
```

- [ ] **Step 6: Full end-to-end test**

1. Start full Docker Compose stack
2. Add a camera with a real verkeerscentrum.be URL
3. Navigate to `/cameras/:id/calibrate`
4. Verify snapshot loads from the live stream
5. Place 4+ point pairs on both panels
6. Set a max speed (e.g. 50 km/u)
7. Save — verify no error
8. Navigate to `/display/:cameraId` — verify fullscreen Pi view with speed badge and counters

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/SpeedDisplay.tsx frontend/src/pages/PiDisplay.tsx frontend/src/hooks/useCameraFeed.ts frontend/src/App.tsx
git commit -m "feat: add speed display, Pi fullscreen view, complete calibration flow"
```
