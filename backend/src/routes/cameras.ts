import { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db'
import { Prisma } from '@prisma/client'

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
}
