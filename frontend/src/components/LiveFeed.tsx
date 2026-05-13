import { useEffect, useRef } from 'react'
import { useCameraFeed } from '../hooks/useCameraFeed'

type Props = {
  cameraId: string
  className?: string
}

export function LiveFeed({ cameraId, className = '' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { lastFrame, fps, counts } = useCameraFeed(cameraId)

  useEffect(() => {
    if (!lastFrame || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const img = new Image()
    img.onload = () => {
      canvas.width = img.width
      canvas.height = img.height
      ctx.drawImage(img, 0, 0)
    }
    img.src = `data:image/jpeg;base64,${lastFrame}`
  }, [lastFrame])

  return (
    <div className={`relative ${className}`}>
      <canvas ref={canvasRef} className="w-full h-full object-contain rounded-lg bg-gray-900" />
      {!lastFrame && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">
          Connecting...
        </div>
      )}
      {lastFrame && (
        <span className="absolute bottom-2 right-2 text-xs text-gray-400 bg-black/50 px-1.5 py-0.5 rounded">
          {fps} fps
        </span>
      )}
      {lastFrame && (counts.AB > 0 || counts.BA > 0) && (
        <div className="absolute top-2 left-2 text-xs text-white bg-black/50 px-1.5 py-0.5 rounded space-x-2">
          <span>AB: {counts.AB}</span>
          <span>BA: {counts.BA}</span>
          {counts.speeders > 0 && <span className="text-red-400">⚡ {counts.speeders}</span>}
        </div>
      )}
    </div>
  )
}
