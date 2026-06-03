import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/index'
import { db } from '../../src/db'
import jwt from 'jsonwebtoken'

describe('Auth routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    app = await buildApp({ logger: false })
  })

  afterAll(async () => {
    await app.close()
    await db.$disconnect()
  })

  it('POST /api/auth returns 401 for wrong PIN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth',
      payload: { pin: 'wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('Invalid PIN')
  })

  it('POST /api/auth returns JWT for correct PIN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth',
      payload: { pin: process.env.FLASH_PIN },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.token).toBe('string')
    expect(body.token.split('.').length).toBe(3)
  })

  it('POST /api/auth token is verifiable with JWT_SECRET', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth',
      payload: { pin: process.env.FLASH_PIN },
    })
    const { token } = res.json()
    expect(() => jwt.verify(token, process.env.JWT_SECRET!)).not.toThrow()
  })

  it('POST /api/cameras returns 401 without token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cameras',
      payload: { name: 'Test', location: 'Test', streamUrl: 'http://test' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('POST /api/cameras returns 401 with invalid token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cameras',
      headers: { Authorization: 'Bearer not.a.token' },
      payload: { name: 'Test', location: 'Test', streamUrl: 'http://test' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('DELETE /api/cameras/:id returns 401 without token', async () => {
    const cam = await db.camera.create({
      data: { name: 'Auth Test', location: 'Test', streamUrl: 'http://test' },
    })
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/cameras/${cam.id}`,
    })
    expect(res.statusCode).toBe(401)
    await db.camera.delete({ where: { id: cam.id } })
  })
})
