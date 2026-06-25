import { Stage, Layer, Image as KonvaImage, Line, Circle, Text } from 'react-konva'
import useImage from 'use-image'

type Props = {
  frameBase64: string
  /** Flattened normalised polygon [x1,y1,x2,y2,...] (0-1). */
  polygon: number[]
  onChange: (poly: number[]) => void
  width?: number
}

/** Click the road to drop polygon vertices; drag a vertex to move it. Coords are
 *  normalised so the mask survives any stream-resolution change. */
export function ROIEditor({ frameBase64, polygon, onChange, width = 640 }: Props) {
  const [img] = useImage(`data:image/jpeg;base64,${frameBase64}`)
  const scale = img ? width / img.width : 1
  const height = img ? img.height * scale : width * 0.5625

  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i + 1 < polygon.length; i += 2) pts.push({ x: polygon[i], y: polygon[i + 1] })
  const flat = pts.flatMap((p) => [p.x * width, p.y * height])

  const addPoint = (e: any) => {
    const stage = e.target.getStage()
    if (!stage) return
    const pos = stage.getPointerPosition()
    if (!pos) return
    onChange([...polygon, pos.x / width, pos.y / height])
  }
  const moveVertex = (i: number, dx: number, dy: number) => {
    const next = [...polygon]
    next[i * 2] = dx / width
    next[i * 2 + 1] = dy / height
    onChange(next)
  }

  return (
    <div className="border-2 border-black overflow-hidden cursor-crosshair inline-block">
      <Stage width={width} height={height} onClick={addPoint}>
        <Layer>
          {img && <KonvaImage image={img} scaleX={scale} scaleY={scale} />}
          {pts.length >= 2 && (
            <Line points={flat} closed={pts.length >= 3} stroke="#22c55e" strokeWidth={2} fill="rgba(34,197,94,0.18)" />
          )}
          {pts.map((p, i) => (
            <Circle
              key={i}
              x={p.x * width}
              y={p.y * height}
              radius={6}
              fill="#22c55e"
              stroke="#fff"
              strokeWidth={2}
              draggable
              onClick={(e) => { e.cancelBubble = true }}
              onDragEnd={(e) => moveVertex(i, e.target.x(), e.target.y())}
            />
          ))}
          {pts.length === 0 && (
            <Text x={12} y={12} text="Click the road to add ROI points" fill="#22c55e" fontSize={14} />
          )}
        </Layer>
      </Stage>
    </div>
  )
}
