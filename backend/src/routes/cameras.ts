import { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { db } from '../db'

export async function cameraRoutes(app: FastifyInstance) {
  app.get('/api/cameras', async () => {
    return db.camera.findMany({ orderBy: { createdAt: 'asc' } })
  })

  app.post<{
    Body: { name: string; location: string; streamUrl: string; maxSpeedKmh?: number }
  }>('/api/cameras', async (req, reply) => {
    const camera = await db.camera.create({ data: req.body })
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
    const camera = await db.camera.update({
      where: { id: req.params.id },
      data: req.body,
    })
    return camera
  })

  app.delete<{ Params: { id: string } }>('/api/cameras/:id', async (req, reply) => {
    await db.camera.delete({ where: { id: req.params.id } })
    reply.code(204)
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
