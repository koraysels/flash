import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDailyHistory, type DailyCountRow } from '../lib/api'
import { Spinner } from '../components/ui/Spinner'

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('nl-BE', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' })
}

export default function History() {
  const [days, setDays] = useState(14)
  const { data, isLoading, error } = useQuery({ queryKey: ['daily', days], queryFn: () => getDailyHistory(days) })

  const byDate = new Map<string, DailyCountRow[]>()
  for (const r of data ?? []) {
    const key = r.date.slice(0, 10)
    if (!byDate.has(key)) byDate.set(key, [])
    byDate.get(key)!.push(r)
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <p className="text-xs font-bold uppercase tracking-widest text-stone-400">Historiek — dagtellingen</p>
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value))}
          className="text-xs uppercase tracking-wide border-2 border-black px-2 py-1 bg-white focus:outline-none"
        >
          {[7, 14, 30, 90].map((d) => <option key={d} value={d}>{d} dagen</option>)}
        </select>
      </div>

      {isLoading && <div className="flex items-center gap-2 text-xs text-stone-400 uppercase tracking-widest"><Spinner /> Laden…</div>}
      {error && <div className="text-xs text-danger uppercase tracking-widest">Historiek laden mislukt.</div>}
      {data && data.length === 0 && (
        <div className="border-2 border-black px-4 py-6 text-center text-xs text-stone-400 uppercase tracking-widest">
          Nog geen dagtellingen — deze vullen zich vanaf vandaag.
        </div>
      )}

      <div className="space-y-5">
        {[...byDate.entries()].map(([date, rows]) => {
          const tot = rows.reduce((a, r) => ({ AB: a.AB + r.directionAB, BA: a.BA + r.directionBA, sp: a.sp + r.speeders }), { AB: 0, BA: 0, sp: 0 })
          return (
            <div key={date} className="border-2 border-black">
              <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b-2 border-black">
                <span className="text-xs font-bold uppercase tracking-widest">{fmtDate(date)}</span>
                <span className="text-xs tabular-nums text-stone-500">
                  A→B {tot.AB} · B→A {tot.BA} · <span className="text-danger font-bold">{tot.sp} flits</span>
                </span>
              </div>
              <div className="flex items-center px-3 py-1 border-b border-stone-200 text-[10px] uppercase tracking-widest text-stone-400">
                <span className="flex-1">Camera</span>
                <span className="w-16 text-right">A→B</span>
                <span className="w-16 text-right">B→A</span>
                <span className="w-16 text-right">Flits</span>
              </div>
              {rows.map((r) => (
                <div key={r.id} className="flex items-center px-3 py-1.5 border-b border-stone-100 last:border-b-0 text-xs">
                  <span className="flex-1 truncate uppercase tracking-wide">{r.camera?.name ?? r.cameraId}</span>
                  <span className="w-16 text-right tabular-nums">{r.directionAB}</span>
                  <span className="w-16 text-right tabular-nums">{r.directionBA}</span>
                  <span className="w-16 text-right tabular-nums font-bold text-danger">{r.speeders}</span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
