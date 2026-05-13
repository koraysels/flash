import { useCameras } from '../hooks/useCameras'

export default function Dashboard() {
  const { data: cameras, isLoading, error } = useCameras()

  if (isLoading) return <div className="text-gray-500">Loading cameras...</div>
  if (error) return <div className="text-red-400">Failed to load cameras. Please refresh.</div>

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Live Traffic</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {cameras?.map((cam) => (
          <div key={cam.id} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <div className="flex justify-between items-start mb-2">
              <div>
                <p className="font-semibold">{cam.name}</p>
                <p className="text-sm text-gray-400">{cam.location}</p>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full ${cam.active ? 'bg-green-900 text-green-400' : 'bg-red-900 text-red-400'}`}>
                {cam.active ? 'Live' : 'Offline'}
              </span>
            </div>
            <div className="bg-gray-800 rounded-lg aspect-video flex items-center justify-center text-gray-600 text-sm">
              Live feed — Plan 2
            </div>
          </div>
        ))}
        {cameras?.length === 0 && (
          <p className="text-gray-500 col-span-full">No cameras yet. Add one in <a href="/cameras" className="text-blue-400 underline">Cameras</a>.</p>
        )}
      </div>
    </div>
  )
}
