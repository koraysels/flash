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
})
