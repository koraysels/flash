import { useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { MJPEGStream } from '../components/MJPEGStream'
import { CounterDisplay } from '../components/CounterDisplay'
import { SpeedDisplay } from '../components/SpeedDisplay'
import { getCameras, type Camera } from '../lib/api'
import { useCameraFeed } from '../hooks/useCameraFeed'

function PiDisplayInner({ camera }: { camera: Camera }) {
  const { counts, avgSpeedKmh, aiFps, videoFps, active } = useCameraFeed(camera.id)

  return (
    <div className="h-screen bg-black flex flex-col p-4">
      <div className="flex justify-between items-center mb-3">
        <div>
          <h1 className="text-white text-2xl font-bold">{camera.name}</h1>
          <p className="text-gray-400 text-sm">{camera.location}</p>
        </div>
        <div className="flex items-center gap-3">
          {active && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="tabular-nums">{videoFps} fps video</span>
              <span className="text-gray-600">·</span>
              <span className="tabular-nums text-green-400">{aiFps} fps AI</span>
            </div>
          )}
          <SpeedDisplay speedKmh={avgSpeedKmh} maxSpeedKmh={camera.maxSpeedKmh} />
        </div>
      </div>
      <div className="flex-1">
        <MJPEGStream cameraId={camera.id} className="w-full h-full rounded-xl" />
      </div>
      <div className="mt-3">
        <CounterDisplay counts={counts} maxSpeedKmh={camera.maxSpeedKmh} />
      </div>
    </div>
  )
}

export default function PiDisplay() {
  const { cameraId } = useParams<{ cameraId: string }>()
  const [camera, setCamera] = useState<Camera | null>(null)

  useEffect(() => {
    if (!cameraId) return
    let cancelled = false
    getCameras().then((cams) => {
      if (cancelled) return
      const cam = cams.find((c) => c.id === cameraId)
      if (cam) setCamera(cam)
    })
    return () => { cancelled = true }
  }, [cameraId])

  if (!camera) {
    return (
      <div className="h-screen bg-black flex items-center justify-center text-gray-500">
        Loading...
      </div>
    )
  }

  return <PiDisplayInner camera={camera} />
}
