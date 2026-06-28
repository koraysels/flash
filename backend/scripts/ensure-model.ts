import { createWriteStream, mkdirSync, existsSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { pipeline } from 'stream/promises'

// Self-contained on purpose: this runs at container start via `tsx scripts/...`,
// and tsx's ESM loader can't resolve extensionless TS imports from here, so we do
// NOT import the src registry. Keep the file/url pairs in sync with src/ai/models.ts.
const MODELS: Record<string, { file: string; url: string }> = {
  traffic_detector: {
    file: 'traffic_detector.onnx',
    url: 'https://github.com/koraysels/flash/releases/download/v0.1.0-models/traffic_detector.onnx',
  },
  yolov8s: { file: 'yolov8s.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8s.onnx' },
  yolov8m: { file: 'yolov8m.onnx', url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8m.onnx' },
}

async function main(): Promise<void> {
  const key = process.env.FLASH_MODEL || 'traffic_detector'
  const m = MODELS[key] ?? MODELS.traffic_detector
  const path = join(process.cwd(), 'models', m.file)
  if (existsSync(path)) {
    console.log(`[model] ${key} already present (${path})`)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  console.log(`[model] downloading ${key} from ${m.url}`)
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
