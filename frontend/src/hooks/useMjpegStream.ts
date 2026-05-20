import { useEffect, useRef, useState } from 'react'

export interface MjpegFrame {
  src: string
  seq: number
}

const BOUNDARY = new TextEncoder().encode('--frame\r\n')
const HEADER_END = new TextEncoder().encode('\r\n\r\n')

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function sub(buf: Uint8Array, start: number, end?: number): Uint8Array<ArrayBuffer> {
  const len = (end ?? buf.length) - start
  const out = new Uint8Array(len)
  out.set(buf.subarray(start, end ?? buf.length))
  return out
}

function tryExtractFrame(buf: Uint8Array): { jpeg: Uint8Array<ArrayBuffer>; seq: number; rest: Uint8Array<ArrayBuffer> } | null {
  const bi = indexOf(buf, BOUNDARY)
  if (bi === -1) return null
  const hs = bi + BOUNDARY.length
  const he = indexOf(buf, HEADER_END, hs)
  if (he === -1) return null

  const headers = new TextDecoder().decode(sub(buf, hs, he))
  const seqMatch = headers.match(/X-Frame-Seq:\s*(\d+)/i)
  const lenMatch = headers.match(/Content-Length:\s*(\d+)/i)
  if (!lenMatch) return null

  const seq = seqMatch ? parseInt(seqMatch[1]) : 0
  const bodyLen = parseInt(lenMatch[1])
  const bodyStart = he + HEADER_END.length
  const bodyEnd = bodyStart + bodyLen

  if (buf.length < bodyEnd) return null

  return { jpeg: sub(buf, bodyStart, bodyEnd), seq, rest: sub(buf, bodyEnd) }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

export function useMjpegStream(cameraId: string): MjpegFrame {
  const [frame, setFrame] = useState<MjpegFrame>({ src: '', seq: 0 })
  const prevBlobRef = useRef('')

  useEffect(() => {
    let active = true

    async function connect() {
      while (active) {
        try {
          const res = await fetch(`/api/cameras/${cameraId}/mjpeg`)
          if (!res.ok || !res.body) { await sleep(2_000); continue }

          const reader = res.body.getReader()
          let buf = new Uint8Array(0)

          while (active) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) buf = concat(buf, value)

            let parsed = tryExtractFrame(buf)
            while (parsed) {
              buf = parsed.rest
              const blob = new Blob([parsed.jpeg], { type: 'image/jpeg' })
              const src = URL.createObjectURL(blob)
              if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current)
              prevBlobRef.current = src
              if (active) setFrame({ src, seq: parsed.seq })
              parsed = tryExtractFrame(buf)
            }
          }

          reader.cancel().catch(() => {})
        } catch {
          if (!active) break
          await sleep(2_000)
        }
      }
    }

    connect()
    return () => {
      active = false
      if (prevBlobRef.current) URL.revokeObjectURL(prevBlobRef.current)
    }
  }, [cameraId])

  return frame
}
