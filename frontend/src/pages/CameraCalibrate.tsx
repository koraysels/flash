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
    <div className="border-2 border-black p-4 mb-6 text-xs">
      <p className="font-bold uppercase tracking-widest mb-2">How to calibrate</p>
      <ol className="space-y-1 list-decimal list-inside text-stone-600">
        <li><strong className="text-black">Find a real-world landmark</strong> visible in the camera image — road marking, corner, pole.</li>
        <li><strong className="text-black">Click it in the camera image</strong> (left). A numbered pin appears.</li>
        <li><strong className="text-black">Click the exact same spot on the satellite map</strong> (right). Search first to navigate.</li>
        <li><strong className="text-black">Repeat ≥4 times</strong> — spread across the frame for accuracy.</li>
      </ol>
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
  const [trapSpeedEnabled, setTrapSpeedEnabled] = useState(false)
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
      setTrapSpeedEnabled(cam.trapSpeedEnabled ?? false)

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
        trapSpeedEnabled,
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
          <p className="text-xs uppercase tracking-widest text-stone-400 mb-1">Calibrate</p>
          <h1 className="text-lg font-bold uppercase">{camera?.name ?? '...'}</h1>
          <p className="text-xs text-stone-500">{camera?.location}</p>
        </div>
        <button onClick={() => navigate('/cameras')} className="text-xs uppercase tracking-widest border-2 border-black px-3 py-1.5 hover:bg-black hover:text-white transition-colors">
          ← Back
        </button>
      </div>

      <CalibrationHelp />

      {error && (
        <div className="border-2 border-red-600 text-red-600 p-3 mb-4 text-xs uppercase">{error}</div>
      )}
      {snapshotMissing && !snapshot && (
        <div className="border-2 border-black p-3 mb-4 text-xs">
          No live snapshot — camera may still be starting. Upload a screenshot to calibrate now.
        </div>
      )}
      {hasExistingHomography && (
        <div className="border-2 border-black p-3 mb-4 text-xs">
          Calibration saved. Update lines and speed limit, or re-pick all points to recalibrate.
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center gap-4 mb-3 text-xs">
        <span className={`uppercase tracking-widest font-bold ${pairsCount >= 4 ? 'text-black' : hasExistingHomography ? 'text-stone-400' : 'text-stone-600'}`}>
          {pairsCount} / 4+ pairs {pairsCount >= 4 ? '✓' : hasExistingHomography ? '(saved)' : ''}
        </span>
        {awaitingMapPoint && <span className="animate-pulse uppercase tracking-widest">→ Click same spot on map</span>}
        {awaitingFramePoint && <span className="animate-pulse uppercase tracking-widest">← Click same spot on image</span>}
        <button onClick={removeLastPair} disabled={pairsCount === 0} className="ml-auto border border-black px-2 py-1 uppercase tracking-widest hover:bg-black hover:text-white disabled:opacity-30 transition-colors">
          Remove last pair
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-stone-500 mb-2">① Camera image — click landmarks</p>
          {snapshot ? (
            <FramePointPicker frameBase64={snapshot} points={imagePoints} onChange={handleFramePoint} width={640} />
          ) : snapshotMissing ? (
            <label className="border-2 border-black border-dashed aspect-video flex flex-col items-center justify-center text-stone-400 text-sm cursor-pointer gap-2 hover:border-solid">
              <span className="text-3xl">↑</span>
              <span className="text-xs uppercase tracking-widest">Upload screenshot</span>
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
            <div className="border-2 border-black aspect-video flex items-center justify-center text-stone-400 text-xs uppercase tracking-widest">
              Loading snapshot...
            </div>
          )}
        </div>

        <div>
          <p className="text-xs uppercase tracking-widest text-stone-500 mb-2">② Satellite map — click same locations</p>
          {isLoaded ? (
            <div>
              <StandaloneSearchBox onLoad={onSearchBoxLoad} onPlacesChanged={onPlacesChanged}>
                <input
                  type="text"
                  placeholder="Search location..."
                  className="w-full border-2 border-black px-3 py-2 text-xs mb-2 focus:outline-none bg-white"
                />
              </StandaloneSearchBox>
              <GoogleMap
                mapContainerClassName="w-full"
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
            <div className="border-2 border-black aspect-video flex items-center justify-center text-stone-400 text-xs uppercase tracking-widest">
              {GOOGLE_MAPS_API_KEY ? 'Loading map...' : (
                <div className="text-center px-4">
                  <p>Google Maps not configured</p>
                  <p className="text-stone-400 mt-1">Add VITE_GOOGLE_MAPS_API_KEY to frontend/.env</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Counting lines + settings */}
      <div className="border-2 border-black p-4 mb-6">
        <p className="text-xs font-bold uppercase tracking-widest mb-1">Counting Lines</p>
        <p className="text-xs text-stone-500 mb-3">
          Drag endpoints to align each line across the road.
          A→B: crosses A then B. B→A: crosses B then A.
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
          <div className="border border-stone-200 h-32 flex items-center justify-center text-stone-400 text-xs uppercase tracking-widest">
            Waiting for snapshot…
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-6 items-start">
          <div>
            <label className="block text-xs uppercase tracking-widest text-stone-500 mb-1">Max speed (km/h)</label>
            <input
              type="number"
              value={maxSpeedKmh}
              onChange={(e) => setMaxSpeedKmh(e.target.value)}
              placeholder="120"
              className="w-32 border-2 border-black px-3 py-2 text-sm focus:outline-none bg-white"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-widest text-stone-500 mb-2">Speed Method</label>
            <button
              type="button"
              onClick={() => setTrapSpeedEnabled((v) => !v)}
              className={`flex items-center gap-3 px-3 py-2 border-2 text-xs uppercase tracking-widest transition-colors ${
                trapSpeedEnabled ? 'border-black bg-black text-white' : 'border-black bg-white text-black'
              }`}
            >
              <span className={`w-8 h-4 border border-current flex items-center px-0.5 transition-colors ${trapSpeedEnabled ? 'bg-white' : 'bg-transparent'}`}>
                <span className={`w-3 h-3 transition-transform ${trapSpeedEnabled ? 'bg-black translate-x-4' : 'bg-current translate-x-0'}`} />
              </span>
              {trapSpeedEnabled ? 'Trap (A→B time)' : 'Continuous (homography)'}
            </button>
            <p className="text-xs text-stone-400 mt-1">
              {trapSpeedEnabled ? 'Exact — like trajectcontrole' : 'Real-time per-frame estimate'}
            </p>
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={!canSave || saving}
        className="text-xs uppercase tracking-widest border-2 border-black px-6 py-2 hover:bg-black hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? 'Saving…' : canSave
          ? pairsCount >= 4 ? `Save (${pairsCount} pairs)` : 'Save lines & speed limit'
          : `Need ${Math.max(0, 4 - pairsCount)} more pairs`}
      </button>
    </div>
  )
}
