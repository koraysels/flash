import * as ort from 'onnxruntime-node'

export type DetectionResult = {
  x1: number
  y1: number
  x2: number
  y2: number
  confidence: number
  class: string
}

// UA-DETRAC class indices for traffic_detector.onnx
const VEHICLE_CLASSES: Record<number, string> = {
  0: 'truck',
  1: 'car',
  2: 'truck',
  3: 'van',
}

const INPUT_SIZE = 640
const CONF_THRESHOLD = 0.35   // lower than default: traffic cams have small/distant vehicles
const IOU_THRESHOLD = 0.4     // slightly tighter than default: side-by-side vehicles in lanes
const NUM_CLASSES = 4
const NUM_DETECTIONS = 8400

export class Detector {
  private session: ort.InferenceSession | null = null

  constructor(private readonly modelPath: string) {}

  async init(): Promise<void> {
    this.session = await ort.InferenceSession.create(this.modelPath, {
      // CoreML uses the Neural Engine / GPU on Apple Silicon — falls back to CPU gracefully
      executionProviders: ['coreml', 'cpu'],
    })
  }

  async dispose(): Promise<void> {
    if (this.session) {
      ;(this.session as unknown as { dispose?: () => void }).dispose?.()
      this.session = null
    }
  }

  /**
   * Detect vehicles in a pre-letterboxed 640×640 RGBA frame.
   * padX/padY are the pixel offsets added during letterboxing, scale is the
   * uniform scale factor applied to the source image before padding.
   */
  async detect(
    rgba640: Uint8ClampedArray,
    padX: number,
    padY: number,
    scale: number,
    srcWidth: number,
    srcHeight: number,
  ): Promise<DetectionResult[]> {
    if (!this.session) throw new Error('Detector not initialized')

    const inputTensor = this.preprocess(rgba640)
    const inputName = this.session.inputNames[0]
    const results = await this.session.run({ [inputName]: inputTensor })
    const output = results['output0'].data as Float32Array

    return this.postprocess(output, padX, padY, scale, srcWidth, srcHeight)
  }

  // Convert 640×640 RGBA → CHW Float32 tensor, normalised to [0, 1]
  private preprocess(rgba: Uint8ClampedArray): ort.Tensor {
    const n = INPUT_SIZE * INPUT_SIZE
    const floatData = new Float32Array(3 * n)
    for (let i = 0; i < n; i++) {
      floatData[i]         = rgba[i * 4]     / 255  // R
      floatData[n + i]     = rgba[i * 4 + 1] / 255  // G
      floatData[2 * n + i] = rgba[i * 4 + 2] / 255  // B
    }
    return new ort.Tensor('float32', floatData, [1, 3, INPUT_SIZE, INPUT_SIZE])
  }

  private postprocess(
    output: Float32Array,
    padX: number,
    padY: number,
    scale: number,
    srcWidth: number,
    srcHeight: number,
  ): DetectionResult[] {
    // YOLOv8 output: [1, 84, 8400] in transposed layout
    // Rows 0-3: cx, cy, w, h in letterboxed 640×640 pixel space
    // Rows 4-83: class scores
    const results: DetectionResult[] = []

    for (let i = 0; i < NUM_DETECTIONS; i++) {
      let maxScore = 0
      let maxClassIdx = -1
      for (let c = 0; c < NUM_CLASSES; c++) {
        const score = output[(4 + c) * NUM_DETECTIONS + i]
        if (score > maxScore) { maxScore = score; maxClassIdx = c }
      }

      if (maxScore < CONF_THRESHOLD) continue
      if (!VEHICLE_CLASSES[maxClassIdx]) continue

      // Un-letterbox: subtract padding, divide by uniform scale
      const cx640 = output[0 * NUM_DETECTIONS + i]
      const cy640 = output[1 * NUM_DETECTIONS + i]
      const w640  = output[2 * NUM_DETECTIONS + i]
      const h640  = output[3 * NUM_DETECTIONS + i]

      const cx = (cx640 - padX) / scale
      const cy = (cy640 - padY) / scale
      const w  = w640 / scale
      const h  = h640 / scale

      results.push({
        x1: Math.max(0, Math.min(srcWidth,  cx - w / 2)),
        y1: Math.max(0, Math.min(srcHeight, cy - h / 2)),
        x2: Math.max(0, Math.min(srcWidth,  cx + w / 2)),
        y2: Math.max(0, Math.min(srcHeight, cy + h / 2)),
        confidence: maxScore,
        class: VEHICLE_CLASSES[maxClassIdx],
      })
    }

    return nms(results, IOU_THRESHOLD)
  }
}

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
