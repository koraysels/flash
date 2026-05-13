import { useEffect, useRef } from 'react'

type Props = {
  lastFrame: string | null
  fps?: number
  className?: string
}

export function LiveFeed({ lastFrame, fps = 0, className = '' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

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

    return () => {
      img.onload = null
    }
  }, [lastFrame])

  return (
    <div className={`relative ${className}`}>
      <canvas ref={canvasRef} className="w-full h-full object-contain rounded-lg bg-gray-900" />
      {!lastFrame && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">
          Connecting...
        </div>
      )}
      {lastFrame && fps > 0 && (
        <span className="absolute bottom-2 right-2 text-xs text-gray-400 bg-black/50 px-1.5 py-0.5 rounded">
          {fps} fps
        </span>
      )}
    </div>
  )
}
