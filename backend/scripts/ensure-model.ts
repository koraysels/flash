import { createWriteStream, mkdirSync, existsSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import { pipeline } from 'stream/promises'
import { activeModel, modelPath } from '../src/ai/models'

// Downloads the model selected by FLASH_MODEL (default traffic_detector) into
// models/ if it isn't already there. Run at container start before the server.
async function main(): Promise<void> {
  const m = activeModel()
  const path = modelPath(m)
  if (existsSync(path)) {
    console.log(`[model] ${m.name} already present (${path})`)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  console.log(`[model] downloading ${m.name} from ${m.url}`)
  const res = await fetch(m.url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${m.url}`)
  const writer = createWriteStream(path)
  try {
    await pipeline(res.body as unknown as NodeJS.ReadableStream, writer)
  } catch (err) {
    try { unlinkSync(path) } catch { /* ignore */ }
    throw err
  }
  console.log(`[model] saved ${path}`)
}

main().catch((err) => {
  console.error('[model] download failed:', err)
  process.exit(1)
})
