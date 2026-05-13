import { createWriteStream, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'

const MODEL_URL = 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx'
const MODEL_PATH = join(__dirname, '../models/yolov8n.onnx')

async function download() {
  if (existsSync(MODEL_PATH)) {
    console.log('Model already exists, skipping download')
    return
  }

  mkdirSync(join(__dirname, '../models'), { recursive: true })
  console.log('Downloading YOLOv8n ONNX model...')

  const res = await fetch(MODEL_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(MODEL_PATH))
  console.log('Model downloaded to', MODEL_PATH)
}

download().catch(console.error)
