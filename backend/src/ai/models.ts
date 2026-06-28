import { join } from 'path'

// Selectable detection models. Switch with the FLASH_MODEL env var; default is the
// custom UA-DETRAC traffic_detector. Each profile lists ONLY the classes we want to
// track (truck / van / car) — other detections (bus, motorcycle, person, …) are
// dropped by index, so a generic COCO model still only yields the vehicle types we
// care about. COCO has no separate "van" class, so on yolov8* vans surface as
// car/truck; the custom model keeps a real "van" class.
export type ModelProfile = {
  name: string
  file: string
  numClasses: number
  classMap: Record<number, string>
  url: string
}

const REGISTRY: Record<string, ModelProfile> = {
  traffic_detector: {
    name: 'traffic_detector',
    file: 'traffic_detector.onnx',
    numClasses: 4,
    classMap: { 0: 'truck', 1: 'car', 2: 'truck', 3: 'van' },
    url: 'https://github.com/koraysels/flash/releases/download/v0.1.0-models/traffic_detector.onnx',
  },
  yolov8s: {
    name: 'yolov8s',
    file: 'yolov8s.onnx',
    numClasses: 80,
    classMap: { 2: 'car', 7: 'truck' }, // COCO: car=2, truck=7 (bus/motorcycle excluded on purpose)
    url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8s.onnx',
  },
  yolov8m: {
    name: 'yolov8m',
    file: 'yolov8m.onnx',
    numClasses: 80,
    classMap: { 2: 'car', 7: 'truck' },
    url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8m.onnx',
  },
}

export function activeModel(): ModelProfile {
  const key = process.env.FLASH_MODEL || 'traffic_detector'
  return REGISTRY[key] ?? REGISTRY.traffic_detector
}

export function modelPath(p: ModelProfile = activeModel()): string {
  return join(process.cwd(), 'models', p.file)
}
