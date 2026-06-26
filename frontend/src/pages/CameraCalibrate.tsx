import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { GoogleMap, useJsApiLoader, Marker, StandaloneSearchBox } from '@react-google-maps/api'
import { Stage, Layer, Image as KonvaImage, Line, Circle, Text as KonvaText } from 'react-konva'
import useImage from 'use-image'
import { FramePointPicker } from '../components/FramePointPicker'
import { ROIEditor } from '../components/ROIEditor'
import { DirectionZonesEditor, type Zone } from '../components/DirectionZonesEditor'
import { Tabs, TabPanel } from '../components/ui/Tabs'
import { Panel, SectionTitle, Toggle, Button } from '../components/ui/primitives'
import {
  getCameraSnapshot, saveCalibration, getCameras, saveTrackingConfig, saveRoi, saveDirectionZones,
  type Camera, type CalibrationPoint, type TrackerConfig, DEFAULT_TRACKER_CONFIG,
} from '../lib/api'

const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string
const LIBRARIES: ('places')[] = ['places']

type LatLng = { lat: number; lng: number }
type Pt = { x: number; y: number }  // normalised 0-1

// ─── Tracking Tuning ────────────────────────────────────────────────────────

type SliderDef = {
  key: keyof TrackerConfig
  label: string
  description: string
  symptomLow: string
  symptomHigh: string
  min: number
  max: number
  step: number
  format?: (v: number) => string
}

const SLIDER_DEFS: SliderDef[] = [
  {
    key: 'highConfidence',
    label: 'Min. detectie zekerheid',
    description: 'Min. confidence voor een detectie meetelt.',
    symptomLow: 'Veel valse / ghost-boxen',
    symptomHigh: 'Mist zwakke / verre auto\'s (auto\'s verdwijnen)',
    min: 0.40, max: 0.75, step: 0.01,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'iouStage1',
    label: 'IoU drempel (stage 1)',
    description: 'Hoe sterk een box moet overlappen met de KF-voorspelling voor de eerste matching.',
    symptomLow: 'ID-wissels tussen dicht bij elkaar rijdende voertuigen',
    symptomHigh: 'Tracks verdwijnen kort (bvb. bij occlusie)',
    min: 0.20, max: 0.55, step: 0.01,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'iouStage2',
    label: 'IoU drempel (stage 2 recovery)',
    description: 'Lossere drempel om tracks te redden via zwakke / gedeeltelijke detecties.',
    symptomLow: 'ID-wissels bij occlusie',
    symptomHigh: 'Weinig effect zichtbaar',
    min: 0.05, max: 0.25, step: 0.01,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'maxPredictedGap',
    label: 'Max. voorspelde frames',
    description: 'Hoeveel frames een box zichtbaar blijft via KF-voorspelling als de detector niks ziet.',
    symptomLow: 'Box knippert elke gemiste detectie',
    symptomHigh: 'Box drijft weg bij lange occlusie',
    min: 1, max: 8, step: 1,
    format: (v) => `${v} fr`,
  },
  {
    key: 'maxMissedFrames',
    label: 'Max. gemiste frames (track leven)',
    description: 'Na hoeveel opeenvolgende missers verdwijnt een track definitief.',
    symptomLow: 'Voertuigen verdwijnen te snel (bvb. stilstaand)',
    symptomHigh: 'Spooktracks bij camera-artefacten',
    min: 10, max: 60, step: 1,
    format: (v) => `${v} fr`,
  },
  {
    key: 'minConfirmedFrames',
    label: 'Min. bevestigde frames',
    description: 'Hoeveel frames een nieuw object zichtbaar moet zijn voor het gerapporteerd wordt.',
    symptomLow: 'Eenmalige ghost-detecties worden getoond',
    symptomHigh: 'Trage verschijning van snelle voertuigen',
    min: 2, max: 4, step: 1,
    format: (v) => `${v} fr`,
  },
  {
    key: 'boxEmaAlpha',
    label: 'Box-afmeting smoothing (α)',
    description: 'EMA-gewicht voor breedte/hoogte van de bounding box. Hoger = sneller, lager = stabieler.',
    symptomLow: 'Box reageert traag op grootte-verandering',
    symptomHigh: 'Box trilt of is jittery',
    min: 0.40, max: 0.80, step: 0.01,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'qPos',
    label: 'Kalman positieruis (Q pos)',
    description: 'Procesruis voor positie. Hoger = filter volgt detector sneller, lager = meer voorspelling.',
    symptomLow: 'Track reageert traag op scherpe koerswijziging',
    symptomHigh: 'KF-voorspelling drijft snel weg',
    min: 0.3, max: 3.0, step: 0.1,
    format: (v) => v.toFixed(1),
  },
  {
    key: 'qVel',
    label: 'Kalman snelheidsruis (Q vel)',
    description: 'Procesruis voor snelheid. Hoger = snellere aanpassing bij versnelling/remmen.',
    symptomLow: 'Box loopt achter bij sterk remmende vrachtwagens',
    symptomHigh: 'Snelheidsschatting jittery, drijft weg',
    min: 0.01, max: 0.30, step: 0.01,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'speedPlausibilityKmh',
    label: 'Max. plausibele snelheid (km/h)',
    description: 'Snelheidswaarden boven dit getal worden gefilterd als meetfout (homografie-artefact).',
    symptomLow: 'Echte hoge snelheden worden weggefilterd',
    symptomHigh: 'Onrealistische uitschieters verschijnen in de feed',
    min: 120, max: 200, step: 5,
    format: (v) => `${v} km/h`,
  },
]

