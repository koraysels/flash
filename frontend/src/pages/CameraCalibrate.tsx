import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { GoogleMap, useJsApiLoader, Marker, StandaloneSearchBox } from '@react-google-maps/api'
import { FramePointPicker } from '../components/FramePointPicker'
import { getCameraSnapshot, saveCalibration, getCameras, type Camera, type CalibrationPoint } from '../lib/api'

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string
const LIBRARIES: ('places')[] = ['places']

type LatLng = { lat: number; lng: number }

function CalibrationHelp() {
  return (
    <div className="bg-blue-950 border border-blue-900 rounded-xl p-4 mb-6 text-sm text-blue-200">
      <h3 className="font-semibold mb-2 text-blue-100">How to calibrate (4 steps)</h3>
      <ol className="space-y-1.5 list-decimal list-inside text-blue-300">
        <li>
          <strong className="text-blue-100">Find a real-world landmark</strong> visible in the camera image — a road marking, corner, pole, etc.
        </li>
        <li>
          <strong className="text-blue-100">Click it in the camera image</strong> (left panel). A numbered pin appears.
        </li>
        <li>
          <strong className="text-blue-100">Click the exact same spot on the satellite map</strong> (right panel). Use the search bar to navigate to the location first.
        </li>
        <li>
          <strong className="text-blue-100">Repeat ≥4 times</strong> — spread across the frame for accuracy. The more points, the better speed estimation works.
        </li>
      </ol>
      <p className="mt-2 text-blue-400 text-xs">
        The homography matrix computed from these pairs maps pixel positions to real-world metres — enabling accurate speed calculation.
      </p>
    </div>
  )
}

function CountingLineHelp({ lineA, lineB }: { lineA: number; lineB: number }) {
  return (
    <div className="mt-2 p-3 bg-gray-800 rounded-lg text-xs text-gray-400">
      <div className="relative h-16 bg-gray-700 rounded overflow-hidden mb-2">
        <div className="absolute inset-x-0 bg-yellow-500/30 border-t-2 border-yellow-400" style={{ top: `${lineA * 100}%` }}>
          <span className="text-yellow-300 text-xs pl-1">Line A ({Math.round(lineA * 100)}% from top)</span>
        </div>
        <div className="absolute inset-x-0 bg-yellow-500/30 border-t-2 border-yellow-400" style={{ top: `${lineB * 100}%` }}>
          <span className="text-yellow-300 text-xs pl-1">Line B ({Math.round(lineB * 100)}% from top)</span>
        </div>
        <div className="absolute left-2 top-1 text-gray-500 text-xs">↑ top of frame</div>
        <div className="absolute left-2 bottom-1 text-gray-500 text-xs">↓ bottom of frame</div>
      </div>
      <p>A vehicle crossing from Line A to Line B counts as <strong className="text-gray-200">A→B</strong>. Crossing in reverse counts as <strong className="text-gray-200">B→A</strong>. Position these lines across a lane where vehicles pass clearly.</p>
    </div>
  )
}

