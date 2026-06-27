import { useState, useEffect, useRef } from 'react'
import { getCameraSnapshot } from '../lib/api'
import { Spinner } from './ui/Spinner'

// Shows the last-known camera frame instantly (served from the server-side
// snapshot cache) and quietly refreshes it on an interval. Keeps the previous
// image on error, so a restarting camera still shows its last preview.
export function CameraThumbnail({
  cameraId,
  className = '',
  intervalMs = 8000,
}: {
  cameraId: string
  className?: string
  intervalMs?: number
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const b64 = await getCameraSnapshot(cameraId)
        if (alive.current && b64) setSrc(`data:image/jpeg;base64,${b64}`)
      } catch {
        /* keep the previous frame */
      } finally {
        if (alive.current) {
          setTried(true)
          timer = setTimeout(load, intervalMs)
        }
      }
    }
    load()
    return () => { alive.current = false; clearTimeout(timer) }
  }, [cameraId, intervalMs])

  return (
    <div className={`relative bg-stone-100 overflow-hidden ${className}`}>
      {src ? (
        <img src={src} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-stone-300">
          {tried ? <span className="text-[10px] uppercase tracking-widest">Geen preview</span> : <Spinner />}
        </div>
      )}
    </div>
  )
}
