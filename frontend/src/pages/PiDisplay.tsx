import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { resolveDisplay } from '../lib/api'
import { AnnotatedFullscreen } from '../components/AnnotatedFullscreen'
import { socket } from '../lib/socket'

/** Assignable Pi kiosk: /display/:slug where slug is a fixed slot (FLASH-PI-01/02/03).
 *  Resolves to whichever camera is assigned and re-polls so reassigning in the
 *  dashboard switches the Pi without touching it. */
export default function PiDisplay() {
  const { slug } = useParams<{ slug: string }>()
  const [cameraId, setCameraId] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    const resolve = () =>
      resolveDisplay(slug)
        .then((id) => { if (!cancelled) { setCameraId((prev) => (prev === id ? prev : id)); setError(false) } })
        .catch(() => { if (!cancelled) setError(true) })
    resolve()
    const t = setInterval(resolve, 15_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [slug])

  // Heartbeat so the dashboard knows this kiosk page is alive + rendering, and
  // listen for a remote reload command.
  useEffect(() => {
    if (!slug) return
    const hello = () => socket.emit('kiosk-hello', slug)
    hello()
    const t = setInterval(hello, 10_000)
    const onReload = () => window.location.reload()
    socket.on('connect', hello)
    socket.on('kiosk-reload', onReload)
    return () => {
      clearInterval(t)
      socket.off('connect', hello)
      socket.off('kiosk-reload', onReload)
    }
  }, [slug])

  return (
    <div className="fixed inset-0 bg-black">
      {error && !cameraId && (
        <div className="absolute inset-0 flex items-center justify-center text-stone-500 text-sm uppercase tracking-widest">
          No camera assigned to "{slug}"
        </div>
      )}
      <AnnotatedFullscreen cameraId={cameraId} />
    </div>
  )
}
