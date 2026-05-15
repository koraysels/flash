import { useState } from 'react'
import { useCameras } from '../hooks/useCameras'
import { useCameraFeed } from '../hooks/useCameraFeed'
import { HlsPlayer } from '../components/HlsPlayer'
import { LiveFeed } from '../components/LiveFeed'
import { Camera } from '../lib/api'

function VehicleTag({ cls, speed }: { cls: string; speed: number | null }) {
  const colors: Record<string, string> = {
    car: 'bg-blue-900 text-blue-300 border-blue-700',
    truck: 'bg-amber-900 text-amber-300 border-amber-700',
    bus: 'bg-emerald-900 text-emerald-300 border-emerald-700',
    motorcycle: 'bg-purple-900 text-purple-300 border-purple-700',
  }
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${colors[cls] ?? 'bg-gray-800 text-gray-300 border-gray-700'}`}>
      {cls}
      {speed !== null && <span className="opacity-70">{Math.round(speed)} km/h</span>}
    </span>
  )
}

function CameraCard({ cam }: { cam: Camera }) {
  const { lastFrame, fps, counts, avgSpeedKmh, vehicles } = useCameraFeed(cam.id)
  const [showAnalysis, setShowAnalysis] = useState(false)

  const isAnalysisActive = lastFrame !== null
  const totalVehicles = counts.AB + counts.BA

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      {/* Header */}
      <div className="flex justify-between items-start px-4 pt-4 pb-2">
        <div>
          <p className="font-semibold">{cam.name}</p>
          <p className="text-xs text-gray-400 mt-0.5">{cam.location}</p>
        </div>
        <div className="flex items-center gap-2">
          {isAnalysisActive ? (
            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-950 border border-green-800 text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              AI active · {fps} fps
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-500">
              Waiting for frames
            </span>
          )}
        </div>
      </div>

      {/* Video area */}
      <div className="relative">
        {showAnalysis ? (
          <LiveFeed lastFrame={lastFrame} fps={fps} className="aspect-video mx-4 mb-2" />
        ) : (
          <HlsPlayer cameraId={cam.id} className="aspect-video mx-4 mb-2" />
        )}
        <button
          onClick={() => setShowAnalysis(!showAnalysis)}
          className={`absolute bottom-4 right-6 text-xs px-2 py-1 rounded border backdrop-blur-sm
            ${showAnalysis
              ? 'bg-purple-900/80 border-purple-700 text-purple-300'
              : 'bg-black/60 border-gray-600 text-gray-300 hover:text-white'}`}
        >
          {showAnalysis ? '🤖 AI view' : '📺 Live stream'}
        </button>
      </div>

      {/* Counts */}
      <div className="px-4 pb-3 space-y-3">
        {/* Direction counters explanation */}
        <div className="bg-gray-800/60 rounded-lg p-3">
          <p className="text-xs text-gray-500 mb-2 flex items-center gap-1">
            <span>Vehicle count — today</span>
            {cam.homographyMatrix?.length === 9
              ? <span className="text-green-500">✓ speed calibrated</span>
              : <span className="text-yellow-600">· calibrate for speed</span>}
          </p>
          <div className="grid grid-cols-3 gap-2">
            <div className="text-center">
              <p className="text-gray-400 text-xs mb-0.5">
                Line A → B
                <span className="block text-gray-600" style={{ fontSize: '10px' }}>top line → bottom line</span>
              </p>
              <p className="text-2xl font-bold tabular-nums text-blue-300">{counts.AB}</p>
            </div>
            <div className="text-center border-x border-gray-700">
              <p className="text-gray-400 text-xs mb-0.5">
                Line B → A
                <span className="block text-gray-600" style={{ fontSize: '10px' }}>bottom line → top line</span>
              </p>
              <p className="text-2xl font-bold tabular-nums text-blue-300">{counts.BA}</p>
            </div>
            <div className="text-center">
              <p className="text-gray-400 text-xs mb-0.5">
                Total
                <span className="block text-gray-600" style={{ fontSize: '10px' }}>both directions</span>
              </p>
              <p className="text-2xl font-bold tabular-nums">{totalVehicles}</p>
            </div>
          </div>

          {cam.maxSpeedKmh != null && (
            <div className="mt-2 pt-2 border-t border-gray-700 flex items-center justify-between">
              <span className="text-xs text-red-400">⚡ Speeders &gt;{cam.maxSpeedKmh} km/h</span>
              <span className="text-lg font-bold text-red-400 tabular-nums">{counts.speeders}</span>
            </div>
          )}

          {avgSpeedKmh !== null && (
            <div className="mt-2 pt-2 border-t border-gray-700 flex items-center justify-between">
              <span className="text-xs text-gray-400">Avg speed (current vehicles)</span>
              <span className="text-sm font-semibold tabular-nums">{Math.round(avgSpeedKmh)} km/h</span>
            </div>
          )}
        </div>

        {/* Currently tracked vehicles */}
        {vehicles.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 mb-1.5">Currently in frame</p>
            <div className="flex flex-wrap gap-1.5">
              {vehicles.map((v) => <VehicleTag key={v.id} cls={v.class} speed={v.speedKmh} />)}
            </div>
          </div>
        )}

        {/* Analysis status */}
        {!isAnalysisActive && (
          <div className="bg-gray-800/40 rounded-lg p-3 text-xs text-gray-500 flex items-start gap-2">
            <span className="text-yellow-500 mt-0.5">⚠</span>
            <div>
              <p className="text-gray-400 font-medium mb-0.5">AI analysis not yet receiving frames</p>
              <p>The backend is processing the stream. Frames start arriving within ~30s. Switch to AI view to see detections with bounding boxes.</p>
            </div>
          </div>
        )}

        {isAnalysisActive && totalVehicles === 0 && (
          <div className="bg-gray-800/40 rounded-lg p-2.5 text-xs text-gray-500 flex items-center gap-2">
            <span className="text-blue-500">ℹ</span>
            AI is running — no vehicles crossed the counting lines yet. Switch to AI view to see bounding boxes live.
          </div>
        )}
      </div>
    </div>
  )
}

function Legend() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">How it works</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-gray-400">
        <div className="flex gap-3">
          <span className="text-2xl leading-none">📺</span>
          <div>
            <p className="font-medium text-gray-300 mb-0.5">Live stream</p>
            <p>Raw HLS video from the camera. Smooth playback, ~10s buffer. No AI overlay.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="text-2xl leading-none">🤖</span>
          <div>
            <p className="font-medium text-gray-300 mb-0.5">AI view</p>
            <p>2 fps annotated frames from the backend. Shows bounding boxes around detected vehicles and the counting lines.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="text-2xl leading-none">📊</span>
          <div>
            <p className="font-medium text-gray-300 mb-0.5">Counting lines A & B</p>
            <p>Two horizontal lines across the frame. A vehicle is counted when it crosses from one line to the other. Calibrate in camera settings for speed.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { data: cameras, isLoading, error } = useCameras()

  if (isLoading) return <div className="p-8 text-gray-400">Loading...</div>
  if (error) return <div className="p-8 text-red-400">Failed to load cameras</div>
  if (!cameras?.length) return (
    <div className="p-8 text-gray-500">
      No cameras configured. Go to <a href="/cameras" className="text-blue-400 underline">Cameras</a> to add one.
    </div>
  )

  return (
    <div className="p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-gray-500">{cameras.length} camera{cameras.length !== 1 ? 's' : ''} active</p>
      </div>
      <Legend />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {cameras.map((cam) => (
          <CameraCard key={cam.id} cam={cam} />
        ))}
      </div>
    </div>
  )
}
