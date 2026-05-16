import Fastify, { FastifyServerOptions } from 'fastify'
import cors from '@fastify/cors'
import { cameraRoutes } from './routes/cameras'
import { initSocketServer } from './socket/server'
import { CameraWorkerManager, setManager } from './camera-worker'
import { config } from './config'

export async function buildApp(opts: FastifyServerOptions = {}) {
  const app = Fastify({ logger: true, ...opts })
  await app.register(cors, { origin: true })
  await app.register(cameraRoutes)
  return app
}

if (require.main === module) {
  buildApp().then(async (app) => {
    initSocketServer(app.server)
    const workerManager = new CameraWorkerManager()
    setManager(workerManager)

    await app.listen({ port: config.port, host: '0.0.0.0' })
    console.log(`Server running on port ${config.port}`)
    workerManager.start().catch((err) => {
      console.error('Worker manager failed to start:', err)
    })
  }).catch((err) => {
    console.error('Failed to start server:', err)
    process.exit(1)
  })
}
