import Fastify from 'fastify'
import cors from '@fastify/cors'
import { cameraRoutes } from './routes/cameras'
import { config } from './config'

export async function buildApp() {
  const app = Fastify({ logger: true })
  await app.register(cors, { origin: true })
  await app.register(cameraRoutes)
  return app
}

if (require.main === module) {
  buildApp().then((app) => {
    app.listen({ port: config.port, host: '0.0.0.0' }, (err) => {
      if (err) process.exit(1)
    })
  })
}
