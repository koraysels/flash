import { matrix, multiply, transpose, inv, Matrix } from 'mathjs'

export type PointPair = {
  px: number  // image pixel x
  py: number  // image pixel y
  wx: number  // world meters x
  wy: number  // world meters y
}

export function computeHomography(pairs: PointPair[]): number[] {
  if (pairs.length < 4) throw new Error('At least 4 point pairs required')

  // Normalize input for numerical stability
  const pxMean = pairs.reduce((s, p) => s + p.px, 0) / pairs.length
  const pyMean = pairs.reduce((s, p) => s + p.py, 0) / pairs.length
  const wxMean = pairs.reduce((s, p) => s + p.wx, 0) / pairs.length
  const wyMean = pairs.reduce((s, p) => s + p.wy, 0) / pairs.length

  const pxScale = Math.sqrt(2) / (pairs.reduce((s, p) => s + Math.hypot(p.px - pxMean, p.py - pyMean), 0) / pairs.length || 1)
  const wxScale = Math.sqrt(2) / (pairs.reduce((s, p) => s + Math.hypot(p.wx - wxMean, p.wy - wyMean), 0) / pairs.length || 1)

  if (pxScale > 1e6 || wxScale > 1e6) {
    throw new Error('Homography point cloud is degenerate — points may be coincident or collinear')
  }

  const normPairs = pairs.map(({ px, py, wx, wy }) => ({
    px: (px - pxMean) * pxScale,
    py: (py - pyMean) * pxScale,
    wx: (wx - wxMean) * wxScale,
    wy: (wy - wyMean) * wxScale,
  }))

  // Build 2N×9 matrix A
  const rows: number[][] = []
  for (const { px, py, wx, wy } of normPairs) {
    rows.push([-px, -py, -1,   0,   0,  0, wx * px, wx * py, wx])
    rows.push([  0,   0,  0, -px, -py, -1, wy * px, wy * py, wy])
  }

  // Build the DLT system: we have 2N equations, 9 unknowns.
  // Fix h[8] = 1 and solve the reduced 8-unknown system via least squares.
  // Rearranged: for each row of A, move the last column to the RHS.
  // A * h = 0 with h[8]=1  =>  A[:,0:8] * h[0:8] = -A[:,8]
  const A8: number[][] = rows.map((r) => r.slice(0, 8))
  const b8: number[] = rows.map((r) => -r[8])

  const A8m = matrix(A8)
  const A8t = transpose(A8m) as Matrix
  // Normal equations: (A8^T A8) h = A8^T b
  const AtA8 = multiply(A8t, A8m) as Matrix
  const Atb = multiply(A8t, matrix(b8.map((v) => [v]))) as Matrix
  let AtA8inv: Matrix
  try {
    AtA8inv = inv(AtA8) as Matrix
  } catch {
    throw new Error('Homography system is singular — ensure points are non-collinear and cover the full image area')
  }
  const h8 = multiply(AtA8inv, Atb) as Matrix
  const h8arr = (h8.valueOf() as number[][]).map((r) => r[0])
  const h = [...h8arr, 1]

  // Denormalize: H_orig = T_world^-1 * H_norm * T_img
  // T_img: [[pxScale, 0, -pxMean*pxScale], [0, pxScale, -pyMean*pxScale], [0, 0, 1]]
  // T_world: [[wxScale, 0, -wxMean*wxScale], [0, wxScale, -wyMean*wxScale], [0, 0, 1]]
  const Hn = matrix([[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]])

  const Timg = matrix([
    [pxScale, 0,       -pxMean * pxScale],
    [0,       pxScale, -pyMean * pxScale],
    [0,       0,        1],
  ])

  const TworldInv = matrix([
    [1 / wxScale, 0,           wxMean],
    [0,           1 / wxScale, wyMean],
    [0,           0,           1],
  ])

  const Hdenorm = multiply(TworldInv, multiply(Hn, Timg)) as Matrix
  const flat = (Hdenorm.valueOf() as number[][]).flat()

  // Normalize so H[8] = 1
  const scale = flat[8] !== 0 ? flat[8] : 1
  return flat.map((v) => v / scale)
}

export function applyHomography(H: number[], px: number, py: number): { wx: number; wy: number } {
  const w = H[6] * px + H[7] * py + H[8]
  if (Math.abs(w) < 1e-10) throw new Error('Homography: degenerate projection (w ≈ 0)')
  return {
    wx: (H[0] * px + H[1] * py + H[2]) / w,
    wy: (H[3] * px + H[4] * py + H[5]) / w,
  }
}

export function latlngToMeters(
  originLat: number,
  originLng: number,
  lat: number,
  lng: number,
): { wx: number; wy: number } {
  const R = 6371000
  const dLat = ((lat - originLat) * Math.PI) / 180
  const dLng = ((lng - originLng) * Math.PI) / 180
  return {
    wx: dLng * R * Math.cos((originLat * Math.PI) / 180),
    wy: dLat * R,
  }
}
