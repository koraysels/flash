import Fastify, { FastifyServerOptions } from 'fastify'
import cors from '@fastify/cors'
import { createServer } from 'http'
import { cameraRoutes } from './routes/cameras'
import { initSocketServer } from './socket/server'
import { CameraWorkerManager } from './camera-worker'
import { config } from './config'

export async function buildApp(opts: FastifyServerOptions = {}) {
  const app = Fastify({ logger: true, ...opts })
  await app.register(cors, { origin: true })
  await app.register(cameraRoutes)
  return app
}

if (require.main === module) {
  buildApp().then((app) => {
    const httpServer = createServer(app.server)
    initSocketServer(httpServer)
    const workerManager = new CameraWorkerManager()
    workerManager.start()

    httpServer.listen(config.port, '0.0.0.0', () => {
      console.log(`Server running on port ${config.port}`)
    })
  })
}
