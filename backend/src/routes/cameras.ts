import { FastifyInstance, FastifyReply } from 'fastify'
import { PassThrough } from 'stream'
import { readFile } from 'fs/promises'
import { join, basename } from 'path'
import { db } from '../db'
import { Prisma } from '@prisma/client'
import { extractStreamUrl } from '../stream/extractor'
import { getStreamer, getManager } from '../camera-worker'
import type { TrackerConfig } from '../ai/tracker'
import { requireAuth } from '../auth'
import { publishSpeed, mqttConnected, HLS_LATENCY_S, type SpeedEvent } from '../mqtt/publisher'

// Cache resolved HLS URLs so we don't re-extract on every proxy request
const hlsUrlCache = new Map<string, string>()

// Fixed kiosk slots (match the Pi hostnames). One camera per slot.
const DISPLAY_SLOTS = ['FLASH-PI-01', 'FLASH-PI-02', 'FLASH-PI-03']

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
  app.get('/api/cameras', { logLevel: 'warn' }, async () => {
    return db.camera.findMany({ orderBy: { createdAt: 'asc' } })
  })

  app.post<{
    Body: { name: string; location: string; streamUrl: string; maxSpeedKmh?: number }
  }>('/api/cameras', { preHandler: requireAuth }, async (req, reply) => {
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
      trapSpeedEnabled: boolean
    }>
  }>('/api/cameras/:id', { preHandler: requireAuth }, async (req, reply) => {
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

  app.delete<{ Params: { id: string } }>('/api/cameras/:id', { preHandler: requireAuth }, async (req, reply) => {
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
      frameWidth?: number
      frameHeight?: number
      maxSpeedKmh?: number | null
      countingLineA?: number
      countingLineB?: number
      countingLineAPoints?: number[]
      countingLineBPoints?: number[]
      trapSpeedEnabled?: boolean
    }
  }>('/api/cameras/:id/calibration', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        required: ['pairs'],
        properties: {
          pairs: {
            type: 'array',
            minItems: 0,
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
          frameWidth: { type: 'number', minimum: 1 },
          frameHeight: { type: 'number', minimum: 1 },
          maxSpeedKmh: { type: ['number', 'null'] },
          countingLineA: { type: 'number', minimum: 0, maximum: 1 },
          countingLineB: { type: 'number', minimum: 0, maximum: 1 },
          countingLineAPoints: { type: 'array', items: { type: 'number' } },
          countingLineBPoints: { type: 'array', items: { type: 'number' } },
          trapSpeedEnabled: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { pairs, frameWidth, frameHeight, maxSpeedKmh, countingLineA, countingLineB, countingLineAPoints, countingLineBPoints, trapSpeedEnabled } = req.body

    // Homography only computed when at least 4 point pairs are provided
    let H: number[] | undefined
    let calibrationError: import('../analysis/homography').ReprojectionError | undefined
    if (pairs.length >= 4) {
      try {
        const { computeHomography, reprojectionError } = await import('../analysis/homography')
        H = computeHomography(pairs)
        // Residual per calibration point in meters — surfaced so bad point
        // picks are visible instead of silently corrupting all speeds
        calibrationError = reprojectionError(H, pairs)
      } catch (err) {
        reply.code(400)
        return { error: err instanceof Error ? err.message : 'Homography computation failed' }
      }
    }

    try {
      const camera = await db.camera.update({
        where: { id: req.params.id },
        data: {
          ...(H !== undefined && { homographyMatrix: H }),
          ...(pairs.length >= 4 && { calibrationPoints: pairs as unknown as Prisma.InputJsonValue }),
          ...(pairs.length >= 4 && frameWidth !== undefined && { calibrationWidth: Math.round(frameWidth) }),
          ...(pairs.length >= 4 && frameHeight !== undefined && { calibrationHeight: Math.round(frameHeight) }),
          ...(maxSpeedKmh !== undefined && { maxSpeedKmh }),
          ...(countingLineA !== undefined && { countingLineA }),
          ...(countingLineB !== undefined && { countingLineB }),
          ...(countingLineAPoints !== undefined && { countingLineAPoints }),
          ...(countingLineBPoints !== undefined && { countingLineBPoints }),
          ...(trapSpeedEnabled !== undefined && { trapSpeedEnabled }),
        },
      })
      // Restart the streamer so the worker picks up the new calibration
      getManager()?.restartCamera(req.params.id)
      return { ...camera, calibrationError }
    } catch (err) {
      return handlePrismaError(err, reply)
    }
  })

  // MJPEG stream — multipart/x-mixed-replace; server annotates every frame server-side
  app.post<{ Params: { id: string }; Body: Partial<TrackerConfig> }>('/api/cameras/:id/tracking-config', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const camera = await db.camera.update({
        where: { id: req.params.id },
        data: { trackingConfig: req.body as Prisma.InputJsonValue },
      })
      getManager()?.restartCamera(req.params.id)
      return camera
    } catch (err) {
      handlePrismaError(err, reply)
    }
  })

  app.post<{ Params: { id: string } }>('/api/cameras/:id/reset-counts', { preHandler: requireAuth }, (req, reply) => {
    const streamer = getStreamer(req.params.id)
    if (!streamer) { reply.code(404).send({ error: 'Camera not found or not running' }); return }
    streamer.resetDailyCounts()
    reply.code(204).send()
  })

  // Manual MQTT test — publishes a fake speeder so the Art-Net strobe can be
  // verified end-to-end from the dashboard. Optional body { cameraId } uses that
  // camera's feed/location/limit; otherwise generic test values.
  app.post<{ Body: { cameraId?: string } }>('/api/mqtt/test', { preHandler: requireAuth }, async (req, reply) => {
    let feed = 'test', location = 'MQTT Test', maxSpeedKmh: number | null = 120
    if (req.body?.cameraId) {
      const cam = await db.camera.findUnique({ where: { id: req.body.cameraId } })
      if (cam) { feed = cam.id; location = cam.location; maxSpeedKmh = cam.maxSpeedKmh }
    }
    const event: SpeedEvent = {
      feed,
      location,
      direction: 'AB',
      trackId: Math.floor(Math.random() * 1_000_000),  // random so the strobe never dedupes a test
      speedKmh: (maxSpeedKmh ?? 120) + 30,              // always over the limit → guaranteed flash
      maxSpeedKmh,
      ts: Date.now() / 1000,
      hls_latency_s: HLS_LATENCY_S,
    }
    publishSpeed(event)
    return reply.send({ ok: true, connected: mqttConnected(), payload: event })
  })

  // Resolve a kiosk slug -> cameraId. Accepts a fixed slot name (FLASH-PI-01/02/03,
  // case-insensitive) or a raw camera id. Public — the Pi kiosk has no login.
  app.get<{ Params: { slug: string } }>('/api/display/:slug', async (req, reply) => {
    const slug = req.params.slug
    const bySlot = await db.camera.findFirst({ where: { displaySlot: slug.toUpperCase() } })
    if (bySlot) return reply.send({ cameraId: bySlot.id, slot: bySlot.displaySlot })
    const byId = await db.camera.findUnique({ where: { id: slug } })
    if (byId) return reply.send({ cameraId: byId.id, slot: byId.displaySlot })
    return reply.code(404).send({ error: 'Unknown display slug' })
  })

  // Assign which camera a fixed kiosk slot shows (slot is unique → frees it from
  // any other camera first). slot null clears it.
  app.post<{ Params: { id: string }; Body: { slot: string | null } }>(
    '/api/cameras/:id/display-slot', { preHandler: requireAuth }, async (req, reply) => {
      const { id } = req.params
      let slot = req.body?.slot ?? null
      if (slot !== null) {
        slot = String(slot).toUpperCase()
        if (!DISPLAY_SLOTS.includes(slot)) { reply.code(400).send({ error: 'Invalid slot' }); return }
      }
      await db.$transaction(async (tx) => {
        if (slot !== null) {
          await tx.camera.updateMany({ where: { displaySlot: slot, NOT: { id } }, data: { displaySlot: null } })
        }
        await tx.camera.update({ where: { id }, data: { displaySlot: slot } })
      })
      return reply.send({ ok: true, slot })
    })

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

    const onFrame = (jpeg: Buffer, seq: number) => {
      if (pass.destroyed) return
      // Client is not reading fast enough — drop this frame rather than buffer indefinitely
      if (pass.readableLength > MJPEG_DROP_WATERMARK) return
      const hdr = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nX-Frame-Seq: ${seq}\r\nContent-Length: ${jpeg.length}\r\n\r\n`)
      pass.push(Buffer.concat([hdr, jpeg]))
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

  // Annotated HLS — serves on-demand H.264 HLS from the AnnotatedEncoder.
  // Playlist: starts the encoder on demand, waits briefly for ffmpeg to write the first segment.
  app.get<{ Params: { id: string } }>('/api/cameras/:id/annotated/index.m3u8', async (req, reply) => {
    const streamer = getStreamer(req.params.id)
    if (!streamer) { reply.code(404).send({ error: 'Camera not running' }); return }
    streamer.enableAnnotated()
    streamer.touchAnnotated()
    const playlist = streamer.annotatedPlaylistPath()
    if (!playlist) { reply.code(503).send({ error: 'Encoder starting' }); return }
    // Wait up to ~3s for ffmpeg to write the first playlist
    for (let i = 0; i < 30; i++) {
      try {
        const buf = await readFile(playlist)
        reply.header('Content-Type', 'application/vnd.apple.mpegurl')
        reply.header('Cache-Control', 'no-cache')
        reply.send(buf)
        return
      } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    reply.code(503).send({ error: 'Encoder warming up' })
  })

  // Annotated HLS segments — serves .ts segment files produced by the encoder.
  app.get<{ Params: { id: string; seg: string } }>('/api/cameras/:id/annotated/:seg', async (req, reply) => {
    const streamer = getStreamer(req.params.id)
    if (!streamer) { reply.code(404).send({ error: 'Camera not running' }); return }
    streamer.touchAnnotated()
    const playlist = streamer.annotatedPlaylistPath()
    if (!playlist) { reply.code(404).send(); return }
    const dir = playlist.substring(0, playlist.lastIndexOf('/'))
    const safe = basename(req.params.seg)  // prevent path traversal
    try {
      const buf = await readFile(join(dir, safe))
      reply.header('Content-Type', safe.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t')
      reply.header('Cache-Control', 'no-cache')
      reply.send(buf)
    } catch { reply.code(404).send() }
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