const PRESETS: Record<string, Partial<TrackerConfig> & { label: string; description: string }> = {
  balanced: {
    label: 'Balanced',
    description: 'Standaard — geschikt voor de meeste snelwegcamera\'s',
    ...DEFAULT_TRACKER_CONFIG,
  },
  highway: {
    label: 'Snelweg',
    description: 'Vaste hoek, weinig occlusie, hoge snelheid',
    highConfidence: 0.60,
    iouStage1: 0.40,
    iouStage2: 0.10,
    maxPredictedGap: 2,
    qVel: 0.03,
    speedPlausibilityKmh: 170,
  },
  congested: {
    label: 'Ring / file',
    description: 'Veel overlap, occlusie, wisselende snelheden',
    highConfidence: 0.50,
    iouStage1: 0.28,
    iouStage2: 0.10,
    maxPredictedGap: 4,
    maxMissedFrames: 40,
    qVel: 0.08,
    speedPlausibilityKmh: 150,
  },
  lowvis: {
    label: 'Slecht zicht',
    description: 'Regen / nacht / lage scherpte',
    highConfidence: 0.45,
    iouStage1: 0.25,
    iouStage2: 0.08,
    minConfirmedFrames: 3,
    boxEmaAlpha: 0.55,
    speedPlausibilityKmh: 160,
  },
}

interface TrackingTuningProps {
  config: TrackerConfig
  onChange: (cfg: TrackerConfig) => void
  onSave: () => void
  saving: boolean
}

// Sliders grouped by what they control, so the 10 knobs read as a few coherent
// sections instead of a flat wall. `note` is conditional on motion-gated mode.
const SLIDER_GROUPS: { label: string; keys: (keyof TrackerConfig)[]; note?: (motionGated: boolean) => string | null }[] = [
  { label: 'Detectie', keys: ['highConfidence'] },
  {
    label: 'ID-matching (IoU)',
    keys: ['iouStage1', 'iouStage2'],
    note: (mg) => (mg ? 'Met motion-gated aan is dit enkel de overlap-helft van de gate — minder kritisch.' : null),
  },
  { label: 'Track-leven', keys: ['maxPredictedGap', 'maxMissedFrames', 'minConfirmedFrames'] },
  {
    label: 'Bewegingsmodel (Kalman)',
    keys: ['qPos', 'qVel', 'boxEmaAlpha'],
    note: (mg) => (mg ? 'Drijft de motion-gated gate én de coasting — hier zit de meeste winst.' : 'Drijft de coasting-voorspelling.'),
  },
  { label: 'Snelheidsfilter', keys: ['speedPlausibilityKmh'] },
]

