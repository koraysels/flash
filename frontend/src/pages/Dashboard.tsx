import { useCameras } from '../hooks/useCameras'
import { useCameraFeed } from '../hooks/useCameraFeed'
import { LiveFeed } from '../components/LiveFeed'
import { CounterDisplay } from '../components/CounterDisplay'
import { Camera } from '../lib/api'

function CameraCard({ cam }: { cam: Camera }) {
  const { lastFrame, fps, counts } = useCameraFeed(cam.id)
  return (
    <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
      <div className="flex justify-between items-start mb-2">
        <div>
          <p className="font-semibold">{cam.name}</p>
          <p className="text-sm text-gray-400">{cam.location}</p>
        </div>
        <span className={`text-xs px-2 py-1 rounded-full ${lastFrame ? 'bg-green-900 text-green-400' : 'bg-yellow-900 text-yellow-400'}`}>
          {lastFrame ? 'Live' : 'Connecting'}
        </span>
      </div>
      <LiveFeed lastFrame={lastFrame} fps={fps} className="aspect-video" />
      <CounterDisplay counts={counts} maxSpeedKmh={cam.maxSpeedKmh} />
    </div>
  )
}

export default function Dashboard() {
  const { data: cameras, isLoading, error } = useCameras()

  if (isLoading) return <div className="p-8 text-gray-400">Loading...</div>
  if (error) return <div className="p-8 text-red-400">Failed to load cameras</div>
  if (!cameras?.length) return <div className="p-8 text-gray-500">No cameras configured. Add one in the Cameras page.</div>

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
