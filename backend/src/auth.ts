import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { pin: string } }>('/api/auth', async (req, reply) => {
    const { pin } = req.body ?? {}
    if (!pin || pin !== process.env.FLASH_PIN) {
      reply.code(401).send({ error: 'Invalid PIN' })
      return
    }
    const token = jwt.sign({}, process.env.JWT_SECRET!, { expiresIn: '30d' })
    return { token }
  })
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized' })
    return
  }
  try {
    jwt.verify(auth.slice(7), process.env.JWT_SECRET!)
  } catch {
    reply.code(401).send({ error: 'Unauthorized' })
    return
  }
}