function SliderRow({ def, value, onChange }: { def: SliderDef; value: number; onChange: (v: number) => void }) {
  const fmt = def.format ?? String
  const pct = ((value - def.min) / (def.max - def.min)) * 100
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <label className="text-xs font-bold uppercase tracking-widest">{def.label}</label>
        <span className="text-xs font-mono tabular-nums text-black">{fmt(value)}</span>
      </div>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-black h-1.5 cursor-pointer"
        style={{ background: `linear-gradient(to right,#000 ${pct}%,#d6d3d1 ${pct}%)` }}
      />
      <div className="flex justify-between text-[10px] text-stone-400 mt-0.5 mb-1.5">
        <span>{def.min}</span>
        <span>{def.max}</span>
      </div>
      <p className="text-[11px] text-stone-500">{def.description}</p>
      <div className="mt-1 flex flex-col gap-0.5 text-[10px] text-stone-400">
        <span className="uppercase tracking-wider text-stone-300">Zie je dit? → doe dit:</span>
        <span>{def.symptomLow} <b className="text-stone-700">→ zet hoger ↑</b></span>
        <span>{def.symptomHigh} <b className="text-stone-700">→ zet lager ↓</b></span>
      </div>
    </div>
  )
}

function TrackingTuning({ config, onChange, onSave, saving }: TrackingTuningProps) {
  const set = (key: keyof TrackerConfig, value: number) => onChange({ ...config, [key]: value })
  const applyPreset = (preset: Partial<TrackerConfig>) => onChange({ ...DEFAULT_TRACKER_CONFIG, ...preset })
  const isDefault = JSON.stringify(config) === JSON.stringify(DEFAULT_TRACKER_CONFIG)
  const mg = config.motionGated

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <SectionTitle title="Tracking tuning" hint="Pas de tracker-parameters aan voor deze camera. Opslaan → camera herstart direct." />
        <Button variant="ghost" onClick={() => onChange({ ...DEFAULT_TRACKER_CONFIG })} disabled={isDefault}>Reset</Button>
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-2">
        {Object.entries(PRESETS).map(([key, preset]) => (
          <button
            key={key}
            onClick={() => applyPreset(preset)}
            title={preset.description}
            className="text-xs border-2 border-black px-3 py-1.5 hover:bg-black hover:text-white transition-colors"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Mode toggles */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="flex items-center justify-between border-2 border-black bg-stone-50 px-3 py-2">
          <div className="pr-3">
            <p className="text-xs font-bold uppercase tracking-widest">Motion-gated matcher</p>
            <p className="text-[11px] text-stone-500 mt-0.5">Kalman covariance-gate i.p.v. enkel IoU. Minder ID-verlies bij voorspelbare beweging.</p>
          </div>
          <Toggle on={mg} onChange={(v) => onChange({ ...config, motionGated: v })} />
        </div>
        <div className="flex items-center justify-between border-2 border-black bg-stone-50 px-3 py-2">
          <div className="pr-3">
            <p className="text-xs font-bold uppercase tracking-widest">ID-swap debug logging</p>
            <p className="text-[11px] text-stone-500 mt-0.5">Logt swap-diagnostiek naar de backend-console (SUPPRESS/SPAWN + zone). Enkel tijdens diagnose.</p>
          </div>
          <Toggle on={config.trackDebug} onChange={(v) => onChange({ ...config, trackDebug: v })} />
        </div>
      </div>

      {/* Grouped sliders */}
      {SLIDER_GROUPS.map((group) => {
        const note = group.note?.(mg)
        return (
          <div key={group.label}>
            <div className="flex flex-wrap items-baseline gap-2 border-b border-stone-300 pb-1 mb-3">
              <span className="text-[11px] font-bold uppercase tracking-widest text-stone-600">{group.label}</span>
              {note && <span className="text-[10px] text-stone-400">{note}</span>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
              {group.keys.map((k) => (
                <SliderRow key={k} def={SLIDER_DEFS.find((d) => d.key === k)!} value={config[k] as number} onChange={(v) => set(k, v)} />
              ))}
            </div>
          </div>
        )
      })}

      <Button onClick={onSave} disabled={saving}>{saving ? 'Opslaan…' : 'Tracking opslaan & camera herstarten'}</Button>
    </div>
  )
}

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
  const [snapshotDims, setSnapshotDims] = useState<{ w: number; h: number } | null>(null)
  const [imagePoints, setImagePoints] = useState<Pt[]>([])
  const [mapPoints, setMapPoints] = useState<LatLng[]>([])
  const [maxSpeedKmh, setMaxSpeedKmh] = useState('')
  const [trapSpeedEnabled, setTrapSpeedEnabled] = useState(false)
  const [trackingConfig, setTrackingConfig] = useState<TrackerConfig>({ ...DEFAULT_TRACKER_CONFIG })
  const [savingTracking, setSavingTracking] = useState(false)
  const [roiPolygon, setRoiPolygon] = useState<number[]>([])
  const [savingRoi, setSavingRoi] = useState(false)
  const [directionZones, setDirectionZones] = useState<Zone[]>([])
  const [activeZone, setActiveZone] = useState(0)
  const [savingZones, setSavingZones] = useState(false)
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
  const pendingFitRef = useRef<LatLng[] | null>(null)
  const [needsGeocode, setNeedsGeocode] = useState(false)
  const [mapLoaded, setMapLoaded] = useState(false)
  // Calibration points without lat/lng — computed approximately from geocode + wx/wy
  const pendingWxWyRef = useRef<Array<{ wx: number; wy: number }> | null>(null)
  const [approximateMapPoints, setApproximateMapPoints] = useState(false)

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: GOOGLE_MAPS_API_KEY ?? '',
    libraries: LIBRARIES,
  })

  // Calibration points are picked in the snapshot's native pixel space — the
  // backend stores these dims so the homography survives stream resolution changes
  useEffect(() => {
    if (!snapshot) return
    const im = new Image()
    im.onload = () => setSnapshotDims({ w: im.naturalWidth, h: im.naturalHeight })
    im.src = `data:image/jpeg;base64,${snapshot}`
  }, [snapshot])

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
      setTrackingConfig({ ...DEFAULT_TRACKER_CONFIG, ...(cam.trackingConfig ?? {}) })
      setRoiPolygon(cam.roiPolygon ?? [])
      setDirectionZones((cam.directionZones as Zone[] | null) ?? [])

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

      // Restore calibration points. When lat/lng is present, also restore map markers.
      // Without lat/lng (old calibrations): restore image points only so they're visible;
      // the user can click matching map points to complete re-calibration.
      if (Array.isArray(cam.calibrationPoints) && cam.calibrationPoints.length >= 4) {
        setImagePoints(cam.calibrationPoints.map((p) => ({ x: p.px, y: p.py })))
        const withLatLng = cam.calibrationPoints.filter((p) => p.lat !== undefined && p.lng !== undefined)
        if (withLatLng.length === cam.calibrationPoints.length) {
          const latLngs = withLatLng.map((p) => ({ lat: p.lat!, lng: p.lng! }))
          setMapPoints(latLngs)
          setMapCenter(latLngs[0])
          pendingFitRef.current = latLngs
          if (mapRef.current) {
            fitMapToPoints(mapRef.current, latLngs)
            pendingFitRef.current = null
          }
        } else {
          // No lat/lng — store wx/wy so geocode useEffect can compute approximate positions
          pendingWxWyRef.current = cam.calibrationPoints.map((p) => ({ wx: p.wx, wy: p.wy }))
          setNeedsGeocode(true)
        }
      } else {
        setNeedsGeocode(true)
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

  function fitMapToPoints(map: google.maps.Map, points: LatLng[]) {
    if (points.length === 0) return
    const bounds = new window.google.maps.LatLngBounds()
    points.forEach((p) => bounds.extend(p))
    map.fitBounds(bounds, 80)
    // 3D tilt after bounds settle
    setTimeout(() => { map.setTilt(45) }, 300)
  }

  // Geocode the camera name/location and center + tilt the map.
  // If wx/wy calibration points are pending, compute approximate lat/lng from them.
  useEffect(() => {
    if (!needsGeocode || !isLoaded || !camera || !mapLoaded || !mapRef.current) return
    const query = camera.location || camera.name
    const geocoder = new window.google.maps.Geocoder()
    geocoder.geocode({ address: query }, (results, status) => {
      if (status === 'OK' && results?.[0] && mapRef.current) {
        const loc = results[0].geometry.location
        mapRef.current.setCenter(loc)
        mapRef.current.setZoom(18)
        mapRef.current.setTilt(45)

        // Reconstruct approximate map markers from wx/wy using geocoded location as origin.
        // wx/wy are meters east/north from the first calibration point; relative positions
        // are exact, but the absolute anchor is approximated from the geocoded address.
        const wxwy = pendingWxWyRef.current
        if (wxwy && wxwy.length > 0) {
          const R = 6371000
          const originLat = loc.lat()
          const originLng = loc.lng()
          const latLngs = wxwy.map(({ wx, wy }) => ({
            lat: originLat + (-wy / R) * (180 / Math.PI),
            lng: originLng + (wx / (R * Math.cos(originLat * Math.PI / 180))) * (180 / Math.PI),
          }))
          setMapPoints(latLngs)
          setApproximateMapPoints(true)
          pendingWxWyRef.current = null
          fitMapToPoints(mapRef.current, latLngs)
        }
      }
    })
    setNeedsGeocode(false)
  }, [needsGeocode, isLoaded, camera, mapLoaded])

  const lineAFlat = (): number[] => [lineA[0].x, lineA[0].y, lineA[1].x, lineA[1].y]
  const lineBFlat = (): number[] => [lineB[0].x, lineB[0].y, lineB[1].x, lineB[1].y]

  // Fallback Y fraction (midpoint Y of the line)
  const lineAFrac = () => (lineA[0].y + lineA[1].y) / 2
  const lineBFrac = () => (lineB[0].y + lineB[1].y) / 2

  async function handleSaveTracking() {
    if (!id) return
    setSavingTracking(true)
    try {
      await saveTrackingConfig(id, trackingConfig)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save tracking config failed')
    } finally {
      setSavingTracking(false)
    }
  }

  async function handleSaveRoi() {
    if (!id) return
    setSavingRoi(true)
    try {
      await saveRoi(id, roiPolygon)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save ROI failed')
    } finally {
      setSavingRoi(false)
    }
  }

  async function handleSaveZones() {
    if (!id) return
    setSavingZones(true)
    try {
      // keep only valid zones (≥3 pts + an arrow)
      const valid = directionZones.filter((z) => z.polygon.length >= 6 && z.arrow.length === 4)
      await saveDirectionZones(id, valid)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save direction zones failed')
    } finally {
      setSavingZones(false)
    }
  }

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
            lat: mp.lat,
            lng: mp.lng,
          }
        })
      }
      const result = await saveCalibration(
        id, pairs,
        maxSpeedKmh ? parseInt(maxSpeedKmh, 10) : null,
        lineAFrac(), lineBFrac(),
        lineAFlat(), lineBFlat(),
        trapSpeedEnabled,
        snapshotDims?.w, snapshotDims?.h,
      )
      if (result.calibrationError && result.calibrationError.rmsM > 0.5) {
        const { rmsM, maxM, perPointM } = result.calibrationError
        const worst = perPointM.indexOf(Math.max(...perPointM)) + 1
        window.alert(
          `Calibration saved, but the fit is poor: RMS error ${rmsM.toFixed(2)} m, ` +
          `worst point #${worst} is off by ${maxM.toFixed(2)} m. ` +
          `Speeds will be inaccurate — re-pick the worst points.`,
        )
      }
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
      {hasExistingHomography && mapPoints.length === 0 && (
        <div className="border-2 border-black p-3 mb-4 text-xs">
          Calibration saved. Speed measurement active. To restore map markers: search the camera location, re-pick 4+ point pairs, and save once.
        </div>
      )}
      {approximateMapPoints && (
        <div className="border-2 border-amber-500 bg-amber-50 p-3 mb-4 text-xs">
          Kaarposities zijn berekend uit de opgeslagen afstanden (wx/wy) via geocoding van de cameranaam — ze kunnen een paar meter naast de echte positie liggen. Controleer de markers op de kaart, verplaats ze indien nodig, en sla opnieuw op.
        </div>
      )}
      {hasExistingHomography && mapPoints.length > 0 && !approximateMapPoints && (
        <div className="border-2 border-black p-3 mb-4 text-xs">
          Calibration saved. Update lines and speed limit, or re-pick all points to recalibrate.
        </div>
      )}

      <Tabs
        defaultValue="calib"
        tabs={[
          { value: 'calib', label: 'Calibration', hint: 'Point pairs ↔ map → homography' },
          { value: 'count', label: 'Counting & Speed', hint: 'Counting lines, speed limit, method' },
          { value: 'tracking', label: 'Tracking', hint: 'Tracker tuning + matcher' },
          { value: 'zones', label: 'Zones', hint: 'Road ROI + direction zones' },
        ]}
      >
      <TabPanel value="calib">
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
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
                mapContainerStyle={{ height: '600px' }}
                center={mapCenter}
                zoom={mapZoom}
                mapTypeId="satellite"
                options={{ tilt: 45, mapTypeId: 'satellite' }}
                onClick={handleMapClick}
                onLoad={(map) => {
                  mapRef.current = map
                  setMapLoaded(true)
                  if (pendingFitRef.current) {
                    fitMapToPoints(map, pendingFitRef.current)
                    pendingFitRef.current = null
                  }
                }}
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

      {/* Save persists points + lines + speed together (one saveCalibration call). */}
      <div className="pt-3 border-t border-stone-200 flex items-center gap-3">
        <Button onClick={handleSave} disabled={!canSave || saving}>
          {saving ? 'Saving…' : canSave ? (pairsCount >= 4 ? `Save calibration (${pairsCount} pairs)` : 'Save lines & speed limit') : `Need ${Math.max(0, 4 - pairsCount)} more pairs`}
        </Button>
        <span className="text-xs text-stone-400">punten · lijnen · snelheidslimiet</span>
      </div>
      </TabPanel>

      <TabPanel value="count">
      <Panel>
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
        <div className="mt-4 pt-3 border-t border-stone-200 flex items-center gap-3">
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving ? 'Saving…' : canSave ? (pairsCount >= 4 ? `Save calibration (${pairsCount} pairs)` : 'Save lines & speed limit') : `Need ${Math.max(0, 4 - pairsCount)} more pairs`}
          </Button>
          <span className="text-xs text-stone-400">punten · lijnen · snelheidslimiet</span>
        </div>
      </Panel>
      </TabPanel>

      <TabPanel value="tracking">
        <TrackingTuning
          config={trackingConfig}
          onChange={setTrackingConfig}
          onSave={handleSaveTracking}
          saving={savingTracking}
        />
      </TabPanel>

      <TabPanel value="zones">
      <Panel className="mb-4">
        <p className="text-xs font-bold uppercase tracking-widest">Road ROI mask</p>
        <p className="text-xs text-stone-500 mt-0.5 mb-3">
          Click to paint the drivable road. Detections whose ground point falls outside are
          dropped before tracking — cuts off-road clutter (billboards, opposite carriageway,
          parked) and phantom tracks. Empty = no mask. Save → camera restarts.
        </p>
        {snapshot ? (
          <ROIEditor frameBase64={snapshot} polygon={roiPolygon} onChange={setRoiPolygon} width={640} />
        ) : (
          <div className="border border-stone-200 h-32 flex items-center justify-center text-stone-400 text-xs uppercase tracking-widest">
            Waiting for snapshot…
          </div>
        )}
        <div className="mt-3 flex gap-3 items-center">
          <button
            onClick={handleSaveRoi}
            disabled={savingRoi}
            className="border-2 border-black px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-black text-white hover:bg-stone-800 disabled:opacity-40"
          >
            {savingRoi ? 'Saving…' : 'Save ROI'}
          </button>
          <button
            onClick={() => setRoiPolygon([])}
            disabled={roiPolygon.length === 0}
            className="border border-stone-300 px-3 py-1.5 text-xs uppercase tracking-widest hover:border-black disabled:opacity-30"
          >
            Clear
          </button>
          <span className="text-xs text-stone-400">{roiPolygon.length / 2} points</span>
        </div>
      </Panel>

      <Panel>
        <p className="text-xs font-bold uppercase tracking-widest">Richting-zones (per rijrichting)</p>
        <p className="text-xs text-stone-500 mt-0.5 mb-3">
          Teken een zone per rijrichting en sleep de pijl in de rijrichting. De tracker gebruikt
          die vaste richting + houdt id's binnen dezelfde zone → minder id-wissels (vooral bij
          wegrijdende auto's). Vervangt de ROI als er zones zijn. Opslaan → camera herstart.
        </p>
        <div className="flex flex-wrap gap-2 mb-3 items-center">
          {directionZones.map((_, i) => (
            <button key={i} onClick={() => setActiveZone(i)}
              className={`text-xs border-2 px-2 py-1 ${activeZone === i ? 'border-black bg-black text-white' : 'border-stone-300 hover:border-black'}`}>
              Zone {i + 1}{activeZone === i ? ' ✎' : ''}
            </button>
          ))}
          <button
            onClick={() => { setDirectionZones([...directionZones, { polygon: [], arrow: [] }]); setActiveZone(directionZones.length) }}
            className="text-xs border-2 border-black px-2 py-1 hover:bg-black hover:text-white"
          >
            + Nieuwe zone
          </button>
          {directionZones.length > 0 && (
            <button
              onClick={() => { setDirectionZones(directionZones.filter((_, i) => i !== activeZone)); setActiveZone(Math.max(0, activeZone - 1)) }}
              className="text-xs border border-stone-300 px-2 py-1 hover:border-black"
            >
              Verwijder zone {activeZone + 1}
            </button>
          )}
        </div>
        {snapshot ? (
          <DirectionZonesEditor frameBase64={snapshot} zones={directionZones} activeIdx={activeZone} onChange={setDirectionZones} width={640} />
        ) : (
          <div className="border border-stone-200 h-32 flex items-center justify-center text-stone-400 text-xs uppercase tracking-widest">
            Waiting for snapshot…
          </div>
        )}
        <div className="mt-3 flex gap-3 items-center">
          <button
            onClick={handleSaveZones}
            disabled={savingZones}
            className="border-2 border-black px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-black text-white hover:bg-stone-800 disabled:opacity-40"
          >
            {savingZones ? 'Saving…' : 'Save zones'}
          </button>
          <button
            onClick={() => { setDirectionZones([]); setActiveZone(0) }}
            disabled={directionZones.length === 0}
            className="border border-stone-300 px-3 py-1.5 text-xs uppercase tracking-widest hover:border-black disabled:opacity-30"
          >
            Clear all
          </button>
          <span className="text-xs text-stone-400">{directionZones.length} zones</span>
        </div>
      </Panel>
      </TabPanel>
      </Tabs>
    </div>
  )
}
