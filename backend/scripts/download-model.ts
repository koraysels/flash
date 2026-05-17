import { createWriteStream, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'

const MODEL_URL = 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx'
const MODEL_PATH = join(__dirname, '../models/yolov8s.onnx')

async function download() {
  if (existsSync(MODEL_PATH)) {
    console.log('Model already exists, skipping download')
    return
  }

  mkdirSync(join(__dirname, '../models'), { recursive: true })
  console.log('Downloading YOLOv8n ONNX model...')

  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const writer = createWriteStream(MODEL_PATH)
  try {
    await pipeline(res.body as unknown as NodeJS.ReadableStream, writer)
  } catch (err) {
    // Clean up partial file so next run retries
    try { unlinkSync(MODEL_PATH) } catch {}
    throw err
  }
  console.log('Model downloaded to', MODEL_PATH)
}

download().catch(err => {
  console.error(err)
  process.exit(1)
})
