import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { GoogleMap, useJsApiLoader, Marker, StandaloneSearchBox } from '@react-google-maps/api'
import { Stage, Layer, Image as KonvaImage, Line, Circle, Text as KonvaText } from 'react-konva'
import useImage from 'use-image'
import { FramePointPicker } from '../components/FramePointPicker'
import { getCameraSnapshot, saveCalibration, getCameras, type Camera, type CalibrationPoint } from '../lib/api'

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string
const LIBRARIES: ('places')[] = ['places']

type LatLng = { lat: number; lng: number }
type Pt = { x: number; y: number }  // normalised 0-1

// ─── Line Editor ────────────────────────────────────────────────────────────
// Shows the camera snapshot with two draggable lines overlaid.
// Each line is defined by two endpoints in normalised [0,1] coords.

interface LineEditorProps {
  frameBase64: string
  lineA: [Pt, Pt]
  lineB: [Pt, Pt]
  onChangeA: (pts: [Pt, Pt]) => void
  onChangeB: (pts: [Pt, Pt]) => void
  width?: number
}

function LineEditor({ frameBase64, lineA, lineB, onChangeA, onChangeB, width = 640 }: LineEditorProps) {
  const [img] = useImage(`data:image/jpeg;base64,${frameBase64}`)
  const scale = img ? width / img.width : 1
  const height = img ? img.height * scale : width * 0.5625

  const toCanvas = (p: Pt) => ({ x: p.x * width, y: p.y * height })
  const toNorm = (x: number, y: number): Pt => ({ x: x / width, y: y / height })
  const clamp = (p: Pt): Pt => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) })

  const handle = (
    pts: [Pt, Pt],
    idx: 0 | 1,
    onChange: (pts: [Pt, Pt]) => void,
    x: number, y: number,
  ) => {
    const updated: [Pt, Pt] = [...pts] as [Pt, Pt]
    updated[idx] = clamp(toNorm(x, y))
    onChange(updated)
  }

  const renderLine = (pts: [Pt, Pt], color: string, label: string, onChange: (pts: [Pt, Pt]) => void) => {
    const p0 = toCanvas(pts[0])
    const p1 = toCanvas(pts[1])
    return (
      <>
        <Line
          points={[p0.x, p0.y, p1.x, p1.y]}
          stroke={color} strokeWidth={2} dash={[10, 5]}
        />
        <KonvaText text={label} x={p0.x + 6} y={p0.y - 16} fill={color} fontSize={13} fontStyle="bold" fontFamily="monospace" />
        {([0, 1] as const).map((i) => {
          const p = toCanvas(pts[i])
          return (
            <Circle
              key={i}
              x={p.x} y={p.y} radius={7}
              fill={color} stroke="#000" strokeWidth={1.5} opacity={0.9}
              draggable
              onDragEnd={(e) => handle(pts, i, onChange, e.target.x(), e.target.y())}
              dragBoundFunc={(pos) => ({
                x: Math.max(0, Math.min(width, pos.x)),
                y: Math.max(0, Math.min(height, pos.y)),
              })}
            />
          )
        })}
      </>
    )
  }

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden cursor-default">
      <Stage width={width} height={height}>
        <Layer>
          {img && <KonvaImage image={img} scaleX={scale} scaleY={scale} />}
          {renderLine(lineA, 'rgba(255,220,0,0.9)', 'A', onChangeA)}
          {renderLine(lineB, 'rgba(255,220,0,0.9)', 'B', onChangeB)}
        </Layer>
      </Stage>
    </div>
  )
}

// ─── Calibration Help ───────────────────────────────────────────────────────