export default function CameraCalibrate() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [camera, setCamera] = useState<Camera | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [imagePoints, setImagePoints] = useState<Array<{ x: number; y: number }>>([])
  const [mapPoints, setMapPoints] = useState<LatLng[]>([])
  const [maxSpeedKmh, setMaxSpeedKmh] = useState('')
  const [lineA, setLineA] = useState(0.4)
  const [lineB, setLineB] = useState(0.6)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snapshotMissing, setSnapshotMissing] = useState(false)
  const [mapCenter, setMapCenter] = useState<LatLng>({ lat: 51.22, lng: 4.40 }) // Belgium default
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
      if (cam) {
        setCamera(cam)
        setMaxSpeedKmh(cam.maxSpeedKmh?.toString() ?? '')
        setLineA(cam.countingLineA ?? 0.4)
        setLineB(cam.countingLineB ?? 0.6)
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
    if (!e.latLng) return
    if (!awaitingMapPoint) return
    setMapPoints((pts) => [...pts, { lat: e.latLng!.lat(), lng: e.latLng!.lng() }])
  }, [awaitingMapPoint])

  function handleFramePoint(pts: Array<{ x: number; y: number }>) {
    if (pts.length > imagePoints.length && awaitingFramePoint) return
    setImagePoints(pts)
  }

  function removeLastPair() {
    setImagePoints((pts) => pts.slice(0, -1))
    setMapPoints((pts) => pts.slice(0, -1))
  }

  function onSearchBoxLoad(ref: google.maps.places.SearchBox) {
    searchBoxRef.current = ref
  }

  function onPlacesChanged() {
    const places = searchBoxRef.current?.getPlaces()
    if (!places?.length) return
    const place = places[0]
    const loc = place.geometry?.location
    if (!loc) return
    setMapCenter({ lat: loc.lat(), lng: loc.lng() })
    setMapZoom(18)
    mapRef.current?.panTo({ lat: loc.lat(), lng: loc.lng() })
    mapRef.current?.setZoom(18)
  }

  async function handleSave() {
    if (!id || imagePoints.length < 4 || imagePoints.length !== mapPoints.length) return
    setSaving(true)
    setError(null)
    try {
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
      await saveCalibration(id, pairs, maxSpeedKmh ? parseInt(maxSpeedKmh, 10) : null, lineA, lineB)
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

      {/* Status bar */}
      <div className="flex items-center gap-4 mb-3">
        <span className={`text-sm font-medium ${pairsCount >= 4 ? 'text-green-400' : 'text-yellow-400'}`}>
          {pairsCount} / 4+ point pairs {pairsCount >= 4 ? '✓ ready to save' : ''}
        </span>
        {awaitingMapPoint && (
          <span className="text-sm text-blue-400 animate-pulse">→ Now click the same spot on the map</span>
        )}
        {awaitingFramePoint && (
          <span className="text-sm text-yellow-400 animate-pulse">← Now click the same spot on the camera image</span>
        )}
        {!awaitingMapPoint && !awaitingFramePoint && pairsCount > 0 && (
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
            <FramePointPicker frameBase64={snapshot} points={imagePoints} onChange={handleFramePoint} width={560} />
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
                mapContainerStyle={{ height: '270px' }}
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

      {/* Settings */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Detection settings</h3>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Max speed limit (km/h)</label>
            <input type="number" value={maxSpeedKmh} onChange={(e) => setMaxSpeedKmh(e.target.value)} placeholder="e.g. 50" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            <p className="text-xs text-gray-500 mt-1">Vehicles above this are flagged as speeders</p>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Counting line A position</label>
            <input type="number" step="0.05" min="0" max="1" value={lineA} onChange={(e) => setLineA(parseFloat(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            <p className="text-xs text-gray-500 mt-1">0 = top, 1 = bottom of frame</p>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Counting line B position</label>
            <input type="number" step="0.05" min="0" max="1" value={lineB} onChange={(e) => setLineB(parseFloat(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
            <p className="text-xs text-gray-500 mt-1">Must be different from line A</p>
          </div>
        </div>
        <CountingLineHelp lineA={lineA} lineB={lineB} />
      </div>

      <button
        onClick={handleSave}
        disabled={!canSave || saving}
        className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
      >
        {saving ? 'Computing homography & saving...' : canSave ? `Save calibration (${pairsCount} pairs)` : `Need ${Math.max(0, 4 - pairsCount)} more point pairs`}
      </button>
      {!canSave && pairsCount > 0 && pairsCount < 4 && (
        <p className="mt-2 text-xs text-gray-500">
          You have {pairsCount} pair{pairsCount !== 1 ? 's' : ''} — {4 - pairsCount} more needed before saving.
        </p>
      )}
    </div>
  )
}
