type Props = {
  speedKmh: number | null
  maxSpeedKmh?: number | null
}

export function SpeedDisplay({ speedKmh, maxSpeedKmh }: Props) {
  if (speedKmh === null) return null
  const isFast = maxSpeedKmh != null && speedKmh > maxSpeedKmh

  return (
    <span className={`text-xs font-bold px-2 py-1 rounded ${isFast ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-200'}`}>
      {Math.round(speedKmh)} km/u
    </span>
  )
}
