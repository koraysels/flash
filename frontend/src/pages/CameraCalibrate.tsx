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
  const [maxSpeedKmh, setMaxSpeedKmh] = useState('')
  const [lineA, setLineA] = useState(0.4)
  const [lineB, setLineB] = useState(0.6)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { isLoaded } = useJsApiLoader({ googleMapsApiKey: GOOGLE_MAPS_API_KEY ?? '' })

  useEffect(() => {
    if (!id) return
    getCameras().then((cams) => {
      const cam = cams.find((c) => c.id === id)
      if (cam) {
        setCamera(cam)
        setMaxSpeedKmh(cam.maxSpeedKmh?.toString() ?? '')
        setLineA(cam.countingLineA ?? 0.4)
        setLineB(cam.countingLineB ?? 0.6)
      }
    })
    getCameraSnapshot(id)
      .then(setSnapshot)
      .catch(() => setError('No camera snapshot available — make sure the stream is active.'))
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
          <p className="text-sm text-gray-400 mt-1">
            Click a point on the camera image, then the same point on the map. Repeat ≥4 times.
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
            <FramePointPicker frameBase64={snapshot} points={imagePoints} onChange={setImagePoints} width={560} />
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg aspect-video flex items-center justify-center text-gray-500 text-sm">
              {error ? 'No snapshot' : 'Loading snapshot...'}
            </div>
          )}
        </div>
        <div>
          <p className="text-sm text-gray-400 mb-2">Google Maps — click matching locations</p>
          {isLoaded ? (
            <GoogleMap
              mapContainerClassName="w-full rounded-lg"
              mapContainerStyle={{ height: '315px' }}
              center={{ lat: 50.85, lng: 4.35 }}
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
              {GOOGLE_MAPS_API_KEY ? 'Loading map...' : 'Set VITE_GOOGLE_MAPS_API_KEY to enable map'}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4 mb-6">
        <span className={`text-sm font-medium ${pairsCount >= 4 ? 'text-green-400' : 'text-yellow-400'}`}>
          {pairsCount} point pairs {pairsCount >= 4 ? '✓' : '(need 4 minimum)'}
        </span>
        <button onClick={removeLastPair} disabled={pairsCount === 0} className="text-sm text-gray-400 hover:text-red-400 disabled:opacity-40 px-3 py-1 border border-gray-700 rounded-lg">
          Remove last pair
        </button>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6 grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Max speed (km/u)</label>
          <input type="number" value={maxSpeedKmh} onChange={(e) => setMaxSpeedKmh(e.target.value)} placeholder="e.g. 50" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
          <p className="text-xs text-gray-500 mt-1">Leave empty to disable speeder detection</p>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Counting line A (0–1)</label>
          <input type="number" step="0.05" min="0" max="1" value={lineA} onChange={(e) => setLineA(parseFloat(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Counting line B (0–1)</label>
          <input type="number" step="0.05" min="0" max="1" value={lineB} onChange={(e) => setLineB(parseFloat(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={!canSave || saving}
        className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed px-6 py-2 rounded-lg font-medium"
      >
        {saving ? 'Computing & saving...' : 'Save calibration'}
      </button>
    </div>
  )
}
