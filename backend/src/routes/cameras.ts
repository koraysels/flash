import { FastifyInstance, FastifyReply } from 'fastify'
import { PassThrough } from 'stream'
import { db } from '../db'
import { Prisma } from '@prisma/client'
import { extractStreamUrl } from '../stream/extractor'
import { getStreamer, getManager } from '../camera-worker'

// Cache resolved HLS URLs so we don't re-extract on every proxy request
const hlsUrlCache = new Map<string, string>()

// ~4 frames at expected JPEG size (~40KB); keeps per-client buffering below ~200ms of latency
const MJPEG_DROP_WATERMARK = 200 * 1024

function handlePrismaError(err: unknown, reply: FastifyReply) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
    reply.code(404).send({ error: 'Not found' })
    return
  }
  throw err
}

export async function cameraRoutes(app: FastifyInstance) {
  app.get('/api/cameras', async () => {
    return db.camera.findMany({ orderBy: { createdAt: 'asc' } })
  })

  app.post<{
    Body: { name: string; location: string; streamUrl: string; maxSpeedKmh?: number }
  }>('/api/cameras', async (req, reply) => {
    const { name, location, streamUrl, maxSpeedKmh } = req.body
    if (!name || !location || !streamUrl) {
      reply.code(400).send({ error: 'name, location, and streamUrl are required' })
      return
    }
    const camera = await db.camera.create({ data: { name, location, streamUrl, maxSpeedKmh } })
    reply.code(201)
    return camera
  })

  app.put<{
    Params: { id: string }
    Body: Partial<{
      name: string
      location: string
      streamUrl: string
      maxSpeedKmh: number | null
      active: boolean
      homographyMatrix: number[]
      calibrationPoints: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput
      countingLineA: number
      countingLineB: number
    }>
  }>('/api/cameras/:id', async (req, reply) => {
    try {
      const camera = await db.camera.update({
        where: { id: req.params.id },
        data: req.body,
      })
      return camera
    } catch (err) {
      handlePrismaError(err, reply)
    }
  })

  app.delete<{ Params: { id: string } }>('/api/cameras/:id', async (req, reply) => {
    try {
      await db.camera.delete({ where: { id: req.params.id } })
      reply.code(204).send()
    } catch (err) {
      handlePrismaError(err, reply)
    }
  })

  app.get<{ Params: { id: string } }>('/api/cameras/:id/stats', async (req) => {
    const counts = await db.dailyCount.findMany({
      where: { cameraId: req.params.id },
      orderBy: { date: 'desc' },
      take: 30,
    })
    return counts
  })

  app.post<{
    Params: { id: string }
    Body: {
      pairs: Array<{ px: number; py: number; wx: number; wy: number }>
      maxSpeedKmh?: number | null
      countingLineA?: number
      countingLineB?: number
    }
  }>('/api/cameras/:id/calibration', {
    schema: {
      body: {
        type: 'object',
        required: ['pairs'],
        properties: {
          pairs: {
            type: 'array',
            minItems: 4,
            items: {
              type: 'object',
              required: ['px', 'py', 'wx', 'wy'],
              properties: {
                px: { type: 'number' },
                py: { type: 'number' },
                wx: { type: 'number' },
                wy: { type: 'number' },
              },
            },
          },
          maxSpeedKmh: { type: ['number', 'null'] },
          countingLineA: { type: 'number', minimum: 0, maximum: 1 },
          countingLineB: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const { pairs, maxSpeedKmh, countingLineA, countingLineB } = req.body

    let H: number[]
    try {
      const { computeHomography } = await import('../analysis/homography')
      H = computeHomography(pairs)
    } catch (err) {
      reply.code(400)
      return { error: err instanceof Error ? err.message : 'Homography computation failed' }
    }

    try {
      const camera = await db.camera.update({
        where: { id: req.params.id },
        data: {
          homographyMatrix: H,
          calibrationPoints: pairs as unknown as Prisma.InputJsonValue,
          ...(maxSpeedKmh !== undefined && { maxSpeedKmh }),
          ...(countingLineA !== undefined && { countingLineA }),
          ...(countingLineB !== undefined && { countingLineB }),
        },
      })
      // Restart the streamer so the worker picks up the new calibration
      getManager()?.restartCamera(req.params.id)
      return camera
    } catch (err) {
      return handlePrismaError(err, reply)
    }
  })

  // MJPEG stream — multipart/x-mixed-replace; server annotates every frame server-side
  app.get<{ Params: { id: string } }>('/api/cameras/:id/mjpeg', (req, reply) => {
    const streamer = getStreamer(req.params.id)
    if (!streamer) {
      reply.code(503).send({ error: 'Camera stream not available yet' })
      return
    }

    reply.header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
    reply.header('Cache-Control', 'no-cache, no-store')
    reply.header('Access-Control-Allow-Origin', '*')

    const pass = new PassThrough()

    const onFrame = (jpeg: Buffer) => {
      if (pass.destroyed) return
      // Client is not reading fast enough — drop this frame rather than buffer indefinitely
      if (pass.readableLength > MJPEG_DROP_WATERMARK) return
      const hdr = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`)
      pass.push(Buffer.concat([hdr, jpeg, Buffer.from('\r\n')]))
    }

    streamer.on('frame', onFrame)

    const cleanup = () => {
      streamer.off('frame', onFrame)
      if (!pass.destroyed) pass.destroy()
    }

    req.socket?.once('close', cleanup)
    pass.once('close', cleanup)

    reply.send(pass)
  })

  app.get<{ Params: { id: string } }>('/api/cameras/:id/snapshot', async (req, reply) => {
    const { getLatestFrame } = await import('../socket/server')
    const frame = getLatestFrame(req.params.id)
    if (!frame) {
      reply.code(404)
      return { error: 'No frame available yet — make sure the camera stream is active' }
    }
    return { frame }
  })

  // HLS playlist redirect — resolves the camera page URL to an HLS playlist and
  // redirects the client to the proxied playlist. HLS.js follows the redirect automatically.
  app.get<{ Params: { id: string } }>('/api/cameras/:id/hls', async (req, reply) => {
    const camera = await db.camera.findUnique({ where: { id: req.params.id } })
    if (!camera) { reply.code(404); return }

    let hlsFullUrl = hlsUrlCache.get(camera.id)
    if (!hlsFullUrl) {
      hlsFullUrl = await extractStreamUrl(camera.streamUrl)
      hlsUrlCache.set(camera.id, hlsFullUrl)
    }

    const filename = hlsFullUrl.split('/').pop() ?? 'stream.m3u8'
    reply.redirect(`/api/cameras/${camera.id}/hls/${filename}`, 307)
  })

  // HLS proxy — forwards requests to the upstream HLS server with the required
  // Referer header so hotlink protection doesn't block us. Rewrites relative
  // URLs in playlists so all requests route through here.
  app.get<{ Params: { id: string; '*': string } }>('/api/cameras/:id/hls/*', async (req, reply) => {
    const camera = await db.camera.findUnique({ where: { id: req.params.id } })
    if (!camera) { reply.code(404); return }

    let hlsFullUrl = hlsUrlCache.get(camera.id)
    if (!hlsFullUrl) {
      hlsFullUrl = await extractStreamUrl(camera.streamUrl)
      hlsUrlCache.set(camera.id, hlsFullUrl)
    }
    const hlsBase = hlsFullUrl.substring(0, hlsFullUrl.lastIndexOf('/') + 1)

    const segment = req.params['*']
    const upstreamUrl = hlsBase + segment

    const upstream = await fetch(upstreamUrl, {
      headers: {
        'Referer': 'https://www.verkeerscentrum.be/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    })

    if (!upstream.ok) {
      // If the cached URL is stale (stream rotated), clear it and retry once
      if (upstream.status === 403 || upstream.status === 404) {
        hlsUrlCache.delete(camera.id)
      }
      reply.code(upstream.status)
      return
    }

    const ct = upstream.headers.get('content-type') ?? 'application/octet-stream'
    reply.header('Content-Type', ct)
    reply.header('Cache-Control', 'no-cache')
    reply.header('Access-Control-Allow-Origin', '*')

    if (segment.endsWith('.m3u8')) {
      // Rewrite relative playlist entries to go through our proxy
      const text = await upstream.text()
      const rewritten = text.replace(
        /^((?!#)[^\r\n]+)$/gm,
        (line) => `/api/cameras/${camera.id}/hls/${line.trim()}`,
      )
      return reply.send(rewritten)
    }

    // TS segments — stream directly
    return reply.send(Buffer.from(await upstream.arrayBuffer()))
  })
}