function CalibrationHelp() {
  return (
    <div className="bg-blue-950 border border-blue-900 rounded-xl p-4 mb-6 text-sm text-blue-200">
      <h3 className="font-semibold mb-2 text-blue-100">How to calibrate (4 steps)</h3>
      <ol className="space-y-1.5 list-decimal list-inside text-blue-300">
        <li><strong className="text-blue-100">Find a real-world landmark</strong> visible in the camera image — a road marking, corner, pole, etc.</li>
        <li><strong className="text-blue-100">Click it in the camera image</strong> (left panel). A numbered pin appears.</li>
        <li><strong className="text-blue-100">Click the exact same spot on the satellite map</strong> (right panel). Use the search bar to navigate first.</li>
        <li><strong className="text-blue-100">Repeat ≥4 times</strong> — spread across the frame for accuracy.</li>
      </ol>
      <p className="mt-2 text-blue-400 text-xs">
        The homography matrix computed from these pairs maps pixel positions to real-world metres — enabling accurate speed calculation.
      </p>
    </div>
  )
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function CameraCalibrate() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [camera, setCamera] = useState<Camera | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [imagePoints, setImagePoints] = useState<Pt[]>([])
  const [mapPoints, setMapPoints] = useState<LatLng[]>([])
  const [maxSpeedKmh, setMaxSpeedKmh] = useState('')
  // Counting lines: two endpoints each in normalised [0,1] coords
  const [lineA, setLineA] = useState<[Pt, Pt]>([{ x: 0, y: 0.4 }, { x: 1, y: 0.4 }])
  const [lineB, setLineB] = useState<[Pt, Pt]>([{ x: 0, y: 0.6 }, { x: 1, y: 0.6 }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snapshotMissing, setSnapshotMissing] = useState(false)
  const [mapCenter, setMapCenter] = useState<LatLng>({ lat: 51.22, lng: 4.40 })
  const [mapZoom, setMapZoom] = useState(18)
  const mapRef = useRef<google.maps.Map | null>(null)
  const searchBoxRef = useRef<google.maps.places.SearchBox | null>(null)

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: GOOGLE_MAPS_API_KEY ?? '',
    libraries: LIBRARIES,
  })

  useEffect(() => {
    if (!id) return
    let cancelled = false

    getCameras().then((cams) => {
      if (cancelled) return
      const cam = cams.find((c) => c.id === id)
      if (!cam) return
      setCamera(cam)
      setMaxSpeedKmh(cam.maxSpeedKmh?.toString() ?? '')

      // Restore counting lines from saved state
      if (cam.countingLineAPoints?.length === 4) {
        const [x1, y1, x2, y2] = cam.countingLineAPoints
        setLineA([{ x: x1, y: y1 }, { x: x2, y: y2 }])
      } else {
        const y = cam.countingLineA ?? 0.4
        setLineA([{ x: 0, y }, { x: 1, y }])
      }
      if (cam.countingLineBPoints?.length === 4) {
        const [x1, y1, x2, y2] = cam.countingLineBPoints
        setLineB([{ x: x1, y: y1 }, { x: x2, y: y2 }])
      } else {
        const y = cam.countingLineB ?? 0.6
        setLineB([{ x: 0, y }, { x: 1, y }])
      }

      // Restore image calibration points (px, py) from saved pairs
      if (Array.isArray(cam.calibrationPoints) && cam.calibrationPoints.length >= 4) {
        setImagePoints(cam.calibrationPoints.map((p) => ({ x: p.px, y: p.py })))
      }
    })

    getCameraSnapshot(id)
      .then((frame) => { if (!cancelled) setSnapshot(frame) })
      .catch(() => { if (!cancelled) setSnapshotMissing(true) })

    return () => { cancelled = true }
  }, [id])

  const awaitingMapPoint = imagePoints.length > mapPoints.length
  const awaitingFramePoint = mapPoints.length > imagePoints.length

  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => {
    if (!e.latLng || !awaitingMapPoint) return
    setMapPoints((pts) => [...pts, { lat: e.latLng!.lat(), lng: e.latLng!.lng() }])
  }, [awaitingMapPoint])

  function handleFramePoint(pts: Pt[]) {
    if (pts.length > imagePoints.length && awaitingFramePoint) return
    setImagePoints(pts)
  }

  function removeLastPair() {
    setImagePoints((pts) => pts.slice(0, -1))
    setMapPoints((pts) => pts.slice(0, -1))
  }

  function onSearchBoxLoad(ref: google.maps.places.SearchBox) { searchBoxRef.current = ref }

  function onPlacesChanged() {
    const places = searchBoxRef.current?.getPlaces()
    if (!places?.length) return
    const loc = places[0].geometry?.location
    if (!loc) return
    setMapCenter({ lat: loc.lat(), lng: loc.lng() })
    setMapZoom(18)
    mapRef.current?.panTo({ lat: loc.lat(), lng: loc.lng() })
    mapRef.current?.setZoom(18)
  }

  const lineAFlat = (): number[] => [lineA[0].x, lineA[0].y, lineA[1].x, lineA[1].y]
  const lineBFlat = (): number[] => [lineB[0].x, lineB[0].y, lineB[1].x, lineB[1].y]

  // Fallback Y fraction (midpoint Y of the line)
  const lineAFrac = () => (lineA[0].y + lineA[1].y) / 2
  const lineBFrac = () => (lineB[0].y + lineB[1].y) / 2

  async function handleSave() {
    if (!id) return
    const pairsReady = imagePoints.length >= 4 && imagePoints.length === mapPoints.length
    const linesOnly = camera?.homographyMatrix?.length === 9 && !pairsReady
    if (!pairsReady && !linesOnly) return

    setSaving(true)
    setError(null)
    try {
      let pairs: CalibrationPoint[] = []
      if (pairsReady) {
        const origin = mapPoints[0]
        const R = 6371000
        pairs = imagePoints.map((ip, i) => {
          const mp = mapPoints[i]
          const dLat = ((mp.lat - origin.lat) * Math.PI) / 180
          const dLng = ((mp.lng - origin.lng) * Math.PI) / 180
          return {
            px: ip.x, py: ip.y,
            wx: dLng * R * Math.cos((origin.lat * Math.PI) / 180),
            wy: dLat * R,
          }
        })
      }
      await saveCalibration(
        id, pairs,
        maxSpeedKmh ? parseInt(maxSpeedKmh, 10) : null,
        lineAFrac(), lineBFrac(),
        lineAFlat(), lineBFlat(),
      )
      navigate('/cameras')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const pairsCount = Math.min(imagePoints.length, mapPoints.length)
  const hasExistingHomography = (camera?.homographyMatrix?.length ?? 0) === 9
  const canSave = (pairsCount >= 4 && imagePoints.length === mapPoints.length) || hasExistingHomography

  return (
    <div className="max-w-screen-2xl">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Calibrate: {camera?.name ?? '...'}</h1>
          <p className="text-sm text-gray-400 mt-1">{camera?.location}</p>
        </div>
        <button onClick={() => navigate('/cameras')} className="text-gray-400 hover:text-white px-3 py-1 border border-gray-700 rounded-lg text-sm">
          ← Back
        </button>
      </div>

      <CalibrationHelp />

      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 rounded-lg p-3 mb-4 text-sm">{error}</div>
      )}
      {snapshotMissing && !snapshot && (
        <div className="bg-yellow-950 border border-yellow-800 text-yellow-300 rounded-lg p-3 mb-4 text-sm">
          No live snapshot yet — camera may still be starting. Upload a screenshot to calibrate now.
        </div>
      )}
      {hasExistingHomography && (
        <div className="bg-green-950 border border-green-900 text-green-300 rounded-lg p-3 mb-4 text-sm">
          Speed calibration already saved. You can update lines and speed limit, or re-pick all points to recalibrate.
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center gap-4 mb-3">
        <span className={`text-sm font-medium ${pairsCount >= 4 ? 'text-green-400' : hasExistingHomography ? 'text-gray-400' : 'text-yellow-400'}`}>
          {pairsCount} / 4+ point pairs {pairsCount >= 4 ? '✓' : hasExistingHomography ? '(using saved calibration)' : ''}
        </span>
        {awaitingMapPoint && <span className="text-sm text-blue-400 animate-pulse">→ Now click the same spot on the map</span>}
        {awaitingFramePoint && <span className="text-sm text-yellow-400 animate-pulse">← Now click the same spot on the camera image</span>}
        {!awaitingMapPoint && !awaitingFramePoint && pairsCount > 0 && !hasExistingHomography && (
          <span className="text-sm text-gray-500">Click a point on the camera image to continue</span>
        )}
        <button onClick={removeLastPair} disabled={pairsCount === 0} className="ml-auto text-sm text-gray-400 hover:text-red-400 disabled:opacity-40 px-3 py-1 border border-gray-700 rounded-lg">
          Remove last pair
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        {/* Camera image */}
        <div>
          <p className="text-sm font-medium text-gray-300 mb-2">① Camera image — click landmarks</p>
          {snapshot ? (
            <FramePointPicker frameBase64={snapshot} points={imagePoints} onChange={handleFramePoint} width={640} />
          ) : snapshotMissing ? (
            <label className="bg-gray-900 border-2 border-dashed border-gray-700 hover:border-gray-500 rounded-lg aspect-video flex flex-col items-center justify-center text-gray-400 text-sm cursor-pointer gap-2">
              <span className="text-3xl">↑</span>
              <span>Upload camera screenshot</span>
              <span className="text-xs text-gray-600">PNG, JPG — any screenshot of the camera view</span>
              <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = (ev) => {
                  const dataUrl = ev.target?.result as string
                  setSnapshot(dataUrl.split(',')[1])
                }
                reader.readAsDataURL(file)
              }} />
            </label>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg aspect-video flex items-center justify-center text-gray-500 text-sm">
              Loading snapshot...
            </div>
          )}
        </div>

        {/* Map */}
        <div>
          <p className="text-sm font-medium text-gray-300 mb-2">② Satellite map — click same locations</p>
          {isLoaded ? (
            <div>
              <StandaloneSearchBox onLoad={onSearchBoxLoad} onPlacesChanged={onPlacesChanged}>
                <input
                  type="text"
                  placeholder="Search for a street or location..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:border-blue-500"
                />
              </StandaloneSearchBox>
              <GoogleMap
                mapContainerClassName="w-full rounded-lg"
                mapContainerStyle={{ height: '460px' }}
                center={mapCenter}
                zoom={mapZoom}
                mapTypeId="satellite"
                onClick={handleMapClick}
                onLoad={(map) => { mapRef.current = map }}
              >
                {mapPoints.map((p, i) => (
                  <Marker key={i} position={p} label={{ text: String(i + 1), color: 'white', fontWeight: 'bold' }} />
                ))}
              </GoogleMap>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg aspect-video flex items-center justify-center text-gray-500 text-sm">
              {GOOGLE_MAPS_API_KEY ? 'Loading map...' : (
                <div className="text-center px-4">
                  <p className="mb-1">Google Maps not configured</p>
                  <p className="text-xs text-gray-600">Add VITE_GOOGLE_MAPS_API_KEY to frontend/.env</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Counting lines + settings */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
        <h3 className="text-sm font-semibold text-gray-300 mb-1">Counting lines</h3>
        <p className="text-xs text-gray-500 mb-3">
          Drag the endpoints to align each line with a fixed point across the road.
          Vehicles crossing A then B count as <strong className="text-gray-300">A→B</strong>; crossing B then A counts as <strong className="text-gray-300">B→A</strong>.
        </p>
        {snapshot ? (
          <LineEditor
            frameBase64={snapshot}
            lineA={lineA}
            lineB={lineB}
            onChangeA={setLineA}
            onChangeB={setLineB}
            width={640}
          />
        ) : (
          <div className="bg-gray-800 rounded-lg h-32 flex items-center justify-center text-gray-500 text-sm">
            Waiting for camera snapshot…
          </div>
        )}

        <div className="mt-4">
          <label className="block text-sm text-gray-400 mb-1">Max speed limit (km/h)</label>
          <input
            type="number"
            value={maxSpeedKmh}
            onChange={(e) => setMaxSpeedKmh(e.target.value)}
            placeholder="e.g. 120"
            className="w-40 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">Vehicles above this are flagged as speeders</p>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={!canSave || saving}
        className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
      >
        {saving ? 'Saving…' : canSave
          ? pairsCount >= 4 ? `Save calibration (${pairsCount} pairs)` : 'Save lines & speed limit'
          : `Need ${Math.max(0, 4 - pairsCount)} more point pairs`}
      </button>
    </div>
  )
}
