import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { buildApp } from '../../src/index'
import { db } from '../../src/db'

describe('Camera routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    app = await buildApp({ logger: false })
  })

  afterAll(async () => {
    await app.close()
    await db.$disconnect()
  })

  beforeEach(async () => {
    await db.camera.deleteMany()
  })

  it('GET /api/cameras returns empty array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/cameras' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('POST /api/cameras creates a camera', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cameras',
      payload: { name: 'Test Cam', location: 'Gent', streamUrl: 'https://example.com/stream' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.name).toBe('Test Cam')
    expect(body.id).toBeDefined()
  })

  it('POST /api/cameras returns 400 if name is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cameras',
      payload: { location: 'Gent', streamUrl: 'https://example.com' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('DELETE /api/cameras/:id removes camera', async () => {
    const camera = await db.camera.create({
      data: { name: 'Del Cam', location: 'Brussel', streamUrl: 'https://example.com' },
    })
    const res = await app.inject({ method: 'DELETE', url: `/api/cameras/${camera.id}` })
    expect(res.statusCode).toBe(204)
    const found = await db.camera.findUnique({ where: { id: camera.id } })
    expect(found).toBeNull()
  })

  it('DELETE /api/cameras/:id returns 404 for non-existent id', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/cameras/nonexistent-id' })
    expect(res.statusCode).toBe(404)
  })

  it('PUT /api/cameras/:id updates maxSpeedKmh', async () => {
    const camera = await db.camera.create({
      data: { name: 'Speed Cam', location: 'Antwerpen', streamUrl: 'https://example.com' },
    })
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cameras/${camera.id}`,
      payload: { maxSpeedKmh: 50 },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).maxSpeedKmh).toBe(50)
  })

  describe('POST /api/cameras/:id/calibration', () => {
    it('returns 400 if fewer than 4 pairs', async () => {
      const cam = await db.camera.create({ data: { name: 'Cal Test', location: 'X', streamUrl: 'http://x' } })

      const res = await app.inject({
        method: 'POST',
        url: `/api/cameras/${cam.id}/calibration`,
        payload: { pairs: [{ px: 0, py: 0, wx: 0, wy: 0 }] },
      })
      expect(res.statusCode).toBe(400)
      await db.camera.delete({ where: { id: cam.id } })
    })

    it('saves calibration and returns updated camera', async () => {
      const cam = await db.camera.create({ data: { name: 'Cal Test 2', location: 'Y', streamUrl: 'http://y' } })

      const pairs = [
        { px: 0,   py: 0,   wx: 0,  wy: 0  },
        { px: 100, py: 0,   wx: 10, wy: 0  },
        { px: 100, py: 100, wx: 10, wy: 10 },
        { px: 0,   py: 100, wx: 0,  wy: 10 },
      ]
      const res = await app.inject({
        method: 'POST',
        url: `/api/cameras/${cam.id}/calibration`,
        payload: { pairs, maxSpeedKmh: 50 },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.homographyMatrix).toHaveLength(9)
      expect(body.maxSpeedKmh).toBe(50)
      await db.camera.delete({ where: { id: cam.id } })
    })
  })

  describe('GET /api/cameras/:id/snapshot', () => {
    it('returns 404 when no frame available', async () => {
      const cam = await db.camera.create({ data: { name: 'Snap Test', location: 'Z', streamUrl: 'http://z' } })
      const res = await app.inject({ method: 'GET', url: `/api/cameras/${cam.id}/snapshot` })
      expect(res.statusCode).toBe(404)
      await db.camera.delete({ where: { id: cam.id } })
    })
  })
})
