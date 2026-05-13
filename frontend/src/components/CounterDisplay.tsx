type Props = {
  counts: { AB: number; BA: number; speeders: number }
  maxSpeedKmh?: number | null
}

export function CounterDisplay({ counts, maxSpeedKmh }: Props) {
  return (
    <div className="flex gap-4 text-sm mt-2">
      <div className="flex-1 bg-gray-800 rounded-lg p-2 text-center">
        <p className="text-gray-400 text-xs">A→B</p>
        <p className="text-xl font-bold tabular-nums">{counts.AB}</p>
      </div>
      <div className="flex-1 bg-gray-800 rounded-lg p-2 text-center">
        <p className="text-gray-400 text-xs">B→A</p>
        <p className="text-xl font-bold tabular-nums">{counts.BA}</p>
      </div>
      {maxSpeedKmh != null && (
        <div className="flex-1 bg-red-950 border border-red-900 rounded-lg p-2 text-center">
          <p className="text-red-400 text-xs">⚡ &gt;{maxSpeedKmh} km/u</p>
          <p className="text-xl font-bold tabular-nums text-red-400">{counts.speeders}</p>
        </div>
      )}
    </div>
  )
}
