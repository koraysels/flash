import { Stage, Layer, Image as KonvaImage, Circle, Text } from 'react-konva'
import { Fragment } from 'react'
import useImage from 'use-image'

type Point = { x: number; y: number }

type Props = {
  frameBase64: string
  points: Point[]
  onChange: (points: Point[]) => void
  width?: number
}

export function FramePointPicker({ frameBase64, points, onChange, width = 640 }: Props) {
  const [img] = useImage(`data:image/jpeg;base64,${frameBase64}`)
  const scale = img ? width / img.width : 1
  const height = img ? img.height * scale : width * 0.5625

  function handleClick(e: any) {
    if (e.target === e.target.getStage()) {
      // only clicks on the stage background (not on existing markers)
    }
    const stage = e.target.getStage()
    if (!stage) return
    const pos = stage.getPointerPosition()
    if (!pos) return
    onChange([...points, { x: pos.x / scale, y: pos.y / scale }])
  }

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden cursor-crosshair">
      <Stage width={width} height={height} onClick={handleClick}>
        <Layer>
          {img && <KonvaImage image={img} scaleX={scale} scaleY={scale} />}
          {points.map((p, i) => (
            <Fragment key={i}>
              <Circle
                x={p.x * scale}
                y={p.y * scale}
                radius={8}
                fill="#3b82f6"
                stroke="#fff"
                strokeWidth={2}
                draggable
                onDragEnd={(e) => {
                  const updated = [...points]
                  updated[i] = { x: e.target.x() / scale, y: e.target.y() / scale }
                  onChange(updated)
                }}
              />
              <Text
                x={p.x * scale + 10}
                y={p.y * scale - 6}
                text={String(i + 1)}
                fill="#fff"
                fontSize={12}
              />
            </Fragment>
          ))}
        </Layer>
      </Stage>
    </div>
  )
}
