import * as ort from 'onnxruntime-node'

export type DetectionResult = {
  x1: number
  y1: number
  x2: number
  y2: number
  confidence: number
  class: string
}

// COCO class indices: 2=car, 3=motorcycle, 5=bus, 7=truck
const VEHICLE_CLASSES: Record<number, string> = {
  2: 'car',
  3: 'motorcycle',
  5: 'bus',
  7: 'truck',
}

const INPUT_SIZE = 640
const CONF_THRESHOLD = 0.4
const IOU_THRESHOLD = 0.45
const NUM_CLASSES = 80
const NUM_DETECTIONS = 8400

export class Detector {
  private session: ort.InferenceSession | null = null

  constructor(private readonly modelPath: string) {}

  async init(): Promise<void> {
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
    })
  }

  async detect(rgbBuffer: Buffer, srcWidth: number, srcHeight: number): Promise<DetectionResult[]> {
    if (!this.session) throw new Error('Detector not initialized')

    const inputTensor = this.preprocess(rgbBuffer, srcWidth, srcHeight)
    const inputName = this.session.inputNames[0]
    const results = await this.session.run({ [inputName]: inputTensor })
    const output = results['output0'].data as Float32Array

    return this.postprocess(output, srcWidth, srcHeight)
  }

  private preprocess(rgbBuffer: Buffer, srcWidth: number, srcHeight: number): ort.Tensor {
    const floatData = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE)
    const scaleX = srcWidth / INPUT_SIZE
    const scaleY = srcHeight / INPUT_SIZE

    for (let y = 0; y < INPUT_SIZE; y++) {
      for (let x = 0; x < INPUT_SIZE; x++) {
        const srcX = Math.min(Math.floor(x * scaleX), srcWidth - 1)
        const srcY = Math.min(Math.floor(y * scaleY), srcHeight - 1)
        const srcIdx = (srcY * srcWidth + srcX) * 3
        floatData[y * INPUT_SIZE + x] = rgbBuffer[srcIdx] / 255           // R channel
        floatData[INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = rgbBuffer[srcIdx + 1] / 255   // G
        floatData[2 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = rgbBuffer[srcIdx + 2] / 255 // B
      }
    }

    return new ort.Tensor('float32', floatData, [1, 3, INPUT_SIZE, INPUT_SIZE])
  }

  private postprocess(output: Float32Array, srcWidth: number, srcHeight: number): DetectionResult[] {
    // YOLOv8n output shape: [1, 84, 8400] — transposed layout
    // output[row * NUM_DETECTIONS + detIdx]
    // Rows 0-3: cx, cy, w, h
    // Rows 4-83: class scores (no separate objectness)
    const scaleX = srcWidth / INPUT_SIZE
    const scaleY = srcHeight / INPUT_SIZE
    const results: DetectionResult[] = []

    for (let i = 0; i < NUM_DETECTIONS; i++) {
      // Find best class
      let maxScore = 0
      let maxClassIdx = -1
      for (let c = 0; c < NUM_CLASSES; c++) {
        const score = output[(4 + c) * NUM_DETECTIONS + i]
        if (score > maxScore) {
          maxScore = score
          maxClassIdx = c
        }
      }

      if (maxScore < CONF_THRESHOLD) continue
      if (!VEHICLE_CLASSES[maxClassIdx]) continue

      const cx = output[0 * NUM_DETECTIONS + i] * scaleX
      const cy = output[1 * NUM_DETECTIONS + i] * scaleY
      const w = output[2 * NUM_DETECTIONS + i] * scaleX
      const h = output[3 * NUM_DETECTIONS + i] * scaleY

      results.push({
        x1: Math.max(0, cx - w / 2),
        y1: Math.max(0, cy - h / 2),
        x2: Math.min(srcWidth, cx + w / 2),
        y2: Math.min(srcHeight, cy + h / 2),
        confidence: maxScore,
        class: VEHICLE_CLASSES[maxClassIdx],
      })
    }

    return nms(results, IOU_THRESHOLD)
  }
}

// Class-agnostic NMS: one vehicle per spatial location (intentional for counting)
function nms(boxes: DetectionResult[], iouThreshold: number): DetectionResult[] {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence)
  const kept: DetectionResult[] = []
  for (const box of sorted) {
    if (!kept.some((k) => iou(box, k) > iouThreshold)) kept.push(box)
  }
  return kept
}

function iou(a: DetectionResult, b: DetectionResult): number {
  const ix1 = Math.max(a.x1, b.x1)
  const iy1 = Math.max(a.y1, b.y1)
  const ix2 = Math.min(a.x2, b.x2)
  const iy2 = Math.min(a.y2, b.y2)
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
  const aArea = (a.x2 - a.x1) * (a.y2 - a.y1)
  const bArea = (b.x2 - b.x1) * (b.y2 - b.y1)
  return inter / (aArea + bArea - inter)
}
