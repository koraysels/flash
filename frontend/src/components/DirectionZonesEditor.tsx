import { Fragment } from 'react'
import { Stage, Layer, Image as KonvaImage, Line, Circle, Arrow } from 'react-konva'
import useImage from 'use-image'

export type Zone = { polygon: number[]; arrow: number[] }
type Props = {
  frameBase64: string
  zones: Zone[]
  activeIdx: number
  onChange: (zones: Zone[]) => void
  width?: number
}

const COLORS = ['#22c55e', '#3b82f6', '#f59e0b']

/** Paint one polygon per lane (click to add vertices on the active zone) and drag
 *  its arrow to point the travel direction. Coords normalised. */
export function DirectionZonesEditor({ frameBase64, zones, activeIdx, onChange, width = 640 }: Props) {
  const [img] = useImage(`data:image/jpeg;base64,${frameBase64}`)
  const scale = img ? width / img.width : 1
  const height = img ? img.height * scale : width * 0.5625

  const set = (i: number, z: Zone) => { const next = zones.slice(); next[i] = z; onChange(next) }

  const addVertex = (e: any) => {
    if (activeIdx < 0 || !zones[activeIdx]) return
    const pos = e.target.getStage()?.getPointerPosition()
    if (!pos) return
    const z = zones[activeIdx]
    const polygon = [...z.polygon, pos.x / width, pos.y / height]
    let arrow = z.arrow
    if (polygon.length >= 6 && arrow.length !== 4) {
      let cx = 0, cy = 0; const n = polygon.length / 2
      for (let k = 0; k < n; k++) { cx += polygon[k * 2]; cy += polygon[k * 2 + 1] }
      cx /= n; cy /= n
      arrow = [cx, cy, cx, cy - 0.12]   // seed arrow at centroid, pointing up
    }
    set(activeIdx, { polygon, arrow })
  }

  const moveVertex = (zi: number, vi: number, x: number, y: number) => {
    const poly = [...zones[zi].polygon]; poly[vi * 2] = x / width; poly[vi * 2 + 1] = y / height
    set(zi, { ...zones[zi], polygon: poly })
  }
  const moveArrow = (zi: number, end: 0 | 1, x: number, y: number) => {
    const a = [...zones[zi].arrow]; a[end * 2] = x / width; a[end * 2 + 1] = y / height
    set(zi, { ...zones[zi], arrow: a })
  }

  return (
    <div className="border-2 border-black overflow-hidden cursor-crosshair inline-block">
      <Stage width={width} height={height} onClick={addVertex}>
        <Layer>
          {img && <KonvaImage image={img} scaleX={scale} scaleY={scale} />}
          {zones.map((z, zi) => {
            const c = COLORS[zi % COLORS.length]
            const pts: Array<{ x: number; y: number }> = []
            for (let k = 0; k + 1 < z.polygon.length; k += 2) pts.push({ x: z.polygon[k] * width, y: z.polygon[k + 1] * height })
            const active = zi === activeIdx
            return (
              <Fragment key={zi}>
                {pts.length >= 2 && (
                  <Line points={pts.flatMap((p) => [p.x, p.y])} closed={pts.length >= 3}
                    stroke={c} strokeWidth={active ? 2.5 : 1.5} fill={`${c}30`} dash={active ? undefined : [6, 4]} />
                )}
                {pts.map((p, vi) => (
                  <Circle key={vi} x={p.x} y={p.y} radius={5} fill={c} stroke="#fff" strokeWidth={1.5} draggable
                    onClick={(e) => { e.cancelBubble = true }}
                    onDragEnd={(e) => moveVertex(zi, vi, e.target.x(), e.target.y())} />
                ))}
                {z.arrow.length === 4 && (
                  <>
                    <Arrow points={[z.arrow[0] * width, z.arrow[1] * height, z.arrow[2] * width, z.arrow[3] * height]}
                      stroke={c} fill={c} strokeWidth={4} pointerLength={14} pointerWidth={14} />
                    <Circle x={z.arrow[0] * width} y={z.arrow[1] * height} radius={6} fill="#fff" stroke={c} strokeWidth={2} draggable
                      onClick={(e) => { e.cancelBubble = true }} onDragEnd={(e) => moveArrow(zi, 0, e.target.x(), e.target.y())} />
                    <Circle x={z.arrow[2] * width} y={z.arrow[3] * height} radius={7} fill={c} stroke="#fff" strokeWidth={2} draggable
                      onClick={(e) => { e.cancelBubble = true }} onDragEnd={(e) => moveArrow(zi, 1, e.target.x(), e.target.y())} />
                  </>
                )}
              </Fragment>
            )
          })}
        </Layer>
      </Stage>
    </div>
  )
}
