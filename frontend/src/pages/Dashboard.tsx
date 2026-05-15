import { useCameras } from '../hooks/useCameras'
import { useCameraFeed } from '../hooks/useCameraFeed'
import { MJPEGStream } from '../components/MJPEGStream'
import { Camera } from '../lib/api'

function CameraCard({ cam }: { cam: Camera }) {
  const { fps, counts, avgSpeedKmh, active } = useCameraFeed(cam.id)
  const totalVehicles = counts.AB + counts.BA

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
      <div className="flex justify-between items-center px-4 py-3">
        <div>
          <p className="font-semibold">{cam.name}</p>
          <p className="text-xs text-gray-400">{cam.location}</p>
        </div>
        {active ? (
          <span className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-green-950 border border-green-800 text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            AI · {fps} fps
          </span>
        ) : (
          <span className="text-xs px-2 py-1 rounded-full bg-gray-800 text-gray-500">Starting...</span>
        )}
      </div>

      <MJPEGStream cameraId={cam.id} className="aspect-[4/3]" />

      <div className="px-4 py-3">
        <div className="grid grid-cols-3 gap-2 text-center mb-2">
          <div className="bg-gray-800 rounded-lg py-2">
            <p className="text-xs text-gray-500 mb-0.5">A → B</p>
            <p className="text-xl font-bold tabular-nums text-blue-300">{counts.AB}</p>
          </div>
          <div className="bg-gray-800 rounded-lg py-2">
            <p className="text-xs text-gray-500 mb-0.5">B → A</p>
            <p className="text-xl font-bold tabular-nums text-blue-300">{counts.BA}</p>
          </div>
          <div className="bg-gray-800 rounded-lg py-2">
            <p className="text-xs text-gray-500 mb-0.5">Total</p>
            <p className="text-xl font-bold tabular-nums">{totalVehicles}</p>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>
            {cam.homographyMatrix?.length === 9
              ? avgSpeedKmh !== null ? `Avg ${Math.round(avgSpeedKmh)} km/h` : 'Speed calibrated'
              : <a href={`/cameras/${cam.id}/calibrate`} className="text-yellow-500 hover:text-yellow-400">Calibrate for speed →</a>}
          </span>
          {cam.maxSpeedKmh != null && (
            <span className="text-red-400">⚡ {counts.speeders} speeders &gt;{cam.maxSpeedKmh} km/h</span>
          )}
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
      No cameras configured. <a href="/cameras" className="text-blue-400 underline">Add one →</a>
    </div>
  )

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {cameras.map((cam) => (
          <CameraCard key={cam.id} cam={cam} />
        ))}
      </div>
    </div>
  )
}
