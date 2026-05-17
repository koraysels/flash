import { useState } from 'react'
import { useCameras } from '../hooks/useCameras'
import { useCameraFeed } from '../hooks/useCameraFeed'
import { CameraStream } from '../components/CameraStream'
import { Camera, resetCounts } from '../lib/api'

function CameraCard({ cam }: { cam: Camera }) {
  const [resetting, setResetting] = useState(false)
  const { aiFps, videoFps, counts, avgSpeedKmh, vehicles, frameSize, active } = useCameraFeed(cam.id)
  const totalVehicles = counts.AB + counts.BA

  return (
    <div className="border-2 border-black bg-white">
      <div className="flex justify-between items-center px-3 py-2 border-b-2 border-black">
        <div>
          <p className="font-bold text-sm uppercase tracking-wide">{cam.name}</p>
          <p className="text-xs text-stone-500">{cam.location}</p>
        </div>
        {active ? (
          <div className="flex items-center gap-3 text-xs tabular-nums">
            <span className="text-stone-400">{videoFps}fps</span>
            <span className="border border-black px-1.5 py-0.5 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-black animate-pulse" />
              AI {aiFps}fps
            </span>
          </div>
        ) : (
          <span className="text-xs text-stone-400 border border-stone-300 px-2 py-0.5">STARTING</span>
        )}
      </div>

      <CameraStream
        cameraId={cam.id}
        vehicles={vehicles}
        frameSize={frameSize}
        lineA={cam.countingLineA}
        lineB={cam.countingLineB}
        lineAPoints={cam.countingLineAPoints}
        lineBPoints={cam.countingLineBPoints}
        maxSpeedKmh={cam.maxSpeedKmh}
        className="aspect-[4/3]"
      />

      <div className="grid grid-cols-3 border-t-2 border-black">
        <div className="py-3 text-center border-r-2 border-black">
          <p className="text-xs uppercase tracking-widest text-stone-400 mb-1">A→B</p>
          <p className="text-2xl font-bold tabular-nums">{counts.AB}</p>
        </div>
        <div className="py-3 text-center border-r-2 border-black">
          <p className="text-xs uppercase tracking-widest text-stone-400 mb-1">B→A</p>
          <p className="text-2xl font-bold tabular-nums">{counts.BA}</p>
        </div>
        <div className="py-3 text-center">
          <p className="text-xs uppercase tracking-widest text-stone-400 mb-1">Total</p>
          <p className="text-2xl font-bold tabular-nums">{totalVehicles}</p>
        </div>
      </div>

      <div className="flex items-center justify-between px-3 py-2 border-t-2 border-black text-xs">
        <span>
          {cam.homographyMatrix?.length === 9
            ? avgSpeedKmh !== null
              ? <span className="font-bold">AVG {Math.round(avgSpeedKmh)} KM/H</span>
              : <span className="text-stone-500">SPEED CALIBRATED</span>
            : <a href={`/cameras/${cam.id}/calibrate`} className="underline text-stone-500 hover:text-black">CALIBRATE →</a>}
        </span>
        <div className="flex items-center gap-4">
          {cam.maxSpeedKmh != null && counts.speeders > 0 && (
            <span className="text-red-600 font-bold">{counts.speeders}× &gt;{cam.maxSpeedKmh}</span>
          )}
          <a href={`/display/${cam.id}`} target="_blank" rel="noopener noreferrer" className="text-stone-500 underline hover:text-black">
            DISPLAY →
          </a>
          <button
            onClick={async () => {
              setResetting(true)
              try { await resetCounts(cam.id) } finally { setResetting(false) }
            }}
            disabled={resetting}
            className="border border-black px-2 py-0.5 hover:bg-black hover:text-white disabled:opacity-40 transition-colors"
          >
            RESET
          </button>
        </div>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { data: cameras, isLoading, error } = useCameras()

  if (isLoading) return <div className="text-stone-400 text-xs uppercase tracking-widest p-8">Loading...</div>
  if (error) return <div className="text-red-600 text-xs uppercase tracking-widest p-8">Failed to load cameras</div>
  if (!cameras?.length) return (
    <div className="p-8 text-xs text-stone-500 uppercase tracking-widest">
      No cameras configured. <a href="/cameras" className="underline text-black">Add one →</a>
    </div>
  )

  return (
    <div>
      <p className="text-xs font-bold tracking-widest uppercase text-stone-400 mb-6">Dashboard</p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {cameras.map((cam) => (
          <CameraCard key={cam.id} cam={cam} />
        ))}
      </div>
    </div>
  )
}
